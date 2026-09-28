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
/**
 * Zero-volume provenance cutover (liquidity methodology 6.9). Before this clock,
 * the GeckoTerminal and DexScreener parsers and the v1 live-lane registry
 * write-back coerced an absent 24h volume to 0, so such a registry zero cannot be
 * told apart from a missing reading and the registry resolver treats it as
 * absent. Positive legacy readings stay usable. CoinGecko onchain rows are exempt
 * (see DEX_VOLUME_ZERO_PROVENANCE_EXEMPT_SOURCES). Set to the v6.9 Worker
 * activation, 2026-09-28 07:29:14 UTC. Inert once every earlier row is older than
 * the 72h volume admission window (after 2026-10-01 07:30 UTC); remove it then.
 */
export const DEX_VOLUME_ZERO_PROVENANCE_SINCE_SEC = 1_790_580_554;
/**
 * Registry sources whose pre-cutover zeros are trusted as measured. The old CoinGecko
 * onchain parser coerced only an absent field to 0, and a 600-pool live sample on
 * 2026-09-28 found 1 absent field against 187 explicit zeros, all with zero 24h trades.
 * The stale-first refresh re-reads every CoinGecko onchain row within about 20h
 * under the explicit zero-trades rule, so any rare legacy absent value is short-lived.
 */
export const DEX_VOLUME_ZERO_PROVENANCE_EXEMPT_SOURCES: Readonly<Record<string, true>> = { cg_onchain: true };
/**
 * Registry sources whose usable stored 24h zero is trade-verified (liquidity v6.92
 * dead-pool floor). The CoinGecko onchain intake (`cgPoolVolume24hReading`, used
 * by the token-pool crawl and the stale-pool refresh) stores 0 only when the
 * provider publishes an explicit zero volume and zero 24h buys and sells.
 * Pre-cutover CoinGecko onchain zeros carry the same trust through
 * DEX_VOLUME_ZERO_PROVENANCE_EXEMPT_SOURCES (187 of 188 sampled were explicit
 * zeros with zero trades); the resolver has already discarded every zero that is
 * not a usable reading. The GeckoTerminal parser stores any explicit "0" without a
 * trade-count check, and DeFiLlama and direct APIs publish 0 for venues they
 * under-index, so their zeros are measured but not trade-verified.
 */
export const DEX_VOLUME_TRADE_VERIFIED_ZERO_SOURCES: Readonly<Record<string, true>> = { cg_onchain: true };

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
  // 2026-09-27: replaced FUbEPQw1… (deployment QmawEzRNeDyaTgjPKb1eRrbyzxczgSHUYzvTMaMnN8jyuh),
  // which serves the Messari subgraph-standard schema (`liquidityPools`, no
  // `pools` field), so the native-schema page query below can never answer;
  // every run since 2026-09-22 16:10 UTC (when the failed-source flag made it
  // visible) recorded `univ3-subgraph:base`. The pinned replacement is the
  // "Uniswap V3 Base" network subgraph (deployment
  // Qmb4VUcAY9LsVgeCuCCMs7X1XrkbRcaiuAbSK8SqhmsAfP), which serves the native
  // schema and answered the exact production query with 1000 pools including
  // every tracked Base stablecoin pool above the $50K observation floor.
  base: "43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG",
  arbitrum: "FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM",
  polygon: "3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm",
  // 2026-09-28: replaced ESdrTJ3t… ("Uniswap V3 Celo", deployment
  // QmXfJmxY7C4A4UoWEexvei8XzcSxMegr78rt3Rzz8szkZA), which reports
  // `hasIndexingErrors: true` and whose serving indexers time out, answer
  // HTTP 400, or refuse attestation (`indexing_error`) for any TVL-filtered or
  // TVL-ordered pool page, so every run since 2026-09-22 recorded
  // `univ3-subgraph:celo`. No native-schema Celo deployment serves this query,
  // so the pin moved to the healthy Messari-standard "Uniswap V3 Celo"
  // subgraph (deployment QmNi5byczejWFdvpK1ihgaQ1qo1owznhNMFQQLSu9aWUQQ, no
  // indexing errors, every pool with liquidity answered in one sub-second
  // page), read through `buildUniV3MessariPoolQuery` and normalized back to
  // the native pool shape (see `UNIV3_MESSARI_SCHEMA_CHAINS`).
  celo: "8cLf29KxAedWLVaEqjV8qKomdwwXQxjptBZFrqWNH5u2",
  bsc: "F85MNzUGYqgSHSHRGgeVMNsdnW1KtZSVgFULumXRZTw2",
};

