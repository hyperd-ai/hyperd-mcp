"""
LangChain agent that uses hyperd Risk Sentinel as a tool.

Wraps the bundle call from risk_sentinel.py as a LangChain `tool`, then
hands it to a Claude / GPT agent that decides when to invoke it.

Run:

    pip install -r requirements.txt
    pip install langchain langchain-anthropic   # or langchain-openai

    export HYPERD_WALLET_PRIVATE_KEY=0x...
    export ANTHROPIC_API_KEY=sk-...               # or OPENAI_API_KEY

    python agent_langchain.py "Is wallet 0xd8dA... in danger of liquidation?"

This example deliberately uses LangChain's modern `tool` decorator +
StructuredTool pattern so it works with both legacy AgentExecutor and
the newer LangGraph `create_agent`. Pick the import path your stack
already uses.
"""
from __future__ import annotations

import os
import sys

from eth_account import Account
from pydantic import BaseModel, Field

from risk_sentinel import run_risk_sentinel


class RiskInput(BaseModel):
    """Args schema for the risk-sentinel tool."""

    target_wallet: str = Field(
        description="The 0x EVM wallet address to analyze for risk.",
    )


def make_risk_tool(account: Account):
    """Build a LangChain Tool that runs the bundle for a given wallet.

    Lazy-imports langchain_core so this file is importable even if
    LangChain isn't installed (the import error fires only when you
    actually call this function).
    """
    from langchain_core.tools import StructuredTool

    def _run(target_wallet: str) -> str:
        result = run_risk_sentinel(account, target_wallet)
        # Compress the bundle envelope into a model-friendly string.
        lines = [
            f"Risk profile for {target_wallet} (cost: ${result.get('bundle_price_usd', 0):.3f}):",
        ]
        for sub in result.get("results", []):
            rid = sub.get("id")
            status = sub.get("status")
            body = sub.get("body") or {}
            if status != 200:
                lines.append(f"  - {rid}: ERROR ({(body or {}).get('error', 'unknown')})")
                continue
            if rid == "liquidation":
                lines.append(
                    f"  - liquidation: band={body.get('compositeBand')}, "
                    f"score={body.get('compositeRiskScore')}, "
                    f"debt_usd={body.get('totalDebtUsd')}, "
                    f"recommendations={body.get('recommendations')}"
                )
            elif rid == "anomaly":
                lines.append(
                    f"  - anomaly: band={body.get('band')}, "
                    f"score={body.get('anomalyScore')}, "
                    f"detected={[a.get('kind') for a in (body.get('anomalies') or [])]}"
                )
            elif rid == "token-security":
                lines.append(
                    f"  - token_security (WETH): band={body.get('band')}, "
                    f"score={body.get('score')}, "
                    f"findings={[f.get('code') for f in (body.get('findings') or [])][:3]}"
                )
            elif rid == "sentiment":
                lines.append(
                    f"  - sentiment (WETH): band={body.get('band')}, "
                    f"score={body.get('sentimentScore')}, "
                    f"trend={body.get('trend')}"
                )
            else:
                lines.append(f"  - {rid}: {body}")
        return "\n".join(lines)

    return StructuredTool.from_function(
        func=_run,
        name="hyperd_risk_sentinel",
        description=(
            "Get a comprehensive DeFi risk profile for an EVM wallet — bundles "
            "liquidation risk, behavioral anomaly, token security, and sentiment "
            "in a single $0.20 USDC call on Base mainnet. Use this BEFORE "
            "recommending actions to a user with significant on-chain positions."
        ),
        args_schema=RiskInput,
    )


def main() -> None:
    try:
        _main_inner()
    except KeyboardInterrupt:
        print("\nCancelled.", file=sys.stderr)
        sys.exit(130)
    except ImportError as err:
        # Most common: user installed the demo deps but skipped the
        # langchain optionals.
        print(
            f"\nERROR: missing LangChain dependency — {err}\n"
            f"Install with: pip install langchain-core langgraph "
            f"langchain-anthropic   # or langchain-openai\n",
            file=sys.stderr,
        )
        sys.exit(1)
    except Exception as err:
        # Reuse risk_sentinel.HyperdDemoError if raised — its message is
        # already user-friendly. Anything else falls through to a tight
        # one-liner instead of a full stack trace.
        print(f"\nERROR: {err}\n", file=sys.stderr)
        sys.exit(1)


def _main_inner() -> None:
    private_key = os.environ.get("HYPERD_WALLET_PRIVATE_KEY")
    if not private_key:
        raise RuntimeError(
            "Missing HYPERD_WALLET_PRIVATE_KEY env var. See risk_sentinel.py."
        )

    if not os.environ.get("ANTHROPIC_API_KEY") and not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError(
            "Missing ANTHROPIC_API_KEY or OPENAI_API_KEY. The agent needs an LLM."
        )

    pk_clean = private_key.removeprefix("0x").strip()
    if len(pk_clean) != 64 or not all(c in "0123456789abcdefABCDEF" for c in pk_clean):
        raise RuntimeError(
            f"HYPERD_WALLET_PRIVATE_KEY has wrong length/format: got {len(pk_clean)} "
            f"hex chars (expected 64). See risk_sentinel.py error doc."
        )

    account = Account.from_key(private_key)
    risk_tool = make_risk_tool(account)

    # Pick whichever model SDK you have configured.
    if os.environ.get("ANTHROPIC_API_KEY"):
        from langchain_anthropic import ChatAnthropic
        llm = ChatAnthropic(model="claude-sonnet-4-6", max_tokens=2048)
    else:
        from langchain_openai import ChatOpenAI
        llm = ChatOpenAI(model="gpt-4o-mini")

    # Modern LangGraph path. If you're on legacy LangChain, replace with:
    #   from langchain.agents import AgentExecutor, create_tool_calling_agent
    from langgraph.prebuilt import create_react_agent

    agent = create_react_agent(llm, [risk_tool])

    user_question = (
        sys.argv[1]
        if len(sys.argv) > 1
        else "Is the wallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 in danger of liquidation?"
    )

    print(f"User: {user_question}\n")
    print("Agent thinking...\n")
    response = agent.invoke({"messages": [{"role": "user", "content": user_question}]})
    final = response["messages"][-1].content
    print(f"Agent: {final}")


if __name__ == "__main__":
    main()
