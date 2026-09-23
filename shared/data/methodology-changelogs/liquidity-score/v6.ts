import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

// Versioning convention (see compareMethodologyVersions in
// @shared/lib/methodology-versions/base): each dotted segment is compared as an
// INTEGER, so the minor segment is an open-ended integer counter within the v6
// bucket, e.g. `6.0` ([6, 0]) < `6.1` ([6, 1]) < `6.11` ([6, 11]). Routine
// liquidity-score changes bump the minor counter and stay in this file; create
// a `v7.ts` only for a genuine major/breaking methodology change. Entries below
// are newest-first by version.
export const LIQUIDITY_SCORE_V6: readonly MethodologyChangelogEntry[] = [
  {
    version: "6.7",
    title: "Pair-price coherence gate at pool admission",
    date: "2026-09-23",
    effectiveAt: 1790160000,
    summary:
      "GeckoTerminal and CoinGecko Onchain pool rows are admitted only when the tracked leg's USD price stays coherent with the pool's own pair ratio and the counter-leg's USD price; provider rows carrying the broken-price signature (leg USD prices published with null/zero pair-ratio inputs) are rejected before staging instead of contributing bogus TVL and price evidence.",
    impact: [
      "One registry-backed policy (`POOL_PRICE_COHERENCE_POLICY`, `maxPairDivergenceBps = 500`) owns both admission paths — the GeckoTerminal crawl and the CoinGecko Onchain discovery stage — and rejections carry the frozen reasons `pool-pair-ratio-unavailable` and `pool-pair-price-incoherent`, counted per reason in one warn summary per run",
      "Retention effect (pre-ship dry-run over all 483 guard-scope challenger rows: 422 admitted, 24 rejected, no threshold tuning): incoherent provider rows no longer stage, so their TVL decays out of the 14-day staged-pool horizon and their price evidence expires after the 24-hour staged-price window. The two Sophon rows (USN ~$429K and sUSN ~$105K of bogus TVL) leave USN/sUSN — USN retained TVL ~$3.86M -> ~$3.43M with its Sophon chain TVL at zero and its pool count 7 -> 5, sUSN ~$1.99M -> ~$1.89M and its pool count 1 -> 0 — and 21 further provider-broken GT rows are rejected and named by share of the asset's DEX TVL: gtusdc-gauntlet 100% (~$1.97M, its only pool), usdx-hex-trust 98% (~$637K), ceur-celo 92% (~$12.84M), yusd-yieldfi 72% (~$161K), vchf-vnx 70% (~$4.71M), usr-resolv 44% (~$194K, its only and already dust/stale row), frax-frax 38% (~$47.77M), gho-aave 26% (~$14.0M), zarp-zarp 20% (~$329K), gldt-gold-dao 19% (~$101K), savusd-avant 9% and avusd-avant 6% (the same monad savUSD/avUSD row), eurs-stasis 5% (~$285K), then apyusd-apyx, dai-makerdao, usde-ethena, usdc-circle, and usdt-tether at 1-2% and susds-sky/susde-ethena unchanged; every rejected row is one whose own GT numbers disagree with each other (a broken pair-ratio field or the broken-price signature), not a pool judged on its tracked-leg price alone",
      "Two rejections are flagged as misjudgment risks in the dry-run — a sui USDB/USDC row and the ethereum GHO/DMusd row, where both USD legs are mutually sane and only GT's pair-ratio field is broken. They are rejected by the unchanged 500 bps rule and re-admit automatically once the provider row is internally consistent; a rule review could retain them, but no threshold was widened here",
      "Direction of the remaining score surfaces: the pool challenge only downgrades when a diverging protocol group survives challengeability filtering, so removing these rows can only reduce challenge pressure — confidence stays or rises and no asset gains a new downgrade. Zero volume and zero transactions are corroboration only and never an independent rejection — pool prices derive from reserves and quiet pools are legitimate — while rows whose payload omits the pair-ratio fields entirely are admitted unchecked",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.6",
    title: "Recorded concentration band thresholds",
    date: "2026-09-21",
    effectiveAt: 1789948800,
    summary:
      "The DEX-liquidity card's `Concentration` verdict and the exit-route crowding bands now share one recorded threshold table: High at HHI >= 0.35, Medium at HHI >= 0.18, Low below. A non-finite HHI resolves to the broadest band instead of throwing at render time. The HHI computation itself is unchanged.",
    impact: [
      "Documents the re-basing the 2026-09-16 card/exit-route consolidation shipped without a methodology record: the pre-consolidation card table put High at HHI >= 0.5 and Medium at HHI >= 0.25, so `[0.35, 0.5)` moved Medium -> High and `[0.18, 0.25)` moved Low -> Medium. The post-consolidation thresholds (0.35 / 0.18) are reviewed and recorded as intended, effective 2026-09-21",
      "One canonical band table in `shared/lib/classification.ts` feeds both the card's `Concentration` label and the exit-route crowding bands, with boundary tests pinning the thresholds so a future consolidation cannot move them silently",
      "A non-finite `concentration_hhi` (for example NaN from a malformed payload) now renders as the broadest (Low) band instead of throwing inside the liquidity card",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.5",
    title: "Per-source pool registry",
    date: "2026-09-18",
    effectiveAt: 1789776000,
    summary:
      "Staged pool memory moves from `dex_pool_staging` — one row per pool per coin carrying a single source, with lanes contending for that row — to `dex_pool_registry` keyed by (stablecoin, pool, source): every lane records its own observation, and the merge resolves one view per pool before scoring — value from the highest-trust observation refreshed within 24 hours (else the freshest observation of any source), family from the value's source, price from the highest-trust priced observation refreshed within 24 hours, and identity metadata (token pair) from any observation within the 14-day horizon, so derived dedupe is lane-symmetric; ownership-by-subtraction is removed.",
    impact: [
      "A pool's source family — hence strict-cap treatment, `coverage_class`, and `coverage_confidence` — now follows whichever observation supplies the published value, so on lane handover the family changes with the value instead of being reattributed silently; attribution is single-cause",
      "Lane-symmetric derived dedupe can now collapse the same physical pool observed by two sources that previously could not match, removing some double counts; the expected net effect on published TVL is a small decrease",
      "No change to decay, horizon, price-pin, or threshold behaviour: the 14-day confidence horizon, 24-hour price pinning, 15-day deletion, TVL sanity ceiling, and all guards and caps are unchanged, now applied per (coin, pool, source) row",
      "Publication metadata adds registry counters (`registryRowsRead`, `registryMultiSourcePools`, `registryFamilyBySource`) and hourly per-coin TVL step counters against the previous published generation (`coinTvlStepCount150`, `coinTvlStepCount25`, `coinTvlStepTop`)",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.4",
    title: "14-day staged pool memory",
    date: "2026-09-10",
    effectiveAt: 1788998400,
    summary:
      "Staged discovery pools are now remembered for 14 days instead of 24 hours — full confidence through the first day, then linear decay to zero at 336 hours — while price observations remain pinned to rows refreshed within 24 hours.",
    impact: [
      "The staging merge reads `dex_pool_staging` rows refreshed within 336 hours; confidence is 1.0 for ages up to 24 hours and decays linearly to 0 at 336 hours, replacing the old `max(0.5, 1 - ageHours / 48)` curve that zeroed rows past 24 hours and deleted them after 30 hours. Staging rows are now deleted after 15 days",
      "Price evidence does not inherit the longer inventory horizon: a staged row older than 24 hours still contributes decayed TVL but emits no price observation and enters the retained set unpriced, so DEX-implied prices, DDR inputs, and peg summaries keep their previous day-fresh behaviour",
      "Pool coverage and effective TVL no longer drop when the discovery crawl has not revisited a coin within a day; over the trailing 30 days, 228 of 3,364 coin-days swung more than 1.5x or less than 0.5x day-over-day with no market cause, and crawl-timing expiry drove a measured share of those swings",
      "`measurement.decayed` now means confidence below 1.0, i.e. a staged row older than 24 hours; under the old curve every staged row older than zero hours was marked decayed, so coins whose staged rows are day-fresh see a smaller decayed share, a slightly higher coverage confidence, and can newly clear the `trendworthy` and digest-admission thresholds that read it",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.3",
    title: "Curve physical-pool alias normalization",
    date: "2026-09-01",
    effectiveAt: 1788220800,
    summary:
      "Curve registry aliases for one physical pool now collapse by canonical chain and address before coin-set ambiguity is evaluated, allowing the reviewed LUSD/3Crv execution target to enter measurement without weakening collision handling.",
    impact: [
      "When Curve exposes the same pool address through multiple registry views, the latest address-key representation replaces the earlier alias in the fingerprint candidate set instead of being counted as a second physical pool",
      "Distinct pool addresses with the same token-set fingerprint remain ambiguous and fail closed, preserving the address-grade identity requirement",
      "The LUSD/3Crv DeFiLlama UUID row can now join its reviewed physical pool and publish the v6.2 exact get_dy_underlying target; aggregate DEX TVL and Liquidity Score formulas are unchanged",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.2",
    title: "Exact LUSD/3Crv metapool execution",
    date: "2026-09-01",
    effectiveAt: 1788220800,
    summary:
      "The reviewed LUSD/3Crv deployment now uses the existing exact Curve metapool adapter, replacing its unresolved execution gate with pinned on-chain get_dy_underlying measurements.",
    impact: [
      "The producer pins the Ethereum LUSD/3Crv pool, legacy factory registration at pool_list(16), shared metapool implementation, 3pool base relationship, token order, decimals, and runtime code hashes before quoting LUSD to USDC",
      "Fresh repeated measurements can make the pool score-eligible for Safety Score V9 Exit; TVL alone still provides no execution credit, and any identity, base-pool, quote, or freshness failure remains fail-closed",
      "The change adds no new RPC lane or source family and does not alter aggregate DEX TVL or the standalone Liquidity Score formula",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.1",
    title: "Family-scoped authoritative confirmation for classic v2 pools",
    date: "2026-08-21",
    effectiveAt: 1787270400,
    summary:
      "Authoritative staged-pool confirmation now follows the exact protocol family enumerated by each native source, so Slipstream-only inventories no longer veto classic Aerodrome or Velodrome v2 pools outside their coverage.",
    impact: [
      "Aerodrome and Velodrome staged pools identified as Slipstream or concentrated liquidity still require an exact id from the clean protocol-native Slipstream inventory",
      "Classic v2 Aerodrome and Velodrome pools remain eligible through exact-address CoinGecko Onchain, GeckoTerminal, or DexScreener discovery because the native Slipstream fetchers do not enumerate those pools",
      "Full-family direct inventories such as Balancer, Fluid, Raydium, Orca, and Meteora retain exact-id confirmation across every declared chain, while PancakeSwap keeps its existing v3/v4-only confirmation scope",
      "Base Dollar's launch BD/USDC Aerodrome stableswap can therefore contribute its discovered pool TVL, volume, and price instead of being mislabeled unobserved solely because an unrelated Slipstream inventory completed cleanly",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.0",
    title: "Raydium double-count correction and native measured-lane retirement",
    date: "2026-08-20",
    effectiveAt: 1787184000,
    summary:
      "DefiLlama Raydium pools are now classified from their pool metadata, collapsing the DefiLlama/direct-API double count of the same physical Solana CLMM pool, and the never-score-eligible Solana and Tron native measured-execution lanes plus the Fluid measured overlay are retired.",
    impact: [
      "DefiLlama publishes every Raydium pool under a single `raydium-amm` project label, hiding whether a pool is concentrated (CLMM); cross-source deduplication therefore admitted a DefiLlama Raydium CLMM row and the identical directly fetched pool as two pools, counting the same physical liquidity twice and scoring the DefiLlama copy with the wrong standard-AMM venue-quality weight. v6.0 classifies from DefiLlama's `poolMeta`, so the duplicate collapses to the direct-API measurement and surviving DefiLlama CLMM rows receive the correct concentrated-liquidity weight",
      "Reported DEX TVL for Raydium-exposed stablecoins decreases by the previously double-counted amount (typically 2-35% of a coin's measured TVL), and Liquidity Scores move accordingly. Observed movements at the first v6.0 publication ranged from -12 to +9 points: down where duplicate removal dominates, up where the venue-quality correction on surviving concentrated pools dominates. The old numbers overstated liquidity; no on-chain liquidity changed",
      "Because the Selector applies hard liquidity-score floors (50 for trading eligibility, 65 for the 1-hour exit-speed lane), coins near those floors moved in both directions at the first v6.0 publication (2026-08-20 08:16 UTC): USX (51 to 44) and USDS (58 to 46) crossed below the 50 trading floor, while DUSD (50 to 54) and VCHF (52 to 59) rose and stayed eligible; for them the venue-quality correction outweighed the removed duplicate TVL. USDC stays comfortably above the 65 one-hour floor, rising from 68 to 77, because reclassifying roughly $1.9B of surviving concentrated Raydium rows to the correct venue-quality weight outweighs the roughly $330M of removed duplicate TVL",
      "The never-score-eligible Solana and Tron native measured-execution lanes (Raydium CLMM, Orca Whirlpool, SunSwap V2) and the Fluid measured overlay are removed; their pools continue as shaped, capability-appropriate evidence, and Raydium, Orca, and Fluid aggregate TVL contributions are unchanged. Public `topPools` Fluid entries no longer carry `measuredExecution` or `executionCapabilityGate` (both keys remain on active EVM measured profiles), and the unreachable `native-measured-exact` capability entry is removed from the route-source capability matrix",
      "The dead pre-5.9 API fallback that reconstructed `methodologyVersion` from a row's update time is removed; stored versions pass through unchanged with no observable effect",
    ],
    commits: [],
    reconstructed: false,
  },
];
