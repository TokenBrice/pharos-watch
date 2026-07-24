import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

// Versioning convention (see compareMethodologyVersions in
// @shared/lib/methodology-versions/base): each dotted segment is compared as an
// INTEGER, not a decimal fraction — so the minor segment is an open-ended integer
// counter within the v5 bucket, e.g. `5.0` ([5, 0]) < `5.8` ([5, 8]) < `5.81`
// ([5, 81]). Routine liquidity-score changes bump the minor counter (and may
// extend to `5.811`, `5.812`, … without ever needing v6) and stay in this file.
// Create a new `v6.ts` (and a sibling vN file array) only for a genuine
// major/breaking change to the liquidity-score methodology, not merely to roll the
// counter over. Entries below are newest-first by version.
export const LIQUIDITY_SCORE_V5: readonly MethodologyChangelogEntry[] = [
  {
    version: "5.88",
    title: "Exact-route continuity and Base Slipstream execution",
    date: "2026-07-24",
    effectiveAt: 1784851200,
    summary:
      "Reviewed Base Aerodrome Slipstream pools can contribute factory-bound QuoterV2 execution profiles, while mature fresh routes remain available to the Safety Score V9 exact-route envelope across bounded pool-shortlist rotation.",
    impact: [
      "Activation is limited to the reviewed Base Aerodrome Slipstream factory and QuoterV2 runtimes; Optimism Uniswap V3, Solana CLMM, SunSwap, Fluid, and other unratified cohorts remain shadow-only",
      "Every accepted profile must prove the retained pool through the factory's exact token and signed tick-spacing binding and pass independent generation, identity, price, freshness, curve, and retained-TVL validation",
      "Mature fresh last-known-good profiles can remain in the bounded route-only observation set across a temporary liquidity shortlist rotation without changing aggregate TVL, volume, visible pools, price consensus, target publication, or V8 liquidity scoring",
      "Missing, stale, price-drifted, malformed, or identity-mismatched profiles remain capability-gated; aggregate liquidity is never substituted as executable depth",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.87",
    title: "Base Aerodrome volatile exact execution",
    date: "2026-07-22",
    effectiveAt: 1784678400,
    summary:
      "Classic volatile pools from the existing Base Aerodrome census can publish exact constant-product execution models after deployment-specific same-block verification.",
    impact: [
      "Only census-confirmed classic Base Aerodrome pools with stable=false are eligible; generic Solidly support and Avalanche, Linea, or Sonic deployments remain out of scope",
      "Each candidate requires reviewed factory and implementation runtimes, exact factory getPool(token0, token1, false) binding, pool stable=false, and an unpaused factory at one pinned block",
      "The model uses the pool's same-block dynamic fee; any runtime, identity, pause-state, fee, reserve, or price failure remains capability-gated instead of inheriting executable depth",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.86",
    title: "Canonical V2 pool retention and exact execution",
    date: "2026-07-22",
    effectiveAt: 1784678400,
    summary:
      "PancakeSwap V2 discovery is no longer rejected by the V3 authoritative inventory, and reviewed Ethereum Uniswap V2 and BSC PancakeSwap V2 pools can publish factory-verified constant-product execution models.",
    impact: [
      "Incomplete paginated authoritative inventories now fail open, while complete PancakeSwap V3 authority remains scoped to concentrated-liquidity rows instead of suppressing V2 pools",
      "Ethereum Uniswap V2 and BSC PancakeSwap V2 candidates require a pinned canonical factory runtime, exact getPair binding, and same-block token-order, reserve, and decimals reads before becoming score-eligible",
      "Other V2 forks and any identity, factory, reserve, or price failure remain shaped or capability-gated evidence rather than inheriting executable depth",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.85",
    title: "Raydium pool-implied counter-asset reference",
    date: "2026-07-20",
    effectiveAt: 1784505600,
    summary:
      "Raydium standard AMM pools now complete exact reserve capture when the untracked counter asset's USD reference is implied from the pool's own captured spot price instead of gating to incomplete-exact-capture.",
    impact: [
      "Roughly 460 retained Raydium standard pools (USDC, USDT, USD1 pairs) move from capability-gated rows to exact constant-product execution models with score-eligible reserve-based simulations",
      "USD1 gains its first score-eligible Solana exit routes; USDC and USDT gain substantially deeper Solana route surfaces",
      "Counter-asset references derived this way are recorded as referencePriceSource \"pool-implied\"; token-identity and balance failures still fail closed to incomplete-exact-capture",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.84",
    title: "Composite Curve LP pair-quality normalization",
    date: "2026-06-29",
    effectiveAt: 1782691200,
    summary:
      "Composite Curve LP quote tokens such as 3Crv and FRAXBP now inherit the best pair-quality score of their underlying stablecoin basket instead of falling back to the unknown-token haircut.",
    impact: [
      "LUSD/3Crv-style metapools no longer treat the 3Crv quote side as an unknown token for effective TVL and pool-stress calculations",
      "Composite quote aliases continue to flow through the existing balance-health haircut, so one-sided pools remain penalized for imbalance while no longer receiving an additional unknown-token penalty",
      "The change applies to all configured composite pool aliases rather than special-casing one stablecoin",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.83",
    title: "Top-asset recovery guard quality baseline",
    date: "2026-06-19",
    effectiveAt: 1781899200,
    summary:
      "The top-asset coverage guard now discounts previously published rows whose raw TVL was dominated by near-zero effective liquidity before deciding whether a recovery run must fail hard.",
    impact: [
      "Large malformed rows removed by the retained-pool anti-poisoning gate no longer strand the public dataset behind an inflated raw-TVl baseline",
      "The raw top-10 covered TVL remains in cron metadata, while the guard uses an additional quality-adjusted top-10 guard TVL for near/hard threshold decisions",
      "True top-asset coverage collapses still fail hard when the previous baseline had meaningful effective liquidity",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.82",
    title: "Large zero-volume pool retention hardening",
    date: "2026-06-19",
    effectiveAt: 1781827200,
    summary:
      "Large retained pools must clear the minimum 24-hour volume floor even when a source marks volume as unmeasured.",
    impact: [
      "Pools above the large-pool TVL threshold are dropped when 24-hour volume is below the minimum-volume floor regardless of the volumeMeasured diagnostic flag",
      "Pool-state-only direct sources can still expand coverage with smaller eligible pools, but large zero-volume rows no longer bypass the retained-pool anti-poisoning guard",
      "Volume-to-TVL outlier checks, blocked-DEX filtering, protocol caps, and post-filter aggregate rebuilds continue to run around the stricter retained-pool gate",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.81",
    title: "Unsupported-chain Curve fallback coverage",
    date: "2026-06-14",
    effectiveAt: 1781395200,
    summary:
      "Fallback pool discovery can now retain Curve pools on chains not covered by the native Curve API, while still skipping fallback Curve rows where native Curve enrichment already owns the chain.",
    impact: [
      "GeckoTerminal and CoinGecko Onchain Curve pools remain skipped on Ethereum, Base, Arbitrum, and Polygon to avoid duplicate Curve API coverage",
      "Curve pools on unsupported native-API chains such as Plasma can now contribute retained liquidity, challenger-pool evidence, and DEX price observations after the normal TVL, price sanity, protocol-cap, and dedupe gates",
      "This lets single-chain assets such as Yuzu USD surface Plasma Curve liquidity evidence instead of depending only on aggregator prices when the native Curve API has no chain coverage",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.8",
    title: "Retained-pool DEX price ownership hardening",
    date: "2026-06-06",
    effectiveAt: 1780704000,
    summary:
      "DEX implied-price publication now reapplies the documented $50K retained-pool price floor and weights medians by source family instead of protocol labels.",
    impact: [
      "Retained pools below the $50K DEX price-observation floor can still contribute to liquidity scoring when otherwise eligible, but no longer publish dex_price_usd or price_sources_json rows",
      "DEX price median weighting now uses canonical source families: DeFiLlama and direct API at 1.0, CoinGecko Onchain and GeckoTerminal at 0.85, DexScreener and CoinGecko tickers at 0.55",
      "Fallback rows that claim high-trust protocol names can no longer receive primary-source median weight solely from the protocol label",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.7",
    title: "Peg-aware staged discovery price gate",
    date: "2026-05-20",
    effectiveAt: 1779235200,
    summary:
      "Secondary discovery pools now need a plausible tracked-token price before their TVL can be staged or merged into Liquidity Score aggregates.",
    impact: [
      "CoinGecko Onchain and GeckoTerminal pool rows whose tracked-token price fails the existing peg-aware DEX observation sanity gate are rejected before staging",
      "Already-staged rows with implausible tracked-token prices are skipped during scoring merge, so malformed discovery rows cannot inflate coin or global TVL until their staging TTL expires",
      "Carbon DeFi chain-suffixed secondary-source ids now normalize to the DefiLlama `carbon-defi` protocol cap, adding a cap-level backstop for Carbon rows",
      "Rows without a measured token price still flow through the existing TVL, volume, dedupe, protocol-cap, and retained-pool quality gates",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.6",
    title: "Staged discovery TVL sanity ceiling",
    date: "2026-05-07",
    effectiveAt: 1778144000,
    summary:
      "Secondary discovery rows now reject impossible pool TVL before staging and skip any already-staged over-cap row during the scoring merge.",
    impact: [
      "CoinGecko Onchain, GeckoTerminal, DexScreener, and CoinGecko ticker staging can no longer persist non-finite, negative, or over-cap TVL values",
      "The scoring cron skips legacy staged rows above the same sanity ceiling before they can affect global TVL, coverage drift, or DEX price observations",
      "Valid high-liquidity pools below the ceiling continue through the existing dedupe, protocol-cap, and retained-pool quality gates",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.5",
    title: "Absolute TVL Depth fallback recalibration and Slipstream sqrt_ratio price",
    date: "2026-04-17",
    effectiveAt: 1776384000,
    summary:
      "Absolute TVL Depth fallback (used when circulatingUsd is unavailable) now shares the ratio formula's anchor via a $1B implied reference mcap. Aerodrome/Velodrome Slipstream price derivation now uses on-chain sqrt_ratio (Q64.96) instead of total-reserve ratios for concentrated liquidity pools.",
    impact: [
      "Absolute TVL Depth fallback: `20 * log10(tvl / 100_000) + 20` → `35 * log10(tvl / 700_000)`; coins without market cap data no longer gain ~24 points of unearned TVL Depth",
      "Aerodrome/Velodrome Slipstream price observations now derive from on-chain sqrt_ratio instead of reserve ratios; concentrated liquidity pools no longer emit biased spot prices when one side lacks a tracked USD price",
      "Slipstream pools where sqrt_ratio is unusable and one side has no tracked price are now dropped entirely (no reserve-ratio fallback derivation)",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.4",
    title: "Curve enrichment scoping and staged UUID dedupe",
    date: "2026-04-14",
    effectiveAt: 1776165200,
    summary:
      "Curve API enrichment is now scoped to Curve DeFiLlama rows, and staged exact pool-id rows can dedupe against a single identity-poor DeFiLlama UUID row through the same narrow optional-metadata wildcard used by primary dedupe.",
    impact: [
      "Non-Curve DeFiLlama pools that share token symbols with a Curve pool no longer inherit Curve registry metadata, balance ratios, token prices, or metapool-adjusted TVL",
      "CoinGecko/GeckoTerminal provider ids with underscores or provider suffixes normalize to the same canonical protocol family as DeFiLlama ids during pool-identity construction",
      "Staged discovery now skips a staged exact pool-id row when it uniquely matches one primary DeFiLlama UUID row by chain, protocol, token set, and pool-shape family, while ambiguous same-pair staged buckets still remain separate",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.3",
    title: "PancakeSwap trailing-hour volume window",
    date: "2026-04-08",
    effectiveAt: 1775613600,
    summary:
      "PancakeSwap V3 direct volume now sums the official `poolHourDatas.volumeUSD` buckets across a bounded trailing 24-hour window instead of treating the latest `poolDayDatas` row as if it were a rolling 24h metric.",
    impact: [
      "Intraday PancakeSwap volume no longer collapses toward zero until UTC rollover just because the current day bucket has only accumulated partial activity",
      "Fresh non-swap day buckets can no longer zero out yesterday's still-relevant trading activity, because trailing volume now comes from summed hourly swap buckets",
      "The PancakeSwap direct fetch keeps bounded batching under The Graph row cap while staying on official subgraph entities instead of adding a new historical block lookup dependency",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.2",
    title: "Orderbook ticker contract refresh and Balancer exact-address identity",
    date: "2026-04-08",
    effectiveAt: 1775606400,
    summary:
      "CoinGecko orderbook fallback now ignores the deprecated `trust_score` field and validates tickers by observable freshness/price/volume fields, while Balancer direct pools now use the API's exact pool address for identity instead of the 32-byte vault pool id.",
    impact: [
      "CoinGecko tickers fallback and discovery staging no longer drop every post-March-2026 ticker row just because CoinGecko now returns `trust_score = null`",
      "Orderbook fallback ticker intake now requires finite USD price/volume plus a stable exchange identifier, improving sanitization without depending on deprecated metadata",
      "Balancer direct API pools now reserve and dedupe by the true pool address, restoring exact-id confirmation against staged discovery and overlap checks",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.1",
    title: "Authoritative protocol confirmation for staged discovery",
    date: "2026-04-07",
    effectiveAt: 1775520000,
    summary:
      "Staged discovery rows can no longer invent new pools inside protocol families that already have a clean protocol-native direct source. When that authoritative fetch succeeds on a supported chain, staged rows must match one of its exact pool ids or they are excluded.",
    impact: [
      "GeckoTerminal, CoinGecko Onchain, and DexScreener staging rows that claim Balancer, Fluid, Raydium, Orca, Meteora, PancakeSwap, Aerodrome, or Velodrome liquidity now require authoritative exact-id confirmation when the matching direct fetch succeeded cleanly on that chain",
      "The guard fails open when the authoritative source is unavailable or degraded, so discovery sources still recover coverage during native-source incidents instead of hard-zeroing the row",
      "Liquidity cron metadata now records `stagedPoolsSkippedByAuthoritativeProtocol` separately from exact-id and derived-identity dedupe skips",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.0",
    title: "Size-aware scoring: relative TVL depth, recalibrated volume, quality retention",
    date: "2026-04-05",
    effectiveAt: 1775347200,
    summary:
      "All scoring dimensions are now size-independent. TVL Depth measures effective TVL relative to market cap instead of absolute dollar value. Volume Activity has a recalibrated curve with a realistic ceiling (tops out at ~32% V/T instead of ~500%). Pool Quality measures venue quality retention ratio (qualityAdjustedTvl / totalTvl, rescaled) instead of absolute quality-adjusted TVL. Weights rebalanced to 30/20/20/20/10.",
    impact: [
      "TVL Depth uses effective-TVL-to-market-cap ratio on a log scale (35 × log10(ratio / 0.0007)), with absolute fallback for coins without market cap data",
      "Volume Activity recalibrated: 38 × (log10(V/T) + 3) — zero line at 0.1% V/T, tops at ~32% V/T. USDC/USDT now score 86-90 instead of 52-56",
      "Pool Quality measures quality retention (qualityAdjustedTvl / totalTvl, rescaled from 15-80% range to 0-100). Fully size-independent",
      "Weights rebalanced from 35/20/22.5/15/7.5 to 30/20/20/20/10 — structural quality (Pool Quality + Durability = 40%) now matches depth + activity (50%)",
      "Coins like BOLD and LUSD with high relative depth ratios see significant score improvements; large-cap coins with low relative depth see depth dimension scores decrease but compensate through volume, durability, and diversity",
    ],
    commits: [],
    reconstructed: false,
  },
];
