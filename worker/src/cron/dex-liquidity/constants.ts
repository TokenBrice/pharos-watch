/**
 * DEX Liquidity Cron Config — Specific to the dex-liquidity scoring cron
 *
 * DefiLlama URLs, Curve chain configs, Uniswap V3 subgraph IDs,
 * Aerodrome queries, governance lookup, rate limits, TVL factors.
 *
 * Reusable DEX utilities (symbol maps, quality multipliers):
 * see ../../lib/dex-constants.ts
 */
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";

export const DEFILLAMA_YIELDS_URL = "https://yields.llama.fi/pools";
export const DEFILLAMA_PROTOCOLS_URL = "https://api.llama.fi/protocols";
export const CURVE_API_BASE = "https://api.curve.finance/v1/getPools/all";
export const CURVE_CHAINS = ["ethereum", "base", "arbitrum", "polygon"] as const;

// Uniswap V3 subgraph IDs per chain
export const UNIV3_SUBGRAPHS: Record<string, string> = {
  ethereum: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
  base: "FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS",
  arbitrum: "FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM",
  polygon: "3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm",
};

export const UNIV3_POOL_QUERY = `{
  pools(
    first: 1000,
    orderBy: totalValueLockedUSD,
    orderDirection: desc,
    where: { totalValueLockedUSD_gt: "10000" }
  ) {
    id
    token0 { id symbol }
    token1 { id symbol }
    feeTier
    totalValueLockedUSD
    volumeUSD
    token0Price
    token1Price
    totalValueLockedToken0
    totalValueLockedToken1
  }
}`;

export const AERODROME_SUBGRAPHS: Record<string, string> = {
  base: "GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM",
};

export const AERODROME_PAIR_QUERY = `{
  pairs(
    first: 500,
    orderBy: reserveUSD,
    orderDirection: desc,
    where: { reserveUSD_gt: "10000" }
  ) {
    id
    token0 { id symbol }
    token1 { id symbol }
    reserve0
    reserve1
    reserveUSD
    token0Price
    token1Price
    isStable
  }
}`;

/** Quality score for non-stablecoin pairing assets */
export const VOLATILE_PAIR_QUALITY: Record<string, number> = {
  WETH: 0.65, ETH: 0.65, STETH: 0.65, WSTETH: 0.65, RETH: 0.65,
  WBTC: 0.6, TBTC: 0.55, CBBTC: 0.6,
};

/** Symbol → governance type lookup from ACTIVE_STABLECOINS */
export const SYMBOL_GOVERNANCE = new Map<string, string>();
for (const meta of ACTIVE_STABLECOINS) {
  SYMBOL_GOVERNANCE.set(meta.symbol.toUpperCase(), meta.flags.governance);
}

export const CG_TICKERS_RATE_MS = 2500; // conservative: ~24 req/min well under free-tier limit
export const GT_TOKEN_POOLS_PAGE_SIZE = 20;
export const GT_TOKEN_POOLS_MAX_PAGES = 3;
export const CG_ONCHAIN_TOKEN_POOLS_PAGE_SIZE = 20;
export const CG_ONCHAIN_TOKEN_POOLS_MAX_PAGES = 3;

/**
 * Synthetic TVL factor for orderbook exchanges.
 * volume × factor = estimated standing order-book depth.
 * 3× assumes ~33% daily turnover, conservative for precious-metals markets.
 */
export const ORDERBOOK_TVL_FACTOR = 3;

/** CoinGecko coin IDs we accept as USD-equivalent quote assets */
export const USD_QUOTE_COIN_IDS = new Set([
  "tether", "usd-coin", "dai", "true-usd", "frax", "c1usd",
  "binance-usd", "paxos-standard",
]);

/** Per-chain timeout for subgraph queries (UniV3, Aerodrome) */
export const SUBGRAPH_PER_CHAIN_TIMEOUT_MS = 15_000;

/**
 * Confidence weight for DEX price observations by protocol.
 * Scales TVL weight in the TVL-weighted median to down-weight less reliable sources.
 *
 * Tier 1 (1.0): Primary scoring sources — exact match
 *   "curve", "uniswap-v3", "aerodrome"
 *
 * Tier 2 (0.85): Discovery-stage CoinGecko/GeckoTerminal — startsWith match
 *   "staged-cg_onchain-<dexId>"  (e.g., "staged-cg_onchain-raydium")
 *   "geckoterminal-<dexId>"      (e.g., "geckoterminal-uniswap_v3")
 *   "coingecko-<exchange>"       (e.g., "coingecko-binance")
 *
 * Tier 3 (0.55): DexScreener and CG tickers fallback — startsWith match
 *   "dexscreener-<dexId>"        (e.g., "dexscreener-raydium")
 *   "cg-ticker-<exchange>"       (e.g., "cg-ticker-kinesis")
 *   "staged-dexscreener-<dexId>"
 *   "staged-cg_tickers-<exchange>"
 *
 * Tier 4 (0.3): Unknown/unrecognized protocols — fallback
 *
 * startsWith is used for Tiers 2-3 because the crawl pipeline appends
 * source-specific dexId/exchange suffixes to the protocol string.
 */
export function dexPriceConfidenceForProtocol(protocol: string): number {
  if (
    protocol === "curve" || protocol === "uniswap-v3" || protocol === "aerodrome" ||
    protocol === "fluid" || protocol === "balancer" || protocol === "raydium" || protocol === "orca"
  ) return 1.0;
  if (
    protocol.startsWith("staged-cg_onchain") ||
    protocol.startsWith("geckoterminal") ||
    protocol.startsWith("coingecko")
  ) return 0.85;
  if (
    protocol.startsWith("dexscreener") ||
    protocol.startsWith("cg-ticker") ||
    protocol.startsWith("staged-dexscreener") ||
    protocol.startsWith("staged-cg_tickers")
  ) return 0.55;
  return 0.3;
}
