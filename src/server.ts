#!/usr/bin/env node
/**
 * hyperD MCP Server — exposes the hyperD x402 API endpoints as MCP tools.
 *
 * Runs locally (typically launched by Claude Desktop / Cursor / Cline / Zed
 * via stdio transport). Free tools (catalog, pricing, health) work with no
 * configuration. Paid tools require a wallet env var; each call signs an
 * x402 USDC payment on Base.
 *
 * Optional env (only required for PAID tools):
 *   HYPERD_WALLET_PRIVATE_KEY=0x...                 (raw EVM private key, preferred)
 *   HYPERD_WALLET_MNEMONIC="word1 word2 ... word12" (BIP-39, derives at default ETH path)
 *
 * Legacy aliases still accepted (for backward compatibility):
 *   HYPERD_PRIVATE_KEY                              (alias of HYPERD_WALLET_PRIVATE_KEY)
 *   HYPERD_MNEMONIC                                 (alias of HYPERD_WALLET_MNEMONIC)
 *
 * Other optional env:
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

// Lazy-initialized payment plumbing — boots without a wallet so the free
// catalog/pricing/health tools work immediately and registries can introspect
// metadata. Paid tool calls without a wallet return a clear error.
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

async function freeGet(
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<unknown> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "" && v !== null) url.searchParams.set(k, String(v));
  }
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`HTTP ${r.status} on free request: ${await r.text()}`);
  }
  return r.json();
}

async function paidGet(
  path: string,
  query: Record<string, string | number | boolean | undefined>,
): Promise<unknown> {
  if (!httpClient) {
    throw new Error(WALLET_NOT_CONFIGURED_MSG);
  }

  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "" && v !== null) url.searchParams.set(k, String(v));
  }
  return paidRequest("GET", url, undefined);
}

/**
 * Same x402 dance as paidGet but for POST/DELETE bodies. Used by the
 * bundle endpoint (POST with `calls`) and watch management (POST/DELETE).
 */
async function paidWithBody(
  method: "POST" | "DELETE",
  path: string,
  body: unknown,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<unknown> {
  if (!httpClient) {
    throw new Error(WALLET_NOT_CONFIGURED_MSG);
  }
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "" && v !== null) url.searchParams.set(k, String(v));
  }
  return paidRequest(method, url, body);
}

