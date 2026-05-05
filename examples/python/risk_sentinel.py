"""
hyperd Risk Sentinel — Python demo.

Bundles 4 paid hyperd tools in ONE x402 settlement to get a comprehensive
risk profile for any EVM wallet:

    GET /api/liquidation/risk   ($0.10) cross-protocol lending health
    GET /api/wallet/anomaly     ($0.10) behavioral deviation vs 180d baseline
    GET /api/token/security     ($0.05) GoPlus security score for a held token
    GET /api/sentiment/token    ($0.05) Farcaster sentiment for that token

    Sum à la carte: $0.30
    Bundle price:   $0.20  (saves $0.10 + 3 fewer round-trips)

This file is intentionally self-contained — it implements the x402
EIP-3009 signing flow inline so you can SEE how the protocol works. For
production use, prefer the `x402` package on PyPI:

    pip install x402

Run:

    pip install -r requirements.txt
    export HYPERD_WALLET_PRIVATE_KEY=0xYOUR_PRIVATE_KEY
    python risk_sentinel.py 0xWALLET_TO_ANALYZE

Requires:
    - Python 3.10+
    - A Base mainnet wallet with at least $0.30 USDC
    - eth-account, requests
"""
from __future__ import annotations

import base64
import json
import os
import secrets
import sys
import time
from dataclasses import dataclass
from typing import Any

import requests
from eth_account import Account
from eth_account.messages import encode_typed_data

API_BASE = os.environ.get("HYPERD_API_BASE", "https://api.hyperd.ai")

# Default target wallet for the demo. Pass another as argv[1].
DEFAULT_TARGET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"  # Vitalik
# Token whose security + sentiment to check.
TOKEN_CONTRACT = "0x4200000000000000000000000000000000000006"  # WETH on Base
TOKEN_SYMBOL = "WETH"


@dataclass
class PaymentRequirement:
    """The 402 challenge fields we need to sign a transfer authorization."""

    scheme: str
    network: str
    amount: str
    asset: str
    pay_to: str
    max_timeout_seconds: int
    extra: dict[str, Any]


def parse_payment_required(
    headers: dict[str, str],
) -> tuple[PaymentRequirement, dict[str, Any]]:
    """Decode the PAYMENT-REQUIRED header from a 402 response.

    The server base64-encodes a JSON envelope; the `accepts` array lists
    one or more schemes the server will settle. We pick the first
    `exact` scheme on an `eip155:*` network (USDC on EVM).

    Returns the parsed dataclass for ergonomic access AND the raw dict
    of the chosen requirement — the v2 X-Payment payload echoes the
    full requirement back to the server in an `accepted` field, which
    the server uses for `deepEqual` matching against its own list.
    """
    raw = headers.get("payment-required") or headers.get("PAYMENT-REQUIRED")
    if not raw:
        raise RuntimeError("Server returned 402 but no PAYMENT-REQUIRED header.")
    decoded = json.loads(base64.b64decode(raw).decode("utf-8"))
    accepts = decoded.get("accepts") or []
    for opt in accepts:
        if opt.get("scheme") == "exact" and opt.get("network", "").startswith("eip155:"):
            req = PaymentRequirement(
                scheme=opt["scheme"],
                network=opt["network"],
                amount=str(opt["amount"]),
                asset=opt["asset"],
                pay_to=opt["payTo"],
                max_timeout_seconds=int(opt.get("maxTimeoutSeconds", 300)),
                extra=opt.get("extra") or {},
            )
            return req, opt
    raise RuntimeError(f"No supported payment option in 402: {accepts!r}")


