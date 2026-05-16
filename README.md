# hyperD MCP Server

Exposes 23 hyperD x402 API tools (16 paid endpoints + bundle + 3 watch + 3 free meta) from `api.hyperd.ai` — drop into Claude Desktop, Cursor, Cline, Zed, or any MCP-compatible client.

## What it does

Each tool call:
1. Sends a request to the corresponding `api.hyperd.ai` endpoint
2. Receives an HTTP 402 with payment requirements
3. Signs an EIP-3009 USDC transfer authorization with your wallet
4. Retries with the payment header
5. Returns the data to the AI assistant

You pay **$0.005–$0.10 in USDC on Base** per call. No subscription. No accounts.

## Try it free

First 5 calls per IP per 24h are free — no wallet, no signup, no API key. Just curl:

```bash
curl "https://api.hyperd.ai/api/balance?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
```

Lifetime cap: 25 calls per IP. After that (or when daily quota is exhausted), the endpoint returns HTTP 402 — sign a small EIP-3009 USDC payment on Base via the [Python SDK](https://pypi.org/project/hyperd-ai/) or [TypeScript MCP server](https://www.npmjs.com/package/hyperd-mcp).

`/api/wallet/pnl` has a tighter free-tier cap of 1 call/IP/day (heavy upstream).

## What you need

- A wallet with **at least $0.30 USDC on Base** (the seed cost for trying every tool once is ~$0.62)
- The wallet's private key OR 12-word BIP-39 mnemonic
- Node 20+ installed

## Install + configure

### Step 1 — Generate or use an existing wallet

For testing, **use a fresh wallet, not your main one.** A simple way:

```bash
node -e "const {generatePrivateKey, privateKeyToAccount} = require('viem/accounts'); const pk = generatePrivateKey(); console.log('Address:', privateKeyToAccount(pk).address); console.log('Private key:', pk);"
```

Send ~$1 of USDC on Base to the printed address.

### Step 2 — Claude Desktop

Edit your Claude Desktop config (location: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hyperd": {
      "command": "npx",
      "args": ["-y", "hyperd-mcp"],
      "env": {
        "HYPERD_WALLET_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY_HERE"
      }
    }
  }
}
```

Restart Claude Desktop. The 23 hyperD tools appear in the conversation tool list.

### Step 3 — Try it

Ask Claude in any conversation:

> "What's the security score for USDC on Base? Use the hyperd.token.security tool."

Claude calls our endpoint, pays $0.05 from your wallet, returns the result. The whole flow takes ~2 seconds.

### Cursor / Cline / Zed

Each MCP-compatible client has a similar config file. Same pattern: name the server `hyperd`, command is `npx -y hyperd-mcp`, set `HYPERD_WALLET_PRIVATE_KEY` env var.

For the full MCP client list and per-client config docs see https://modelcontextprotocol.io/clients.

## Local-development install (without npm publish)

If you want to run from source instead of `npx`:

```bash
git clone https://github.com/hyperd-ai/hyperd-mcp.git
cd hyperd-mcp
npm install
npm run build
```

Then in your Claude Desktop config, point at the local build:

```json
{
  "mcpServers": {
    "hyperd": {
      "command": "node",
      "args": ["/full/path/to/hyperd-mcp/dist/server.js"],
      "env": {
        "HYPERD_WALLET_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY_HERE"
      }
    }
  }
}
```

## Available tools

| Tool | Price | What it does |
|---|---|---|
| `hyperd.balance.get` | $0.01 | Multi-chain ERC-20 + native balance lookup |
| `hyperd.yield.recommend` | $0.05 | Opinionated DeFi yield recommendation |
| `hyperd.token.info` | $0.01 | Aggregated token metadata (CoinGecko + DefiLlama) |
| `hyperd.token.security` | $0.05 | GoPlus-backed security risk score |
| `hyperd.wallet.risk` | $0.10 | Chainalysis sanctions + GoPlus heuristics |
| `hyperd.protocol.tvl` | $0.01 | DefiLlama protocol health |
| `hyperd.gas.estimate` | $0.005 | Gas oracle with tip percentiles |
| `hyperd.dex.quote` | $0.02 | Multi-aggregator best DEX route |
| `hyperd.wallet.persona` | $0.10 | Behavioral wallet classification |
| `hyperd.contract.audit` | $0.10 | Pre-trade contract security composite |
| `hyperd.governance.summarize` | $0.10 | LLM-summarized DAO proposals |
| `hyperd.sentiment.token` | $0.05 | Token sentiment from Farcaster |
| `hyperd.liquidation.risk` | $0.10 | Cross-protocol liquidation risk (Aave V3 / Compound v3 / Spark / Morpho) |
| `hyperd.wallet.anomaly` | $0.10 | Wallet anomaly detection vs 180-day baseline |
| `hyperd.wallet.pnl` | $0.05 | Realized + unrealized P&L (FIFO/LIFO/HCFO) |
| `hyperd.budget.guardian` | $0.01 | Agent USDC spend visibility + cap check |
| `hyperd.bundle` | $0.20 fixed | Multi-call: 1-10 paid GETs in one settlement |
| `hyperd.watch.create` | $3.00 prepay | Subscribe to a continuous liquidation watch (HMAC webhooks) |
| `hyperd.watch.list` | (free for owner) | List your active watches |
| `hyperd.watch.cancel` | (free for owner) | Cancel one of your watches |

Full HTTP API docs: https://api.hyperd.ai/api/discover

## Security

- **Use a hot wallet**, not your primary. The MCP server has the private key in process memory while it runs.
- **Cap your spend** by transferring only what you want to use. There's no built-in spending limit; the wallet's balance IS the limit.
- **Don't commit your private key.** The Claude Desktop config file is local; don't share it.

## Configuration via mnemonic instead of private key

If you have a 12 or 24-word BIP-39 mnemonic instead of a raw key:

```json
"env": {
  "HYPERD_WALLET_MNEMONIC": "word1 word2 ... word12"
}
```

Derives at the standard Ethereum path `m/44'/60'/0'/0/0`.

## Optional env vars

- `HYPERD_API_BASE` — default `https://api.hyperd.ai`. Override for testnet or self-hosted.
- `HYPERD_BASE_RPC` — default public Base RPC. Override for higher rate limits.

## Remote MCP-over-HTTPS (no install)

If you don't want to run the stdio server locally, hyperD's full tool catalog is also available as a remote MCP server:

```
POST https://api.hyperd.ai/mcp
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/list"}
```

Same 17 tools, same free-tier quota (5 calls/IP/day, 25 lifetime), same `X-Payment` auth model for paid calls after quota. No `npm install`, no per-IDE config — just a URL.

Useful when:
- You're deploying an agent to a serverless platform (Vercel, Lambda) and don't want to bundle the stdio process
- You're using an MCP-aware service that expects a remote URL (Smithery enterprise, hosted gateways)
- You want to test the API surface from the command line with `curl` before committing to a local install

Server card: [`https://api.hyperd.ai/.well-known/mcp.json`](https://api.hyperd.ai/.well-known/mcp.json).

## License

MIT — same as the parent repo.
