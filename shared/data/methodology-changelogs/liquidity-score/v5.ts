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
    version: "5.98",
    title: "Trust-filtered DEX primary-price handoff",
    date: "2026-07-31",
    effectiveAt: 1785456000,
    summary:
      "The DEX scoring consumer now treats the staged primary-price map as an authoritative trust-filtered input instead of backfilling omitted assets from the broader stablecoin cache.",
    impact: [
      "Assets intentionally omitted from the trust-filtered primary-price handoff can still publish their DEX-implied median and source aggregates, but primary price and primary-relative deviation fields remain null",
      "Untrusted or low-confidence primary references can no longer re-enter DEX price publication solely because an observed DEX asset was missing from the staged map",
      "DEX weighted medians, retained-pool price sources, aggregate liquidity, visible pool selection, target publication, V8 liquidity scoring, and Safety Score V9 route inputs are unchanged",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.97",
    title: "Retired Optimism Uniswap V3 shadow lane",
    date: "2026-07-29",
    effectiveAt: 1785283200,
    summary:
      "The Optimism Uniswap V3 subgraph and QuoterV2 measured-execution lane are removed from the maintained DEX source roster after the owner accepted clean retirement.",
    impact: [
      "Uniswap V3 subgraph enrichment now covers Ethereum, Base, Arbitrum, and Polygon; Optimism no longer contributes source-stage UniV3 pools, price observations, or measured-execution targets",
      "The reviewed Optimism QuoterV2 deployment is no longer scheduled for evidence collection; stale persisted profiles fail deployment validation instead of remaining shadow evidence",
      "Other Optimism liquidity lanes, including Curve, Balancer, and Velodrome Slipstream, are unchanged",
      "Current score-eligible exact-route cohorts are unchanged: Ethereum, Polygon, and Arbitrum Uniswap V3; Base, BSC, and Ethereum PancakeSwap V3; and Base Aerodrome Slipstream",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.96",
    title: "Capacity-dominant bounded route selection",
    date: "2026-07-28",
    effectiveAt: 1785224355,
    summary:
      "The private executable-route candidate set is now evaluated at the $25M/200 bps V9 stress point before ten public observations are selected, with diversity quotas and a still-fresh asset-level churn hold.",
    impact: [
      "The bounded payload guarantees the strongest executable-capacity route, the strongest exact reserve-model fallback, and an independent chain/protocol route when one exists",
      "Measured evidence no longer outranks a materially deeper exact route solely because its evidence tier is nominally stronger; per-chain, protocol, and adapter quotas prevent one common mode from occupying the route set",
      "If unexplained route-set churn cuts an asset's best stress capacity below half of a still-fresh prior set with at least $100K capacity, only that asset retains the prior route observations until confirmation or expiry",
      "SunSwap V2 returns to shadow-only collection while its production score impact is revalidated; aggregate liquidity, price consensus, visible pools, and V8 scoring remain unchanged",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.95",
    title: "Pinned SunSwap V2 direct-route fallback",
    date: "2026-07-28",
    effectiveAt: 1785196800,
    summary:
      "A canonical SunSwap V2 pool can retain exact direct-execution evidence when SUN's three best Smart Router paths are all multi-hop, but only through the reviewed on-chain V2 Router deployment.",
    impact: [
      "The Smart Router calculation service remains the primary quote source; the fallback is eligible only when its successful response consists entirely of clean V2 multi-hop candidates, because the documented service returns only the three highest-output paths",
      "The fallback pins the documented SunSwap V2 Router address and runtime hash, proves its factory binding, and requires `getAmountsOut` for the exact two-token path to equal the independently read pair reserves under the reviewed 0.3% constant-product formula",
      "Any malformed, ambiguous, referral-bearing, output-mismatched, or otherwise invalid direct Smart Router candidate remains fail-closed and cannot be masked by the on-chain fallback",
      "The change closes the persistent USDT/PHONFT target gap without admitting multi-hop capacity or changing aggregate liquidity, price consensus, visible pools, target publication, or V8 liquidity scoring",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.94",
    title: "Pinned Curve StableSwap-NG rate state",
    date: "2026-07-27",
    effectiveAt: 1785110400,
    summary:
      "Address-grade plain Curve StableSwap-NG pools with rate-bearing inputs can contribute a reserve model only after a fresh, same-block state capture proves the balances, amplification, stored rates, static fee state, and ordered coin layout.",
    impact: [
      "Only `factory-stable-ng` candidates with an exact EVM address, unique token identities, and one tracked input are eligible; legacy, metapool, CryptoSwap, unknown, stale, or unpinnable shapes remain capability-gated",
      "The capture rereads the pinned block header hash after bounded multicalls for `get_balances`, `stored_rates`, `A`, `fee`, `offpeg_fee_multiplier`, and `coins`; rate factors scale balances and inversely scale USD references, while Curve applies the captured static fee after the full-input invariant",
      "Missing, base-only, malformed, dynamic-fee, mismatched-order, or hash-drifted state clears the internal candidate and retains `curve-stableswap:rate-bearing-inputs` rather than using API balances, an unpinned amplification value, a guessed fee, or nominal parity",
      "This is route-only Safety Score V9 evidence: aggregate liquidity, price consensus, visible pools, target publication, and V8 liquidity scoring are unchanged",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.93",
    title: "Paused v5.92 exact-route activations",
    date: "2026-07-27",
    effectiveAt: 1785110400,
    summary:
      "Optimism Uniswap V3 and the reviewed Solana wM/USDC Raydium direction return to shadow-only collection after the first post-activation scoring consumers exceeded the Worker memory limit.",
    impact: [
      "Both cohorts are score-ineligible and retain an activation-pending capability gate while production scoring memory is remediated and revalidated",
      "Optimism deployment verification and quotes, plus the Raydium pool-account capture, direct quote, and exact single-segment replay, remain live as activation evidence",
      "Previously active Ethereum, Polygon, and Arbitrum Uniswap V3; Base, BSC, and Ethereum PancakeSwap V3; Base Aerodrome Slipstream; and Tron SunSwap V2 cohorts are unchanged",
      "No stale route, manual capacity, or reserve-derived substitute enters P4 while either reviewed cohort is paused",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.92",
    title: "Pinned Raydium CLMM on-state execution",
    date: "2026-07-27",
    effectiveAt: 1785110400,
    summary:
      "The reviewed Solana wM/USDC Raydium CLMM direction can contribute exact route evidence only after its captured current liquidity segment reproduces the strict direct quote.",
    impact: [
      "Activation is limited to the case-sensitive wM-to-USDC direction in the reviewed Raydium CLMM pool; generic Raydium CLMM, Orca Whirlpool including the adaptive-fee HYUSD pool, Meteora, and all unlisted native targets remain shadow-only",
      "Each accepted wM profile binds the direct route, raw amounts, provider fee, pool owner and mint order, captured liquidity and sqrt price, post-swap sqrt price, bounded slot window, and exact single-segment integer replay; any mismatch, tick crossing, malformed state, route drift, or identity failure is capability-gated",
      "Only explicit operational collection failures may retain the newest still-fresh exact profile for the same target across bounded Solana rotation; semantic failures and malformed history are integrity barriers",
      "The route-only profile does not alter aggregate liquidity, price consensus, direct-source precedence, visible pool selection, target publication, or V8 liquidity scoring",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.91",
    title: "Guarded SunSwap V2 reactivation",
    date: "2026-07-27",
    effectiveAt: 1785110400,
    summary:
      "Reviewed Tron SunSwap V2 execution profiles are score-eligible again after current complete 21/21 shadow generations and healthy split scoring consumers.",
    impact: [
      "Activation is limited to the reviewed SunSwap V2 factory, pair runtime, and SUN Smart Router profile on Tron; Solana CLMM, Fluid, Uniswap V4, and unratified native cohorts remain shadow-only",
      "Every accepted profile must still prove the exact factory pair, token order, reserves, direct route, 0.3% constant-product output, bounded latest-state block bracket, freshness, and current target identity",
      "The first active scoring consumers remain a guarded production trial: memory termination, stale heartbeat, incomplete generations, or identity/proof drift require returning the registry to shadow while leaving evidence collection enabled",
      "SunSwap census rows remain excluded from liquidity scoring, price consensus, direct-source precedence, visible pool selection, and V8 liquidity scoring",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.90",
    title: "Paused SunSwap V2 scoring after rollout",
    date: "2026-07-25",
    effectiveAt: 1784937600,
    summary:
      "SunSwap V2 exact-execution collection remains live, but its profiles return to shadow-only status after the first two active DEX-scoring invocations exceeded the Worker memory limit.",
    impact: [
      "The SunSwap V2 adapter is score-ineligible and valid profiles retain the activation-pending capability gate while the scoring consumer's memory behavior is remediated and revalidated",
      "The complete 21-target producer remains enabled so direct-route reliability, identity, reserve, output, and block-bracket evidence continue to accumulate",
      "Missing, failed, stale, malformed, multi-hop-only, or identity-mismatched routes remain target-level capability gates; no stale proof or manual capacity substitutes for current direct evidence",
      "SunSwap census rows remain excluded from liquidity scoring, price consensus, direct-source precedence, visible pool selection, and V8 liquidity scoring",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.89",
    title: "Reviewed SunSwap V2 direct execution",
    date: "2026-07-25",
    effectiveAt: 1784937600,
    summary:
      "Current direct SunSwap V2 routes can contribute factory-bound, reserve-reproduced execution profiles to the Safety Score V9 exact-route envelope after full-generation production validation.",
    impact: [
      "Activation is limited to the reviewed SunSwap V2 factory, pair runtime, and SUN Smart Router profile on Tron; Raydium CLMM, Orca Whirlpool, and other native cohorts remain shadow-only",
      "Every accepted profile must prove the exact factory pair, token order, reserves, direct route, 0.3% constant-product output, bounded latest-state block bracket, freshness, and current target identity",
      "Missing, failed, stale, malformed, multi-hop-only, or identity-mismatched routes remain target-level capability gates; no stale proof or manual capacity substitutes for current direct evidence",
      "SunSwap census rows remain excluded from liquidity scoring, price consensus, direct-source precedence, visible pool selection, and V8 liquidity scoring",
    ],
    commits: [],
    reconstructed: false,
  },
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