// The Graph caps `first` at 1000 per page; paginate via `skip` to reach pools
// beyond the first page (queries are ordered by TVL desc, so deeper pages hold
// strictly lower-TVL pools).
export const UNIV3_POOL_PAGE_SIZE = 1000;
export const UNIV3_POOL_MAX_PAGES = 5;

/**
 * The Base Uni V3 lane reads exactly one page. The 2026-09-27 replacement
 * deployment answers a full 1000-pool page in a measured 7.8-8.8s, and the
 * family's per-chain timeout (`SUBGRAPH_PER_CHAIN_TIMEOUT_MS`, 15s) covers
 * every page of a chain with one shared signal, so a second page would abort
 * the whole chain mid-run and discard its observations. The TVL-desc page
 * already contains every tracked Base stablecoin pool above the $50K
 * observation floor (probed 2026-09-27: 124 tracked pools, of which the
 * second page added zero), so the unmeasured tail is below every admission
 * floor anyway.
 */
export const UNIV3_BASE_POOL_MAX_PAGES = 1;

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

/** TVL floor for Uni V3 subgraph rows (native query filter; Messari rows client-side). */
export const UNIV3_POOL_MIN_TVL_USD = 10_000;

export const buildUniV3PoolQuery = (skip: number): string => `{
  pools(
    first: ${UNIV3_POOL_PAGE_SIZE},
    skip: ${skip},
    orderBy: totalValueLockedUSD,
    orderDirection: desc,
    where: { totalValueLockedUSD_gt: "${UNIV3_POOL_MIN_TVL_USD}" }
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
 * Uni V3 chains whose pinned subgraph serves the Messari subgraph-standard
 * schema (`liquidityPools`) instead of the native `Uniswap/v3-subgraph`
 * schema. These chains read `buildUniV3MessariPoolQuery` and normalize each
 * pool back to the native shape before the shared mapping runs.
 */
export const UNIV3_MESSARI_SCHEMA_CHAINS: Readonly<Record<string, true>> = { celo: true };

/**
 * Messari-schema pool page. The deployment's USD valuations are unreliable
 * (2026-09-28 on Celo: USD₮ at ~$4.84, USDC at $0), so the query neither
 * filters nor orders by `totalValueLockedUSD`: it pages every pool with
 * liquidity in stable `id` order, and the normalizer applies
 * `UNIV3_POOL_MIN_TVL_USD` to a balance-derived TVL instead. `inputTokens` is
 * `[token0, token1]`, the fee tier is the `FIXED_TRADING_FEE` percentage, and
 * the spot price is derived from `tick`.
 */
export const buildUniV3MessariPoolQuery = (skip: number): string => `{
  liquidityPools(
    first: ${UNIV3_POOL_PAGE_SIZE},
    skip: ${skip},
    orderBy: id,
    orderDirection: asc,
    where: { totalLiquidity_gt: "0" }
  ) {
    id
    inputTokens { id symbol decimals }
    inputTokenBalances
    fees { feeType feePercentage }
    tick
    totalValueLockedUSD
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
  // 2026-09-27: replaced CHz2jQ8g… (deployment QmaoSfxT45Q3tKnQEcmCACRFKpv8SogxEcZ4kAvRDmgnrU),
  // whose only serving indexer (0xf92f430d…) answers non-JSON after ~15s, so
  // every run since 2026-09-22 recorded `uniswap-v4-subgraph:base`. The pinned
  // replacement is the actively curated "uniswap-v4-base-3" network subgraph
  // (deployment Qmbsc6XQWbiv4DfLVfaNciScqYLyDWUYjWzrFBbzzmRsMB, highest-signalled
  // Uniswap V4 deployment): identical pool set (same pool ids/hook/liquidity
  // rows probed side by side) at 1.5-2.7s per 1000-pool page instead of 15s.
  base: "Gqm2b5J85n1bhCyDMpGbtbVn4935EvvdyHdHrx3dibyj",
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
