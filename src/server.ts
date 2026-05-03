#!/usr/bin/env node
/**
 * hyperD MCP Server — exposes the 12 hyperD x402 API endpoints as MCP tools.
 *
 * Runs locally (typically launched by Claude Desktop / Cursor / Cline / Zed
 * via stdio transport). When a tool is called, this server makes the
 * corresponding paid HTTP request to api.hyperd.ai using the user's wallet,
 * pays via x402 (USDC on Base), and returns the data.
 *
 * The MCP client (Claude / Cursor / etc) doesn't need to know about wallets
 * or payments — it just calls a tool and gets a result.
 *
 * Required env (one of):
 *   HYPERD_WALLET_PRIVATE_KEY=0x...                 (raw EVM private key, preferred)
 *   HYPERD_WALLET_MNEMONIC="word1 word2 ... word12" (BIP-39, derives at default ETH path)
 *
 * Legacy aliases still accepted (for backward compatibility):
 *   HYPERD_PRIVATE_KEY                              (alias of HYPERD_WALLET_PRIVATE_KEY)
 *   HYPERD_MNEMONIC                                 (alias of HYPERD_WALLET_MNEMONIC)
 *
 * Optional env:
 *   HYPERD_API_BASE   default https://api.hyperd.ai
 *   HYPERD_BASE_RPC   default https://mainnet.base.org
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { z } from "zod";

const RAW = (
  process.env.HYPERD_WALLET_PRIVATE_KEY ||
  process.env.HYPERD_WALLET_MNEMONIC ||
  process.env.HYPERD_PRIVATE_KEY ||
  process.env.HYPERD_MNEMONIC ||
  ""
).trim();
const API_BASE = process.env.HYPERD_API_BASE || "https://api.hyperd.ai";
const RPC_URL = process.env.HYPERD_BASE_RPC || "https://mainnet.base.org";

// Lazy-initialized payment plumbing — boots without a wallet so registries
// (Smithery, Lobehub, etc.) can introspect tool metadata. Tool *calls* without
// a wallet return a clear error pointing the user to set HYPERD_PRIVATE_KEY.
let httpClient: x402HTTPClient | null = null;
let payerAddress: string | null = null;

if (RAW) {
  const wordCount = RAW.split(/\s+/).filter(Boolean).length;
  const account =
    wordCount === 12 || wordCount === 24
      ? mnemonicToAccount(RAW)
      : privateKeyToAccount(
          (RAW.toLowerCase().startsWith("0x") ? RAW : `0x${RAW}`) as `0x${string}`,
        );
  const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });
  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });
  httpClient = new x402HTTPClient(client);
  payerAddress = account.address;
}

async function paidGet(
  path: string,
  query: Record<string, string | number | boolean | undefined>,
): Promise<unknown> {
  if (!httpClient) {
    throw new Error(
      "Wallet not configured. Set HYPERD_WALLET_PRIVATE_KEY (raw 0x hex) OR " +
        "HYPERD_WALLET_MNEMONIC (12/24 BIP-39 words) in this MCP server's env. " +
        "Wallet must hold a few cents of USDC on Base.",
    );
  }

  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "" && v !== null) url.searchParams.set(k, String(v));
  }

  const first = await fetch(url);
  if (first.status === 200) return first.json();
  if (first.status !== 402) {
    throw new Error(`HTTP ${first.status} on initial request: ${await first.text()}`);
  }

  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => first.headers.get(name),
    undefined,
  );
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  const second = await fetch(url, { headers: paymentHeaders });
  if (!second.ok) {
    throw new Error(`HTTP ${second.status} on payment retry: ${await second.text()}`);
  }
  return second.json();
}

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({
  name: "hyperD x402 APIs",
  version: "1.0.0",
});

// ────────────────────────────────────────────────────────────────────────
// 1. balance — multi-chain ERC-20 + native balance ($0.01)
// ────────────────────────────────────────────────────────────────────────
server.tool(
  "hyperd_get_balance",
  "Get the on-chain balance for an EVM wallet address. Multi-chain (Base, Ethereum, Polygon, Arbitrum). Supports ERC-20 by symbol or contract address. Pass chain='all' for parallel multi-chain lookup. Costs $0.01 in USDC on Base.",
  {
    address: z.string().describe("0x EVM wallet address"),
    token: z.string().optional().describe("Token symbol (e.g., USDC, WETH) or contract address. Default USDC."),
    chain: z
      .enum(["base", "ethereum", "polygon", "arbitrum", "base-sepolia", "all"])
      .optional()
      .describe("Chain. Default 'base'. Use 'all' for parallel multi-chain."),
  },
  async (args) => asText(await paidGet("/api/balance", args)),
);

// ────────────────────────────────────────────────────────────────────────
// 2. yield — opinionated DeFi yield recommendation ($0.05)
// ────────────────────────────────────────────────────────────────────────
server.tool(
  "hyperd_get_yield",
  "Get an opinionated DeFi yield recommendation. Filters DefiLlama's pool universe by risk tier (low/medium/high), TVL, and IL exposure, then ranks by APY. Returns the top picks plus projected $ yield over your duration. Costs $0.05 in USDC.",
  {
    amount: z.number().describe("USD amount to invest"),
    risk: z.enum(["low", "medium", "high"]).describe("Risk tolerance"),
    duration: z.number().int().optional().describe("Investment duration in days. Default 30."),
    chain: z.string().optional().describe("Optional chain filter (e.g., 'base')"),
    stables: z.boolean().optional().describe("Stablecoins-only filter. Default false (true for low risk)."),
  },
  async (args) =>
    asText(
      await paidGet("/api/yield", {
        amount: args.amount,
        risk: args.risk,
        duration: args.duration,
        chain: args.chain,
        stables: args.stables,
      }),
    ),
);

// ────────────────────────────────────────────────────────────────────────
// 3. token/info — aggregated token metadata ($0.01)
// ────────────────────────────────────────────────────────────────────────
server.tool(
  "hyperd_get_token_info",
  "Get aggregated token metadata: market cap, supply, contract addresses across chains, recent volume. One call replaces multiple CoinGecko / Etherscan / DefiLlama lookups. Costs $0.01 in USDC.",
  {
    query: z.string().optional().describe("Symbol, name, or coingecko id (e.g., 'USDC' or 'usd-coin')"),
    contract: z.string().optional().describe("Contract address (alternative to query)"),
    chain: z.string().optional().describe("Chain when using contract. Default 'base'."),
  },
  async (args) => asText(await paidGet("/api/token/info", args)),
);

// ────────────────────────────────────────────────────────────────────────
// 4. token/security — security risk score ($0.05)
// ────────────────────────────────────────────────────────────────────────
server.tool(
  "hyperd_check_token_security",
  "Get a token's security risk score (0-100). Ensemble of GoPlus signals: honeypot detection, owner permissions, holder concentration, buy/sell taxes, source verification. Returns score, band (safe/caution/warning/danger), and structured findings. Costs $0.05 in USDC.",
  {
    contract: z.string().describe("Token contract address"),
    chain: z.string().optional().describe("Chain. Default 'base'."),
  },
  async (args) => asText(await paidGet("/api/token/security", args)),
);

// ────────────────────────────────────────────────────────────────────────
// 5. risk/wallet — sanctions + heuristic wallet risk ($0.10)
// ────────────────────────────────────────────────────────────────────────
server.tool(
  "hyperd_check_wallet_risk",
  "Check a wallet's risk profile. Combines Chainalysis Sanctions Oracle (OFAC SDN authoritative) with GoPlus address heuristics (mixers, phishing, scams). Returns sanctioned flag + 0-100 heuristic score. Costs $0.10 in USDC.",
  {
    address: z.string().describe("0x EVM wallet address"),
    chain: z.string().optional().describe("Chain. Default 'base'."),
    deep: z.boolean().optional().describe("Cross-check across multiple chains. Default false."),
  },
  async (args) => asText(await paidGet("/api/risk/wallet", args)),
);

// ────────────────────────────────────────────────────────────────────────
// 6. protocol/tvl — DefiLlama protocol health ($0.01)
// ────────────────────────────────────────────────────────────────────────
server.tool(
  "hyperd_get_protocol_tvl",
  "Get a DeFi protocol's TVL, audits, chain distribution from DefiLlama. Pass slug for detail (e.g., 'aave', 'morpho-blue') or list=true for top 50. Costs $0.01 in USDC.",
  {
    slug: z.string().optional().describe("Protocol slug, e.g., 'aave' or 'morpho-blue'"),
    list: z.boolean().optional().describe("If true, returns top 50 protocols by TVL"),
  },
  async (args) => asText(await paidGet("/api/protocol/tvl", args)),
);

// ────────────────────────────────────────────────────────────────────────
// 7. gas/estimate — gas oracle ($0.005)
// ────────────────────────────────────────────────────────────────────────
server.tool(
  "hyperd_estimate_gas",
  "Get current gas price + base fee + tip percentiles for fast/standard/slow inclusion. Costs $0.005 in USDC.",
  {
    chain: z
      .enum(["base", "ethereum", "polygon", "arbitrum", "base-sepolia"])
      .optional()
      .describe("Chain. Default 'base'."),
  },
  async (args) => asText(await paidGet("/api/gas/estimate", args)),
);

// ────────────────────────────────────────────────────────────────────────
// 8. dex/quote — multi-aggregator best DEX route ($0.02)
// ────────────────────────────────────────────────────────────────────────
server.tool(
  "hyperd_get_dex_quote",
  "Get the best DEX swap route across multiple aggregators (Paraswap + 0x). Returns the highest output amount and per-source quotes. Costs $0.02 in USDC.",
  {
    from: z.string().describe("Source token symbol or contract address"),
    to: z.string().describe("Destination token symbol or contract address"),
    amount: z.string().describe("Decimal amount of source token"),
    chain: z.enum(["base", "ethereum", "polygon", "arbitrum"]).optional().describe("Chain. Default 'base'."),
    slippage: z.number().int().optional().describe("Max slippage in basis points. Default 50."),
    taker: z.string().optional().describe("Optional payer address for 0x quote (improves accuracy)"),
  },
  async (args) => asText(await paidGet("/api/dex/quote", args)),
);

// ────────────────────────────────────────────────────────────────────────
// 9. wallet/persona — behavioral classification ($0.10)
// ────────────────────────────────────────────────────────────────────────
server.tool(
  "hyperd_classify_wallet",
  "Classify a wallet's persona based on on-chain behavior. Returns one of: Trader, HODLer, MEV-bot, Whale, Smart-Money, Airdrop-Farmer, Compromised, Inactive — plus confidence and supporting signals. Costs $0.10 in USDC.",
  {
    address: z.string().describe("0x EVM wallet address"),
    chain: z
      .enum(["base", "ethereum", "polygon", "arbitrum"])
      .optional()
      .describe("Chain to analyze. Default 'base'."),
  },
  async (args) => asText(await paidGet("/api/wallet/persona", args)),
);

// ────────────────────────────────────────────────────────────────────────
// 10. contract/audit — pre-trade contract security ($0.10)
// ────────────────────────────────────────────────────────────────────────
server.tool(
  "hyperd_audit_contract",
  "Pre-trade contract security audit. Composes GoPlus + Sourcify + DefiLlama protocol recognition + on-chain heuristics into a single 0-100 risk score with structured findings. Use BEFORE interacting with any unfamiliar contract. Costs $0.10 in USDC.",
  {
    contract: z.string().describe("Contract address to audit"),
    chain: z
      .enum(["base", "ethereum", "polygon", "arbitrum"])
      .optional()
      .describe("Chain. Default 'base'."),
  },
  async (args) => asText(await paidGet("/api/contract/audit", args)),
);

// ────────────────────────────────────────────────────────────────────────
// 11. governance/summarize — DAO proposal LLM summary ($0.10)
// ────────────────────────────────────────────────────────────────────────
server.tool(
  "hyperd_summarize_governance",
  "Summarize a DAO governance proposal (Snapshot or Tally URL). Returns structured impact analysis: who benefits, who pays, recommended position. LLM-summarized. Costs $0.10 in USDC.",
  {
    proposal_url: z.string().describe("Snapshot or Tally proposal URL"),
  },
  async (args) => asText(await paidGet("/api/governance/summarize", args)),
);

// ────────────────────────────────────────────────────────────────────────
// 12. sentiment/token — Farcaster sentiment ($0.05)
// ────────────────────────────────────────────────────────────────────────
server.tool(
  "hyperd_get_token_sentiment",
  "Get a token's sentiment score (0-100) from recent Farcaster discussion. Returns score, band (very_negative to very_positive), volume, trend, sample casts. Costs $0.05 in USDC.",
  {
    token: z.string().describe("Token symbol or name"),
    window: z.string().optional().describe('Days (1-30) or "24h" / "7d". Default "24h".'),
  },
  async (args) => asText(await paidGet("/api/sentiment/token", args)),
);

// ────────────────────────────────────────────────────────────────────────
// Boot
// ────────────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (payerAddress) {
    console.error(`hyperD MCP server running. Payer: ${payerAddress}. API: ${API_BASE}`);
  } else {
    console.error(
      `hyperD MCP server running in INTROSPECTION mode (no wallet configured). Tool calls will error until you set HYPERD_WALLET_PRIVATE_KEY or HYPERD_WALLET_MNEMONIC in env.`,
    );
  }
}

main().catch((err) => {
  console.error("hyperD MCP fatal error:", err);
  process.exit(1);
});
