# hyperd — Python examples

Two runnable scripts that show the v1.0 marquee feature (`/api/bundle`)
from Python. Both are intentionally self-contained — no `pip install
hyperd` library, just `requests` + `eth-account` + the x402 EIP-3009
signing flow inline.

If you want to see exactly how x402 works at the bytes level, this is
the file to read.

## What's here

| File | Lines | What it does |
|---|---:|---|
| [`risk_sentinel.py`](risk_sentinel.py) | ~200 | Standalone demo: bundles 4 paid hyperd tools in one `/api/bundle` call. Implements EIP-3009 signing inline. |
| [`agent_langchain.py`](agent_langchain.py) | ~100 | Wraps `risk_sentinel.run_risk_sentinel` as a LangChain `StructuredTool`, hands it to a Claude / GPT agent. |
| [`requirements.txt`](requirements.txt) | — | `requests`, `eth-account`. LangChain deps commented out (uncomment for `agent_langchain.py`). |

## Setup

```bash
# 1. Install deps
pip install -r requirements.txt

# 2. Set a Base-mainnet wallet's private key.
#    Use a fresh hot wallet, not your main one. Fund with ~$0.30 USDC.
export HYPERD_WALLET_PRIVATE_KEY=0xYOUR_PRIVATE_KEY
```

A simple way to generate a fresh key (note: `eth-account` returns the
hex without a `0x` prefix; the script accepts either form, but the
exported env var below uses the `0x`-prefixed shape for clarity):

```bash
python -c "from eth_account import Account; a = Account.create(); print('addr:', a.address); print('key: 0x' + a.key.hex())"
```

Send ~$0.50 USDC on Base to the printed address.

## Run

### Standalone demo

```bash
python risk_sentinel.py
```

Output (real, with a funded wallet):

```
hyperd Risk Sentinel demo
  payer  : 0xYourPayerAddress
  target : 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
  token  : WETH (0x4200000000000000000000000000000000000006)
  API    : https://api.hyperd.ai

Settled in 4823ms
  bundle_id      : 0c2e1c8a-...
  paid           : $0.200 USDC
  à la carte sum : $0.300 USDC
  saved          : $0.100 (4/4 successful)

  ✓ liquidation     band=safe score=18 debt=$12000
  ✓ anomaly         band=normal score=12 anomalies=0
  ✓ token-security  band=safe score=4
  ✓ sentiment       band=neutral_positive score=58 trend=stable
```

Pass another wallet to analyze:

```bash
python risk_sentinel.py 0xANOTHER_WALLET_ADDRESS
```

### LangChain agent

```bash
pip install langchain-core langgraph langchain-anthropic
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY

python agent_langchain.py "Is wallet 0xd8dA6BF26964... at risk?"
```

The agent decides when to invoke the bundled risk-sentinel tool, then
synthesizes a plain-English risk summary. Total cost per agent run ≈
$0.20 (the bundle call) + your LLM tokens.

## Pricing

| Tool | À la carte | In this bundle |
|---|---:|---:|
| `liquidation.risk` | $0.10 | included |
| `wallet.anomaly` | $0.10 | included |
| `token.security` | $0.05 | included |
| `sentiment.token` | $0.05 | included |
| **Total** | **$0.30** | **$0.20** (bundled) |

Saves $0.10 per call AND collapses 4 settlement round-trips into 1.

## Beyond this demo

- **Want all 16 paid endpoints in Python with one import?** A first-class
  `pip install hyperd` SDK is on the roadmap — design notes in the
  monorepo's task tracker. For now, copy the signing helpers from
  `risk_sentinel.py` and add new endpoint paths to your `body["calls"]`.
- **Want this as MCP tools instead of a script?** `npx -y hyperd-mcp`
  exposes all 22 tools to Claude Desktop / Cursor / Cline / Zed via
  stdio. See [hyperd-mcp on npm](https://www.npmjs.com/package/hyperd-mcp).

## Forking this on Replit

1. Fork the parent repo on GitHub.
2. Import to Replit (or click "Open in Colab" once we add a `.ipynb`).
3. Set `HYPERD_WALLET_PRIVATE_KEY` as a Replit Secret.
4. Hit Run.

## Troubleshooting

- **`HTTP 402` loop**: payment didn't settle. Check your wallet has USDC
  on Base mainnet, not Ethereum or Sepolia.
- **`HTTP 503` on `watch.list` / `watch.create`**: means `WATCHES_ENABLED`
  is `false` on the deployed API (Hobby tier launch state) — the watch
  endpoints return 503 by design until the project moves to Vercel Pro
  and the env var is flipped. The error body explains how to enable.
- **Repeated `HTTP 402`s on every call**: usually means the X-Payment
  payload's `accepted` field doesn't match the server's
  paymentRequirements — verify you're using v2 envelope shape and
  echoing the full requirement object back.
- **`HTTP 429`**: rate limited. Wait a minute and retry.

## Related

- [Top-level examples README](../README.md) for the TypeScript demos
- [hyperd-mcp README](../../packages/hyperd-mcp/README.md)
- [x402 protocol spec](https://x402.org)