def sign_payment_authorization(
    account: Account,
    req: PaymentRequirement,
    raw_requirement: dict[str, Any],
) -> dict[str, Any]:
    """Sign EIP-3009 transferWithAuthorization for the 402 challenge.

    USDC implements EIP-3009 — a meta-transaction standard that lets us
    pre-authorize a transfer with a signature, which the facilitator
    submits on-chain. The signature commits to a specific
    (from, to, value, validAfter, validBefore, nonce) tuple.

    Returns a v2 PaymentPayload envelope. The `accepted` field echoes
    the chosen requirement back to the server — it deep-equals against
    its own paymentRequirements list to match. Without `accepted`, the
    server can't find a matching requirement and the second request
    falls back into another 402.
    """
    chain_id = int(req.network.split(":", 1)[1])  # "eip155:8453" → 8453
    # Reference clients use validAfter = now - 10min so a slight clock
    # skew between us and the facilitator doesn't reject the auth as
    # not-yet-valid. validAfter=0 also works on Base USDC but is
    # nonconforming.
    valid_after = max(0, int(time.time()) - 600)
    valid_before = int(time.time()) + req.max_timeout_seconds
    nonce_bytes = secrets.token_bytes(32)
    nonce_hex = "0x" + nonce_bytes.hex()

    # USDC's EIP-712 domain — server's `extra` block is authoritative.
    # On-chain USDC contracts use `name = "USDC"` on Base; Ethereum
    # mainnet USDC uses `name = "USD Coin"`. We trust the server-emitted
    # value from the 402 challenge. Raise loudly if it's missing rather
    # than guess — silent guess → wrong domain → on-chain verify fails.
    name = req.extra.get("name")
    version = req.extra.get("version")
    if not name or not version:
        raise RuntimeError(
            f"402 challenge missing required `extra.name` / `extra.version` "
            f"for EIP-712 domain (got extra={req.extra!r}). Server should "
            f"include these — see https://x402.org/specs."
        )

    typed_data = {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "TransferWithAuthorization": [
                {"name": "from", "type": "address"},
                {"name": "to", "type": "address"},
                {"name": "value", "type": "uint256"},
                {"name": "validAfter", "type": "uint256"},
                {"name": "validBefore", "type": "uint256"},
                {"name": "nonce", "type": "bytes32"},
            ],
        },
        "primaryType": "TransferWithAuthorization",
        "domain": {
            "name": name,
            "version": version,
            "chainId": chain_id,
            "verifyingContract": req.asset,
        },
        "message": {
            "from": account.address,
            "to": req.pay_to,
            "value": int(req.amount),
            "validAfter": valid_after,
            "validBefore": valid_before,
            "nonce": nonce_bytes,
        },
    }
    signed = account.sign_typed_data(full_message=typed_data)
    signature_hex = signed.signature.hex()
    if not signature_hex.startswith("0x"):
        signature_hex = "0x" + signature_hex

    return {
        "x402Version": 2,
        # Echo the full requirement we matched. Server uses deepEqual
        # against its paymentRequirements list — without this, no match
        # → second request also 402s.
        "accepted": raw_requirement,
        "payload": {
            "signature": signature_hex,
            "authorization": {
                "from": account.address,
                "to": req.pay_to,
                "value": req.amount,
                "validAfter": str(valid_after),
                "validBefore": str(valid_before),
                "nonce": nonce_hex,
            },
        },
    }


def encode_payment_header(payment: dict[str, Any]) -> str:
    """Base64-encode the signed payment payload for the X-Payment header."""
    return base64.b64encode(json.dumps(payment).encode("utf-8")).decode("ascii")


