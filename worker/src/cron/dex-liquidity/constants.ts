/**
 * DEX Liquidity Cron Config — Specific to the dex-liquidity scoring cron
 *
 * DefiLlama URLs, Curve chain configs, Uniswap V3 subgraph IDs,
 * Aerodrome queries, governance lookup, rate limits, TVL factors.
 *
 * Reusable DEX utilities (symbol maps, quality multipliers):
 * see ../../lib/dex-constants.ts
 */
import { WORKER_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { CURVE_NATIVE_DISCOVERY_CHAINS } from "@shared/lib/dex-deployment-coverage";
import type { LiquidityPoolSourceFamily } from "@shared/types/market";

export const DEFILLAMA_YIELDS_URL = "https://yields.llama.fi/pools";
export const DEFILLAMA_PROTOCOLS_URL = "https://api.llama.fi/protocols";
export const CURVE_API_BASE = "https://api.curve.finance/v1/getPools/all";
// The shared census-provider set is the source of truth for Curve's fetch
// list. Preserve its insertion order because payloads are index-aligned with
// this array in fetch-primary and its persisted joins.
export const CURVE_CHAINS = [...CURVE_NATIVE_DISCOVERY_CHAINS] as const;
/**
 * Curve addresses Gnosis by its legacy `xdai` network name (verified
 * 2026-07-29: `/all/xdai` returns pool data, `/all/gnosis` returns an error).
 * Every other chain requests the endpoint with the Pharos chain id verbatim,
 * which is also the key the join writes into the Curve pool map.
 */
export const CURVE_API_CHAIN_PATHS: Record<string, string> = { gnosis: "xdai" };
export const DEX_LIQUIDITY_POOL_MIN_TVL_USD = 10_000;

// Uniswap V3 subgraph IDs per chain. Chain expansion is measured-execution
// coupled: adding a chain here only turns that chain's DeFiLlama `uniswap-v3`
// rows from `measured-execution:target-unresolved` into targets that still fail
// closed at `quote-missing` until a reviewed QuoterV2 deployment for the chain
// is pinned in ../measured-execution/registry.ts and ratified, so a chain added
// alone moves reason codes without adding exit-route coverage. Every added
// chain also joins this family's bounded per-chain fan-out, the cost that
// retired the Optimism lane (docs/dex-liquidity.md). BSC is intentionally the
// sixth and final source in this family; at most five requests run in parallel,
// and BSC publishes shadow-only targets until a later evidence-gated activation
// review.
export const UNIV3_SUBGRAPHS: Record<string, string> = {
  ethereum: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
  base: "FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS",
  arbitrum: "FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM",
  polygon: "3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm",
  celo: "ESdrTJ3twMwWVoQ1hUE2u7PugEHX3QkenudD6aXCkDQ4",
  bsc: "F85MNzUGYqgSHSHRGgeVMNsdnW1KtZSVgFULumXRZTw2",
};

// The Graph caps `first` at 1000 per page; paginate via `skip` to reach pools
// beyond the first page (queries are ordered by TVL desc, so deeper pages hold
// strictly lower-TVL pools).
export const UNIV3_POOL_PAGE_SIZE = 1000;
export const UNIV3_POOL_MAX_PAGES = 5;

/**
 * Hard per-response byte cap for one subgraph page, shared by the bounded
 * Uni V3 / Uniswap V4 family pages (`first: 1000`) and the PancakeSwap pages.
 *
 * Justification (measured 2026-09-23, see `docs/worker-and-api-limits.md#response-body-limits`):
 * the same 1,000-row page budget measured 2.0 MB (Raydium concentrated) and
 * 1.0 MB (Meteora, 500 rows) against real provider responses, i.e. the
 * legitimate page for these 14-field pool queries is around 0.5-1 MB. 8 MiB
 * leaves roughly an order of magnitude of headroom for schema growth while
 * keeping a mis-served response (HTML error page, doubled body) from being
 * buffered and parsed inside the 128 MB isolate.
 */
export const SUBGRAPH_PAGE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export const buildUniV3PoolQuery = (skip: number): string => `{
  pools(
    first: ${UNIV3_POOL_PAGE_SIZE},
    skip: ${skip},
    orderBy: totalValueLockedUSD,
    orderDirection: desc,
    where: { totalValueLockedUSD_gt: "10000" }
  ) {
    id
    token0 { id symbol decimals }
    token1 { id symbol decimals }
    feeTier
    totalValueLockedUSD
    volumeUSD
    token0Price
    token1Price
    totalValueLockedToken0
    totalValueLockedToken1
  }
}`;

/**
 * Official Uniswap V4 Ethereum subgraph deployment:
 * https://developers.uniswap.org/api/subgraph/subgraphs-devs/deployments
 *
 * The non-Ethereum sources are published by the same Uniswap Graph account and
 * feed target-review evidence only. Their runtime deployments remain outside
 * active scoring until independently pinned code identities survive shadow.
 */
export const UNISWAP_V4_SUBGRAPHS: Record<string, string> = {
  ethereum: "DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G",
  base: "CHz2jQ8g62rewnrMyGF9yHktmkGjMwKBw4rVx82E64Um",
  arbitrum: "EpEZyTnADuwvqpMh7vcTPFHDN3MwqiUN9QHapCBPbRWW",
  polygon: "2CB2uQxcDKWDenagn2z17KQVCtfwSx5eXYuvqTciRTJu",
  bsc: "EAq1nJKgjnuKH6Gj4RFjCW7LcL7E2uipbncdwV7TTWkX",
};

export const UNISWAP_V4_POOL_PAGE_SIZE = 1000;
export const UNISWAP_V4_POOL_MAX_PAGES = 5;

export const buildUniswapV4PoolQuery = (skip: number): string => `{
  pools(
    first: ${UNISWAP_V4_POOL_PAGE_SIZE},
    skip: ${skip},
    orderBy: totalValueLockedUSD,
    orderDirection: desc,
    where: { totalValueLockedUSD_gt: "10000" }
  ) {
    id
    token0 { id symbol decimals }
    token1 { id symbol decimals }
    feeTier
    tickSpacing
    hooks
    liquidity
    totalValueLockedUSD
    token0Price
    token1Price
  }
}`;

/** Quality score for non-stablecoin pairing assets */
export const VOLATILE_PAIR_QUALITY: Record<string, number> = {
  WETH: 0.65,
  ETH: 0.65,
  STETH: 0.65,
  WSTETH: 0.65,
  RETH: 0.65,
  WBTC: 0.6,
  TBTC: 0.55,
  CBBTC: 0.6,
};

/** Symbol → governance type lookup from the active Worker runtime registry. */
export const SYMBOL_GOVERNANCE = new Map<string, string>();
for (const meta of WORKER_ACTIVE_STABLECOINS) {
  SYMBOL_GOVERNANCE.set(meta.symbol.toUpperCase(), meta.governance);
}

export const CG_TICKERS_RATE_MS = 2500; // conservative: ~24 req/min well under free-tier limit
export const GT_TOKEN_POOLS_PAGE_SIZE = 20;
export const GT_TOKEN_POOLS_MAX_PAGES = 3;
export const CG_ONCHAIN_TOKEN_POOLS_PAGE_SIZE = 20;
export const CG_ONCHAIN_TOKEN_POOLS_MAX_PAGES = 3;

/**
 * Synthetic TVL factor for orderbook exchanges.
 * volume × factor = estimated standing order-book depth when measured depth
 * is unavailable, and an upper bound when CoinGecko 2% depth is available.
 * 3× assumes ~33% daily turnover, conservative for precious-metals markets.
 */
export const ORDERBOOK_TVL_FACTOR = 3;

/** CoinGecko coin IDs we accept as USD-equivalent quote assets */
export const USD_QUOTE_COIN_IDS = new Set([
  "tether",
  "usd-coin",
  "dai",
  "true-usd",
  "frax",
  "c1usd",
  "binance-usd",
  "paxos-standard",
]);

/** Per-chain timeout for subgraph queries */
export const SUBGRAPH_PER_CHAIN_TIMEOUT_MS = 15_000;

/**
 * Default per-family chain fan-out. Six reviewed sources still fit the
 * five-connection source-stage budget because the final chain is only
 * scheduled once a prior response has released its header-wait slot.
 */
export const SUBGRAPH_FAMILY_MAX_CONCURRENCY = 5;

/**
 * Confidence weight for DEX price observations by source family.
 * Scales TVL weight in the TVL-weighted median to down-weight less reliable
 * source families without trusting protocol labels supplied by fallback feeds.
 */
export function dexPriceConfidenceForSourceFamily(
  sourceFamily: LiquidityPoolSourceFamily | string | null | undefined,
): number {
  if (sourceFamily === "dl" || sourceFamily === "direct_api") return 1.0;
  if (sourceFamily === "cg_onchain" || sourceFamily === "gecko_terminal") return 0.85;
  if (sourceFamily === "dexscreener" || sourceFamily === "cg_tickers" || sourceFamily === "horizon") return 0.55;
  return 0.3;
}
