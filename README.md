# hyperD MCP Server

[![smithery badge](https://smithery.ai/badge/hyperd/hyperd-mcp)](https://smithery.ai/servers/hyperd/hyperd-mcp)
[![npm version](https://img.shields.io/npm/v/hyperd-mcp.svg)](https://www.npmjs.com/package/hyperd-mcp)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Exposes 12 paid x402 API endpoints from `api.hyperd.ai` as MCP tools — drop into Claude Desktop, Cursor, Cline, Zed, or any MCP-compatible client.

## What it does

Each tool call:
1. Sends a request to the corresponding `api.hyperd.ai` endpoint
2. Receives an HTTP 402 with payment requirements
3. Signs an EIP-3009 USDC transfer authorization with your wallet
4. Retries with the payment header
5. Returns the data to the AI assistant

You pay **$0.005–$0.10 in USDC on Base** per call. No subscription. No accounts.

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

Restart Claude Desktop. The 12 hyperD tools appear in the conversation tool list.

### Step 3 — Try it

Ask Claude in any conversation:

> "What's the security score for USDC on Base? Use the hyperd.token.security tool."

Claude calls our endpoint, pays $0.05 from your wallet, returns the result. The whole flow takes ~2 seconds.

### Cursor / Cline / Zed

Each MCP-compatible client has a similar config file. Same pattern: name the server `hyperd`, command is `npx -y hyperd-mcp`, set `HYPERD_WALLET_PRIVATE_KEY` env var.

For the full MCP client list and per-client config docs see https://modelcontextprotocol.io/clients.

## Local-development install (clone instead of npm)

```bash
git clone https://github.com/hyperd-ai/hyperd-mcp.git
cd hyperd-mcp
npm install
npm run build
```

Then in your Claude Desktop config, point at the local file:

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

## License

MIT — see [LICENSE](LICENSE).