def call_with_payment(
    account: Account,
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    body: Any = None,
) -> tuple[int, Any]:
    """Make an x402-paid request. Returns (http_status, json_body).

    Standard x402 dance: send unauthenticated → server returns 402 →
    sign authorization → resend with X-Payment header → server settles
    → returns 200 with the actual response.
    """
    url = f"{API_BASE}{path}"
    headers = {"Content-Type": "application/json"} if body is not None else {}
    body_payload = json.dumps(body) if body is not None else None

    first = requests.request(method, url, params=params, data=body_payload, headers=headers, timeout=30)
    if first.status_code in (200, 201):
        return first.status_code, first.json()
    if first.status_code != 402:
        return first.status_code, _safe_json(first)

    # `requests.Response.headers` is already case-insensitive, but we
    # lowercase the dict to be defensive about middleware quirks.
    requirement, raw_requirement = parse_payment_required(
        {k.lower(): v for k, v in first.headers.items()}
    )
    payment = sign_payment_authorization(account, requirement, raw_requirement)
    payment_header = encode_payment_header(payment)
    # `PAYMENT-SIGNATURE` is the v2 spec name. `@x402/express` also bridges
    # `x-payment` to it for compatibility, so either works against hyperd —
    # but bare `@x402/core` servers (no Express) only accept this name.
    # Set both for maximum compatibility.
    headers["PAYMENT-SIGNATURE"] = payment_header
    headers["X-Payment"] = payment_header

    second = requests.request(method, url, params=params, data=body_payload, headers=headers, timeout=60)
    return second.status_code, _safe_json(second)


def _safe_json(r: requests.Response) -> Any:
    try:
        return r.json()
    except Exception:
        return {"error": r.text[:500]}


def run_risk_sentinel(account: Account, target: str) -> dict[str, Any]:
    """Run the marquee bundle: 4 risk signals in one x402 settlement."""
    body = {
        "calls": [
            {
                "id": "liquidation",
                "method": "GET",
                "path": "/api/liquidation/risk",
                "query": {"address": target, "chain": "base"},
            },
            {
                "id": "anomaly",
                "method": "GET",
                "path": "/api/wallet/anomaly",
                "query": {"address": target, "chain": "base", "window": "24h"},
            },
            {
                "id": "token-security",
                "method": "GET",
                "path": "/api/token/security",
                "query": {"contract": TOKEN_CONTRACT, "chain": "base"},
            },
            {
                "id": "sentiment",
                "method": "GET",
                "path": "/api/sentiment/token",
                "query": {"token": TOKEN_SYMBOL, "window": "24h"},
            },
        ]
    }
    status, payload = call_with_payment(account, "POST", "/api/bundle", body=body)
    if status != 200:
        raise RuntimeError(f"Bundle call failed: HTTP {status} — {payload}")
    return payload


def summarize(result: dict[str, Any]) -> str:
    """One-line summary per sub-call. Best-effort field extraction."""
    rid = result.get("id", "?")
    status = result.get("status", 0)
    if status != 200:
        err = (result.get("body") or {}).get("error", "non-200")
        return f"  ✗ {rid:<16} HTTP {status}  → error: {err}"
    body = result.get("body") or {}
    if rid == "liquidation":
        return (
            f"  ✓ {rid:<16} band={body.get('compositeBand')} "
            f"score={body.get('compositeRiskScore')} "
            f"debt=${body.get('totalDebtUsd', 0):.0f}"
        )
    if rid == "anomaly":
        return (
            f"  ✓ {rid:<16} band={body.get('band')} "
            f"score={body.get('anomalyScore')} "
            f"anomalies={len(body.get('anomalies') or [])}"
        )
    if rid == "token-security":
        return f"  ✓ {rid:<16} band={body.get('band')} score={body.get('score')}"
    if rid == "sentiment":
        return (
            f"  ✓ {rid:<16} band={body.get('band')} "
            f"score={body.get('sentimentScore')} "
            f"trend={body.get('trend')}"
        )
    return f"  ✓ {rid:<16} {json.dumps(body)[:80]}"