async function paidRequest(
  method: "GET" | "POST" | "DELETE",
  url: URL,
  body: unknown,
): Promise<unknown> {
  const requestInit = (extraHeaders: Record<string, string> = {}): RequestInit => {
    const headers: Record<string, string> = { ...extraHeaders };
    let payload: string | undefined;
    if (body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    return { method, headers, body: payload };
  };

  const first = await fetch(url, requestInit());
  if (first.status === 200 || first.status === 201) return first.json();
  if (first.status !== 402) {
    throw new Error(`HTTP ${first.status} on initial ${method} request: ${await first.text()}`);
  }

  const paymentRequired = httpClient!.getPaymentRequiredResponse(
    (name) => first.headers.get(name),
    undefined,
  );
  const paymentPayload = await httpClient!.createPaymentPayload(paymentRequired);
  const paymentHeaders = httpClient!.encodePaymentSignatureHeader(paymentPayload);

  const second = await fetch(url, requestInit(paymentHeaders));
  if (!second.ok) {
    throw new Error(`HTTP ${second.status} on payment retry: ${await second.text()}`);
  }
  return second.json();
}

const WALLET_NOT_CONFIGURED_MSG =
  "Wallet not configured — this is a paid tool. Set HYPERD_WALLET_PRIVATE_KEY (raw 0x hex) " +
  "OR HYPERD_WALLET_MNEMONIC (12/24 BIP-39 words) in this MCP server's env. Wallet must " +
  "hold a few cents of USDC on Base. Free tools (hyperd.catalog.list, hyperd.pricing.get, " +
  "hyperd.health.check) work without a wallet.";

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({
  name: "hyperD x402 APIs",
  version: "1.0.1",
});

// ════════════════════════════════════════════════════════════════════════
//                   FREE TOOLS — work without a wallet
// ════════════════════════════════════════════════════════════════════════

// hyperd.catalog.list — list all hyperD endpoints (free)
server.tool(
  "hyperd.catalog.list",
  "List all available hyperD x402 API endpoints with their prices, descriptions, and example responses. FREE — no wallet required. Use this to discover what tools are available before configuring a wallet.",
  {},
  async () => asText(await freeGet("/api/discover")),
);

// hyperd.pricing.get — machine-readable price list (free)
server.tool(
  "hyperd.pricing.get",
  "Get the current price list for all hyperD paid endpoints (in USDC on Base). FREE — no wallet required.",
  {},
  async () => asText(await freeGet("/api/pricing")),
);

// hyperd.health.check — service liveness (free)
server.tool(
  "hyperd.health.check",
  "Check the health of the hyperD API: which network it's on, whether the payment facilitator is configured, which optional backend keys are wired, and cache stats. FREE — no wallet required.",
  {},
  async () => asText(await freeGet("/api/health")),
);

// ════════════════════════════════════════════════════════════════════════
//                  PAID TOOLS — require a wallet env var
// ════════════════════════════════════════════════════════════════════════

// hyperd.balance.get — multi-chain ERC-20 + native balance ($0.01)
server.tool(
  "hyperd.balance.get",
  "Get the on-chain balance for an EVM wallet address. Multi-chain (Base, Ethereum, Polygon, Arbitrum). Supports ERC-20 by symbol or contract address. Pass chain='all' for parallel multi-chain lookup. Costs $0.01 in USDC on Base.",
  {
    address: z.string().describe("0x EVM wallet address"),
    token: z.string().optional().describe("Token symbol (e.g., USDC, WETH) or contract address. Default USDC."),
    chain: z
      .enum(["base", "ethereum", "polygon", "arbitrum", "optimism", "avalanche", "bnb", "base-sepolia", "all"])
      .optional()
      .describe("Chain. Default 'base'. Use 'all' for parallel multi-chain."),
  },
  async (args) => asText(await paidGet("/api/balance", args)),
);

// hyperd.yield.recommend — opinionated DeFi yield recommendation ($0.05)
server.tool(
  "hyperd.yield.recommend",
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

// hyperd.token.info — aggregated token metadata ($0.01)
server.tool(
  "hyperd.token.info",
  "Get aggregated token metadata: market cap, supply, contract addresses across chains, recent volume. One call replaces multiple CoinGecko / Etherscan / DefiLlama lookups. Costs $0.01 in USDC.",
  {
    query: z.string().optional().describe("Symbol, name, or coingecko id (e.g., 'USDC' or 'usd-coin')"),
    contract: z.string().optional().describe("Contract address (alternative to query)"),
    chain: z.string().optional().describe("Chain when using contract. Default 'base'."),
  },
  async (args) => asText(await paidGet("/api/token/info", args)),
);

// hyperd.token.security — security risk score ($0.05)
server.tool(
  "hyperd.token.security",
  "Get a token's security risk score (0-100). Ensemble of GoPlus signals: honeypot detection, owner permissions, holder concentration, buy/sell taxes, source verification. Returns score, band (safe/caution/warning/danger), and structured findings. Costs $0.05 in USDC.",
  {
    contract: z.string().describe("Token contract address"),
    chain: z.string().optional().describe("Chain. Default 'base'."),
  },
  async (args) => asText(await paidGet("/api/token/security", args)),
);

// hyperd.wallet.risk — sanctions + heuristic wallet risk ($0.10)
server.tool(
  "hyperd.wallet.risk",
  "Check a wallet's risk profile. Combines Chainalysis Sanctions Oracle (OFAC SDN authoritative) with GoPlus address heuristics (mixers, phishing, scams). Returns sanctioned flag + 0-100 heuristic score. Costs $0.10 in USDC.",
  {
    address: z.string().describe("0x EVM wallet address"),
    chain: z.string().optional().describe("Chain. Default 'base'."),
    deep: z.boolean().optional().describe("Cross-check across multiple chains. Default false."),
  },
  async (args) => asText(await paidGet("/api/risk/wallet", args)),
);

// hyperd.protocol.tvl — DefiLlama protocol health ($0.01)
server.tool(
  "hyperd.protocol.tvl",
  "Get a DeFi protocol's TVL, audits, chain distribution from DefiLlama. Pass slug for detail (e.g., 'aave', 'morpho-blue') or list=true for top 50. Costs $0.01 in USDC.",
  {
    slug: z.string().optional().describe("Protocol slug, e.g., 'aave' or 'morpho-blue'"),
    list: z.boolean().optional().describe("If true, returns top 50 protocols by TVL"),
  },
  async (args) => asText(await paidGet("/api/protocol/tvl", args)),
);

// hyperd.gas.estimate — gas oracle ($0.005)
server.tool(
  "hyperd.gas.estimate",
  "Get current gas price + base fee + tip percentiles for fast/standard/slow inclusion. Costs $0.005 in USDC.",
  {
    chain: z
      .enum(["base", "ethereum", "polygon", "arbitrum", "optimism", "avalanche", "bnb", "base-sepolia"])
      .optional()
      .describe("Chain. Default 'base'."),
  },
  async (args) => asText(await paidGet("/api/gas/estimate", args)),
);

// hyperd.dex.quote — multi-aggregator best DEX route ($0.02)
server.tool(
  "hyperd.dex.quote",
  "Get the best DEX swap route across multiple aggregators (Paraswap + 0x). Returns the highest output amount and per-source quotes. Costs $0.02 in USDC.",
  {
    from: z.string().describe("Source token symbol or contract address"),
    to: z.string().describe("Destination token symbol or contract address"),
    amount: z.string().describe("Decimal amount of source token"),
    chain: z.enum(["base", "ethereum", "polygon", "arbitrum", "optimism", "avalanche", "bnb"]).optional().describe("Chain. Default 'base'."),
    slippage: z.number().int().optional().describe("Max slippage in basis points. Default 50."),
    taker: z.string().optional().describe("Optional payer address for 0x quote (improves accuracy)"),
  },
  async (args) => asText(await paidGet("/api/dex/quote", args)),
);

// hyperd.wallet.persona — behavioral classification ($0.10)
server.tool(
  "hyperd.wallet.persona",
  "Classify a wallet's persona based on on-chain behavior. Returns one of: Trader, HODLer, MEV-bot, Whale, Smart-Money, Airdrop-Farmer, Compromised, Inactive — plus confidence and supporting signals. Costs $0.10 in USDC.",
  {
    address: z.string().describe("0x EVM wallet address"),
    chain: z
      .enum(["base", "ethereum", "polygon", "arbitrum", "optimism", "avalanche", "bnb"])
      .optional()
      .describe("Chain to analyze. Default 'base'."),
  },
  async (args) => asText(await paidGet("/api/wallet/persona", args)),
);

// hyperd.contract.audit — pre-trade contract security ($0.10)
server.tool(
  "hyperd.contract.audit",
  "Pre-trade contract security audit. Composes GoPlus + Sourcify + DefiLlama protocol recognition + on-chain heuristics into a single 0-100 risk score with structured findings. Use BEFORE interacting with any unfamiliar contract. Costs $0.10 in USDC.",
  {
    contract: z.string().describe("Contract address to audit"),
    chain: z
      .enum(["base", "ethereum", "polygon", "arbitrum", "optimism", "avalanche", "bnb"])
      .optional()
      .describe("Chain. Default 'base'."),
  },
  async (args) => asText(await paidGet("/api/contract/audit", args)),
);

// hyperd.governance.summarize — DAO proposal LLM summary ($0.10)
server.tool(
  "hyperd.governance.summarize",
  "Summarize a DAO governance proposal (Snapshot or Tally URL). Returns structured impact analysis: who benefits, who pays, recommended position. LLM-summarized. Costs $0.10 in USDC.",
  {
    proposal_url: z.string().describe("Snapshot or Tally proposal URL"),
  },
  async (args) => asText(await paidGet("/api/governance/summarize", args)),
);

// hyperd.sentiment.token — Farcaster sentiment ($0.05)
server.tool(
  "hyperd.sentiment.token",
  "Get a token's sentiment score (0-100) from recent Farcaster discussion. Returns score, band (very_negative to very_positive), volume, trend, sample casts. Costs $0.05 in USDC.",
  {
    token: z.string().describe("Token symbol or name"),
    window: z.string().optional().describe('Days (1-30) or "24h" / "7d". Default "24h".'),
  },
  async (args) => asText(await paidGet("/api/sentiment/token", args)),
);

// hyperd.liquidation.risk — cross-protocol lending liquidation health ($0.10)
server.tool(
  "hyperd.liquidation.risk",
  "Cross-protocol liquidation risk for a wallet's lending positions. Health factor, USD-at-risk, and recommendations across Aave V3, Compound v3, Spark Lend, and Morpho Blue. Pass chain='all' for cross-chain aggregate. Costs $0.10 in USDC.",
  {
    address: z.string().describe("0x EVM wallet address"),
    chain: z
      .enum(["base", "ethereum", "polygon", "arbitrum", "optimism", "avalanche", "bnb", "all"])
      .optional()
      .describe("Chain to check, or 'all' for cross-chain aggregate. Default 'base'."),
  },
  async (args) => asText(await paidGet("/api/liquidation/risk", args)),
);

// hyperd.wallet.anomaly — behavioral anomaly detection ($0.10)
server.tool(
  "hyperd.wallet.anomaly",
  "Wallet behavioral anomaly detection. Compares recent activity against the wallet's own 180-day baseline — surfaces tx-volume spikes, dormant-wakeup patterns, new-protocol interactions, counterparty diversification. Catches compromised hot wallets, dormant whales, MEV-bot strategy shifts. Costs $0.10 in USDC.",
  {
    address: z.string().describe("0x EVM wallet address"),
    chain: z
      .enum(["base", "ethereum", "polygon", "arbitrum", "optimism", "avalanche", "bnb"])
      .optional()
      .describe("Chain to analyze. Default 'base'."),
    window: z
      .string()
      .optional()
      .describe('Recent activity window. "24h", "7d", "30d", or bare integer days. Default "24h".'),
  },
  async (args) => asText(await paidGet("/api/wallet/anomaly", args)),
);

// hyperd.wallet.pnl — realized + unrealized P&L (FIFO/LIFO/HCFO) ($0.05)
server.tool(
  "hyperd.wallet.pnl",
  "Realized + unrealized P&L for a wallet over a time window. ERC-20 + native, single chain per call. Three cost-basis methods: FIFO (default, IRS standard), LIFO (last-in-first-out), HCFO (highest-cost-first-out, tax-loss-harvesting view). Per-token breakdown with weighted-avg cost + mark-to-market. Unpriced trades and untracked-proceeds gaps surfaced honestly under coverage.* fields. v1.0 defers per-tx gas-fee USD attribution. Costs $0.05 in USDC.",
  {
    address: z.string().describe("0x EVM wallet address"),
    chain: z
      .enum(["base", "ethereum", "polygon", "arbitrum", "optimism", "avalanche", "bnb"])
      .optional()
      .describe("Chain to compute P&L on. Default 'base'."),
    from: z.number().int().optional().describe("Window start, unix seconds. Default = to - 30 days. Must be >= 1577836800 (2020-01-01)."),
    to: z.number().int().optional().describe("Window end, unix seconds. Default = now. Cannot be > now+60."),
    method: z.enum(["fifo", "lifo", "hcfo"]).optional().describe("Cost-basis method. Default 'fifo'."),
  },
  async (args) => asText(await paidGet("/api/wallet/pnl", args)),
);

// hyperd.budget.guardian — agent spend visibility ($0.01)
server.tool(
  "hyperd.budget.guardian",
  "Agent spend visibility: aggregates recent outbound USDC transfers from a wallet over a configurable window (1h/24h/7d/30d). Returns total spend, by-destination breakdown, projected-24h rate, and an optional under_cap flag if cap_usd is provided. Use this BEFORE initiating the next paid x402 call to enforce a self-imposed budget. Bridged USDC.e variants are NOT counted. Costs $0.01 in USDC.",
  {
    address: z.string().describe("0x EVM wallet address"),
    chain: z
      .enum(["base", "ethereum", "polygon", "arbitrum", "optimism", "avalanche", "bnb"])
      .optional()
      .describe("Chain to compute spend on. Default 'base'."),
    window: z
      .enum(["1h", "24h", "7d", "30d"])
      .optional()
      .describe("Lookback window. Default '24h'."),
    cap_usd: z.number().positive().optional().describe("Optional self-imposed USDC cap. When provided, response includes under_cap, remainingUsd, and anyTxExceedsTenthOfCap."),
  },
  async (args) => asText(await paidGet("/api/budget/guardian", args)),
);

// hyperd.bundle — multi-call settlement ($0.20 fixed)
server.tool(
  "hyperd.bundle",
  "Bundle multiple paid GET calls into one x402 settlement. Up to 10 sub-calls executed in parallel (concurrency cap 4), per-call results returned in a structured envelope. Fixed $0.20 USDC — typically cheaper than à la carte for any combination summing > $0.24 individually. Best-effort execution: failed sub-calls don't refund in v1.0 (credit ledger planned for v1.1). Use this when you need 3+ paid calls and want to save on facilitator round-trips.",
  {
    calls: z
      .array(
        z.object({
          id: z.string().optional().describe("Caller-supplied id; echoed in result."),
          method: z.literal("GET").describe("Only GET sub-calls supported in v1.0."),
          path: z.string().describe("Endpoint path (e.g. /api/balance)."),
          query: z.record(z.unknown()).optional().describe("Query params for the sub-call."),
        }),
      )
      .min(1)
      .max(10)
      .describe("1-10 sub-calls. Each must target a bundleable paid GET endpoint."),
  },
  async (args) => asText(await paidWithBody("POST", "/api/bundle", args)),
);

// hyperd.watch.create — subscribe to a continuous watch ($3.00 prepaid)
server.tool(
  "hyperd.watch.create",
  "Subscribe to a continuous watch on a wallet/position. Returns watch_id and webhook_secret (shown ONCE — store it; we cannot recover it). HMAC-SHA256 signed alerts POSTed to your webhook_url when threshold conditions are met. v1.0 supports liquidation watches across Aave V3 / Compound v3 / Spark / Morpho. $3.00 USDC prepays for duration_days (default 30, max 90).",
  {
    type: z.literal("liquidation").describe("Watch type. v1.0 only supports 'liquidation'."),
    target_addresses: z
      .array(z.string())
      .min(1)
      .max(1)
      .describe("Wallet to watch (length-1 in v1.0; multi-target reserved for v1.1 Pro tier)."),
    target_chain: z
      .enum(["base", "ethereum", "polygon", "arbitrum", "optimism", "avalanche", "bnb"])
      .optional()
      .describe("Chain to watch. Default 'base'."),
    webhook_url: z.string().describe("HTTPS endpoint to POST alerts to. Must be publicly reachable; private/loopback IPs rejected."),
    fire_on_band_or_worse: z
      .enum(["safe", "caution", "warning", "critical"])
      .optional()
      .describe("Fire when health-factor band reaches this severity OR worse. Default 'warning'."),
    duration_days: z.number().int().min(1).max(90).optional().describe("Watch lifetime in days. Default 30, max 90."),
  },
  async (args) => asText(await paidWithBody("POST", "/api/watch/create", args)),
);

// hyperd.watch.list — list owner's active watches ($0.001 ops fee)
server.tool(
  "hyperd.watch.list",
  "List the active watches owned by your wallet. $0.001 USDC ops fee — covers the x402 auth path that proves wallet ownership (without it, the server can't tell which wallet is asking). webhook_secret is NEVER returned — store it from the create response.",
  {},
  async () => asText(await paidGet("/api/watch/list", {})),
);

// hyperd.watch.cancel — cancel an active watch ($0.001 ops fee)
server.tool(
  "hyperd.watch.cancel",
  "Cancel a watch you own. $0.001 USDC ops fee covers the x402 auth path. Returns 404 (not 403) if the watch_id doesn't exist OR if you're not the owner — no existence-leak side-channel.",
  {
    watch_id: z.string().describe("The watch_id returned from hyperd.watch.create."),
  },
  async (args) =>
    asText(await paidWithBody("DELETE", "/api/watch/cancel", undefined, { watch_id: args.watch_id })),
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
      `hyperD MCP server running (no wallet — only free tools available). Set HYPERD_WALLET_PRIVATE_KEY or HYPERD_WALLET_MNEMONIC to enable paid tools.`,
    );
  }
}

main().catch((err) => {
  console.error("hyperD MCP fatal error:", err);
  process.exit(1);
});