def _selftest() -> None:
    """Offline shape-verification of the x402 payload — no live wallet, no network.

    Builds a deterministic payment payload from a test key + canned 402
    challenge, then asserts the envelope shape, field names, and byte
    lengths match what `@x402/core` v2.6.0 server expects. Run with:

        python risk_sentinel.py --selftest

    Use this to confirm a fork hasn't drifted from the protocol shape.
    """
    test_key = "0x" + "11" * 32
    account = Account.from_key(test_key)
    raw = {
        "scheme": "exact",
        "network": "eip155:8453",
        "amount": "100000",
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "payTo": "0x0000000000000000000000000000000000000001",
        "maxTimeoutSeconds": 300,
        "extra": {"name": "USDC", "version": "2"},
    }
    req = PaymentRequirement(
        scheme=raw["scheme"],
        network=raw["network"],
        amount=raw["amount"],
        asset=raw["asset"],
        pay_to=raw["payTo"],
        max_timeout_seconds=raw["maxTimeoutSeconds"],
        extra=raw["extra"],
    )
    payment = sign_payment_authorization(account, req, raw)
    encoded = encode_payment_header(payment)

    # Envelope shape
    assert payment["x402Version"] == 2, "x402Version must be 2"
    assert payment["accepted"] == raw, "accepted must deep-equal the raw requirement"

    auth = payment["payload"]["authorization"]
    assert auth["from"] == account.address, "authorization.from mismatch"
    assert auth["to"] == raw["payTo"], "authorization.to mismatch"
    assert auth["value"] == raw["amount"], "authorization.value mismatch"
    assert auth["nonce"].startswith("0x"), "nonce must be 0x-prefixed"
    assert len(auth["nonce"]) == 66, f"nonce must be 32 bytes (got {len(auth['nonce'])})"
    assert int(auth["validBefore"]) > int(auth["validAfter"]), "validBefore must be > validAfter"

    sig = payment["payload"]["signature"]
    assert sig.startswith("0x"), "signature must be 0x-prefixed"
    assert len(sig) == 132, f"signature must be 65 bytes / 132 hex chars (got {len(sig)})"

    # Header is base64-decodable JSON
    decoded = json.loads(base64.b64decode(encoded).decode("utf-8"))
    assert decoded == payment, "round-trip base64 mismatch"

    print("Self-test PASSED")
    print(f"  payer       : {account.address}")
    print(f"  envelope    : v{payment['x402Version']} with `accepted` echo")
    print(f"  signature   : {len(sig)} chars (65 bytes hex)")
    print(f"  nonce       : {len(auth['nonce'])} chars (32 bytes hex)")
    print(f"  header bytes: {len(encoded)} (base64-encoded payment payload)")


def main() -> None:
    if "--selftest" in sys.argv[1:]:
        _selftest()
        return

    private_key = os.environ.get("HYPERD_WALLET_PRIVATE_KEY")
    if not private_key:
        print(
            "Missing HYPERD_WALLET_PRIVATE_KEY env var. Set a Base-mainnet "
            "private key (hex, 0x-prefixed) for a wallet with ≥ $0.30 USDC.",
            file=sys.stderr,
        )
        sys.exit(1)

    account = Account.from_key(private_key)
    target = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_TARGET

    print("hyperd Risk Sentinel demo")
    print(f"  payer  : {account.address}")
    print(f"  target : {target}")
    print(f"  token  : {TOKEN_SYMBOL} ({TOKEN_CONTRACT})")
    print(f"  API    : {API_BASE}")
    print()

    start = time.time()
    payload = run_risk_sentinel(account, target)
    elapsed_ms = int((time.time() - start) * 1000)

    print(f"Settled in {elapsed_ms}ms")
    print(f"  bundle_id      : {payload.get('bundle_id')}")
    print(f"  paid           : ${payload.get('bundle_price_usd', 0):.3f} USDC")
    print(f"  à la carte sum : ${payload.get('sum_unit_prices_usd', 0):.3f} USDC")
    print(
        f"  saved          : ${payload.get('savings_usd', 0):.3f} "
        f"({payload.get('success_count')}/{len(payload.get('results') or [])} successful)"
    )
    print()

    for r in payload.get("results", []):
        print(summarize(r))


if __name__ == "__main__":
    main()
