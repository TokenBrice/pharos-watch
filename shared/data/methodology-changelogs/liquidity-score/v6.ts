import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

// Versions are numeric decimals with at most two decimal places under ADR-3.
// Entries below are newest-first; use a new major file only for a major change.
export const LIQUIDITY_SCORE_V6: readonly MethodologyChangelogEntry[] = [
  {
    version: "6.94",
    title: "Current-target quote retention and original-clock measured history",
    date: "2026-10-09",
    effectiveAt: 1791590400,
    summary:
      "Measured quote history can enrich only targets present in the latest accepted quote catalog, and successful history/maturity observations expire by original quotedAt rather than publication time.",
    impact: [
      "An absent latest target cannot be resurrected as a historical last-known-good quote, including unfiltered reads, individual retained routes and Curve packets. Retention requires an existing latest entry with an eligible operational failure and preserves its real failure reason; quote-missing is not operational evidence.",
      "Successful observations enter the adapter history window only when their original quotedAt is strictly after the window start and no later than the assessment clock. Recently publishing an old quote cannot extend maturity, observation counts or retained capacity. Failed-cycle timing continues to use publication time; existing maturity thresholds and three-hour ceiling remain.",
      "This is a score-facing evidence-admission change: measured-route availability and model confidence can change. Composite weights, retained TVL measurement, volume admission, operational-failure classification and the one-hour Exit continuity hold are unchanged. No TVL-basis break is appended for 6.94.",
      "Measured retention also repairs the 16-row pruning regression: 256 physical rows per DELETE, at most 4,096 quote rows and 4,096 target rows per run, with a separate 16-generation candidate/empty-ledger budget. Current publications and referenced targets remain protected; pruning changes neither evidence expiry nor score methodology by itself.",
      "Activates at the next UTC day boundary after release, 2026-10-10 00:00 UTC (1791590400). No production churn reduction, replay equivalence or improved Safety Score stability is claimed.",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.93",
    title: "Coherent registry evaluation and price-only CoinGecko tickers",
    date: "2026-10-08",
    effectiveAt: 1791504000,
    summary:
      "Registry observations are evaluated whole against a clock captured when the registry read completes, closing the one-generation dead-pool-floor bypass for post-start refreshes. CoinGecko Tickers no longer supplies volume-derived synthetic liquidity, including legacy stored rows; it remains independent price evidence under the separately versioned Pricing policy.",
    impact: [
      "Registry trust/freshness selection, confidence, maturity, chain trade evidence, dead-pool predicates and coin/global volume admission share registryEvaluatedAtSec, captured after SELECT retries finish. Rows after that clock are rejected whole as future_observation before identity, value, metadata, volume or price can contribute. Source-slot, source-fetch and measured-quote clocks, the 24h price/TVL freshness budget and 72h volume window are unchanged",
      "Scoring-stage payload v4 requires the registry evaluation clock and rejects prior versions. The D1 layout remains schema v1. A v3 stage from the previous Worker fails closed at :16; :46 reuses the prior accepted publication and the next :10 produces v4. Inline source recovery also requires Graph-key preflight, refusing keyless heavy recovery as missing-graph-api-key rather than publishing a reduced measured-target catalog",
      "CoinGecko ticker evidence contributes no liquidity TVL, pools, volume, source mix, caps, coverage or orderbook diagnostics, even when old registry rows still carry synthetic TVL/depth. New records store normalized price/observed USD flow with null TVL, request no depth and use generic four-hour raw cleanup. Pricing v6.44 admits and weights the independent zero-TVL price observations; genuine pools retain their existing policy",
      "The 2026-10-08 read-only inventory found 39 coins/221 recent ticker observations, including ten registry ticker-only identities: usdgo-osl, ylds-figure, gusd-gate, kau-kinesis, fusd-freedom-dollar, usdpt-western-union, sofid-sofi, frnt-wyoming, eurot-token-teknoloji, zsd-zephyr-protocol. The first three had raw ticker TVL above $1M each. Inventory is not a forecast of scored TVL; live-only genuine pools can alter the rollout cohort. Ticker-only liquidity becomes unobserved, not measured zero",
      "Expect one-time policy TVL steps on affected assets, not measured market withdrawals. The retained-TVL basis break list appends 6.93 so durability does not mix measurement epochs. Observed-coverage baselines exclude prior rows proven wholly ticker-valued and use proven ticker-free trailing epochs; mixed coins and missing/malformed provenance remain protected by the unchanged coverage/value/major-asset guards. Step attribution remains visible",
      "Registry, measured-target funnel, final persisted route turnover/continuity, bounded TVL-step IDs and partial DEX-body D1 result costs are diagnostics, not formula changes. Safety formula and route-selection/hold policy are unchanged; corrected upstream evidence can affect downstream outputs but improved Safety Score stability has not been measured",
      "Activation is provisionally the next UTC day boundary, 2026-10-09 00:00 UTC (1791504000); re-date effectiveAt at release",
    ],
    commits: ["b762a4034", "573140c03", "56c49e154"],
    reconstructed: false,
  },
  {
    version: "6.92",
    title: "Dead-pool floor for zero-trade pools against untracked tokens",
    date: "2026-09-28",
    effectiveAt: 1790611200,
    summary:
      "A retained pool with at least $1M of scoring TVL (DEX_DEAD_POOL_TVL_MIN_USD) no longer counts toward liquidity or DEX-implied prices when its admitted 24h reading is a trade-verified zero and none of its other tokens is a tracked stablecoin deployment on that chain. These pools are single-sided: an operator seeds a few dollars of a tracked stablecoin next to billions of an unlisted token, the seed fixes the pool price near $1, and the provider values the unlisted side at that price, so the reported reserve is not executable depth. A pool whose volume is missing, stale or not trade-verified is never screened, and a screened pool counts again on the first day CoinGecko reports a trade in it.",
    impact: [
      "Evidence (2026-09-28, eth_call balanceOf on the pool contracts): Base AUSTRIA / USDC (Aerodrome Slipstream) reported $22.55M of reserve while holding $5.32 of USDC; BLACKTEST / USDC $22.96M against $4.55; Polygon UBS / USDT $100.34M against $245 of USDT; Ethereum HKDA / USDT $49.9M against $7.34; Base DAI / PTTO $99.97M against $0.03 of DAI. Every one showed zero 24h buys and sells. Before this change 14.9% of retained DEX TVL ($1.85B of $12.4B) sat in pools with a measured zero 24h volume, most of them paired with an unlisted token",
      "Trade-verified zero: the pool's resolved 24h reading comes from a CoinGecko Onchain registry row, which stores 0 only when the provider publishes an explicit zero volume and zero 24h buys and sells (earlier CoinGecko Onchain zeros keep their exempt provenance from v6.9), on a chain where CoinGecko demonstrably indexes trades: at least one CoinGecko Onchain row on that chain shows a positive 24h volume observed within 72 hours. CoinGecko also publishes zero-trade zeros for networks it lists but does not index (Hydration: no pools on its network listing, 15 of 15 rows zero, $3.32M of weekly DeFiLlama volume), so without that gate the real HOLLAR pools would be screened permanently. GeckoTerminal zeros carry no trade-count check, and DeFiLlama and direct-API zeros also appear for venues those sources under-index (a real RLUSD / USDS pool reported 0 on DeFiLlama while CoinGecko showed $1.3M), so neither triggers the floor. The reading must be admitted (at most 72 hours old)",
      "Counter-token gate: a pool is screened only when the coin's own leg is its tracked deployment and no other leg is a tracked deployment of any cataloged stablecoin on that chain, using the same chain-address index as the rest of the DEX pipeline. Quiet stable-to-stable pairs such as RLUSD / USDS, AUSD / USDe or savUSD / avUSD keep counting. The investigation's replay of the ungated variant (every trade-verified zero, whatever the counter-token) removed real pools and pushed savUSD, sUSN and mTBILL below the 50% volume-coverage floor, so that variant was rejected",
      "A live-lane pool that reads no volume now takes the measured reading of the registry view of the same pool that it deduplicates, the same resolver choice a registry-only view already gets. This covers Aerodrome and Velodrome Slipstream through Sugar, which publishes no volume, and equally DeFiLlama and direct-API pools: on the replayed stage 23 live pools adopted a reading, 20 of them positive. That alone rates moveUSD (NR -> 22, at exactly the 0.5 coverage floor) and moves msUSD 69 -> 70 and AUDD 48 -> 49. The Base country-flag Slipstream set (AUSTRIA, BLACKTEST, NORTHMACEDONIA, PANAMA, ITALY, IVORYCOAST, ALBANIA; 8 pools at $23.5-23.7M each, $188.6M of USDC TVL) was dropped on that stage through the registry-merge signature path; the backfill closes the same gap whenever the live lane wins the deduplication",
      "Replay of the 13:10 UTC production scoring stage through the real scorer (baseline reproduced all 274 published TVLs and scores exactly): the floor removes 133 coin-pool attributions carrying $2.434B of pre-cap TVL, and global deduped DEX TVL falls from $8.401B to $8.009B (-4.7%, after the global protocol cap). USDT $3.460B -> $2.908B (-16.0%, score 68 unchanged), USDC $4.672B -> $4.441B (-5.0%, 73 -> 74), DAI $587.4M -> $387.5M (-34.0%, 60 -> 59), PYUSD $253.5M -> $192.0M (-24.3%, 68 -> 66), PAXG $160.6M -> $50.0M (-68.9%, 55 -> 62), JPYC -91.5%, jupUSD -67.4% (68 -> 63), vnxAU -97.1% (59 -> 65), EURI -97.3%. Scores move by more than 5 points for USDB (70 -> 51), USDGLO (69 -> 84), PAXG (55 -> 62), USDz (56 -> 49) and vnxAU. No rated coin falls below the 50% volume-coverage floor; MAI was already NR",
      "Published DEX-implied prices are rebuilt from the retained pools, so screened pools stop weighting them: USDT's retained price-evidence weight falls from $2.50B to $1.95B. The registry merge also stops staging a price observation from a screened view (180 observations in the replay). Run metadata records the exclusion as `retainedDeadPoolExclusions` (reason `dead-pool-zero-trade-untracked-counter`, pool count, TVL, top coins) and the stage counters `stagedLiveVolumeBackfill` and `stagedDeadPoolPriceObservationExcluded`. The scoring-stage payload moves to version 3, so a stage written by a pre-6.92 Worker is rejected rather than scored without the floor under a 6.92 label",
      "How the step reaches readers. The daily digest rejects the history pair that straddles 6.91 and 6.92 (`methodology-basis-change`). Durability's 30-day TVL and turnover stability series stay inside one TVL-measurement epoch (6.91 and 6.92 are the breaks): the old-basis days alone are scored until seven new-basis days exist, so the cutover is not read as volatility (a mixed PAXG series would read 0.59 TVL stability after seven days instead of 1.0). PAXG, previously a top-ten coin, raises the `major-tvl-cliff:paxg-paxos` drift flag on runs 2-6 before it is rebaselined",
      "Expected transient. The API `tvlChange7d`, the Depeg Resolver's 7-day and 30-day TVL changes and the DEWS liquidity-erosion signal compare against the history row nearest 7 (or 30) days ago with no methodology check, so for about seven days (30 for the resolver's 30-day change) they read the step as TVL erosion for SBC, EURI, vnxAU, USDGLO, JPYC, USDz, USDB, PAXG, jupUSD and LUSD, and less for USDT, DAI, PYUSD and EURC. The real DEWS scorer on production inputs moves USDz from WATCH to ALERT (30 -> 43), a one-off DEWS alert caused by the methodology step, not by erosion (the removed USDz / sUSDz pool held about 13.9 sUSDz against 1.28M USDz), and moves DAI, pathUSD, PYUSD, SBC, USDB and USDGLO from CALM to WATCH. Treating the pre-6.92 baselines as unavailable was measured and rejected: it blinds the liquidity signal for every coin for seven days and, through signal reweighting, moves six unrelated coins into ALERT. Guarding these readers would need a per-coin marker of whether the coin's TVL changed at the break",
      "Known limits: a real pool against a stable Pharos does not catalog is screened while it does not trade (EURI / EUR on BSC is the one uncertain case in the replay; USD+ / USDB and USDN / USDGLO are dead or unpriced counter-tokens). Major non-stable counter-tokens (WETH, WBTC) are not protected, multi-asset pools are checked on their base / quote pair only, and a cataloged coin's deployment missing from its tracked contracts counts as untracked; none of these occurs in the replay. Zero-volume pools under $1M, DeFiLlama-sourced zero pools (BMD-USDC $97.0M, PORT3-USDT $21.1M) and wash-traded pools with one or two trades a day are not screened. A screened pool whose CoinGecko reading ages past 72 hours without a refresh returns as unmeasured TVL until the 14-day registry horizon drops it",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.91",
    title: "NEAR Intents excluded as a non-AMM venue",
    date: "2026-09-28",
    effectiveAt: 1790589600,
    summary:
      "NEAR Intents (`near-intents`) joins the blocked DEX ids. It is an intent-settlement verifier, not an AMM: GeckoTerminal and CoinGecko Onchain price every NEAR Intents pair from the `intents.near` contract's shared custody of the quote asset, so the reported pool TVL is not executable depth for the stablecoin. Its rows no longer count toward coin or global DEX liquidity, pool counts, exit routes, challenger snapshots or DEX-implied prices.",
    impact: [
      "Evidence (2026-09-28): the FRAX / wNEAR pair reported $120.7M of TVL with $3.27 of 24h volume. That figure is the `intents.near` wNEAR balance (22.98M wNEAR at about $5.29), while the contract held 3.38 FRAX and the whole bridged FRAX supply on NEAR was about 237.7K. DefiLlama lists NEAR Intents as a bridge, and its NEAR-chain TVL counts the same 23.17M NEAR",
      "Replay of the 09:16 UTC production scoring stage through the real scorer (baseline reproduced all 274 published scores and TVLs exactly): global DEX TVL falls from $9.195B to $8.456B (-$738.6M, -8.0%) and the global pool count from 11,258 to 11,107. USDC loses $383.7M (7.5% of its DEX TVL, 69 pools) and its score moves 73 -> 74. USDT loses $334.0M (8.8%, 72 pools) and holds at 67. FRAX loses $22.9M (29.7%, 11 pools) and moves 51 -> 50. No other coin carries NEAR Intents TVL, no coin loses 40% or more, and no other score changes",
      "The block applies at every intake as well as at scoring: the CoinGecko Onchain admission policy (token-pool crawl and stale-pool refresh), the DexScreener crawl and the GeckoTerminal crawl reject the venue, so discovery stops persisting or refreshing its rows and they are not counted as observed pools in the deployment census. Existing registry rows are never refresh candidates; they age out over the 14-day staged horizon while the scorer already drops them",
      "Other NEAR venues are unaffected. Rhea Finance pools, for example, keep counting under the unchanged gates",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.9",
    title: "Admitted-only DEX volume with a TVL coverage floor for Volume Activity",
    date: "2026-09-28",
    effectiveAt: 1790553600,
    summary:
      "DEX volume now counts only admitted pool readings (observed at most 72 hours ago), never decayed, zero-filled or imputed. Volume Activity is admitted volume over admitted TVL, and the LiquidityScore is rated only when admitted pools cover at least 50% of the coin's retained scoring TVL; below that floor it is NR (DEC-19 as amended).",
    impact: [
      "Every retained pool carries its raw provider reading and observation clock. A reading is admitted when it is at most 72 hours old (DEX_VOLUME_OBSERVATION_MAX_AGE_SEC; the boundary is admitted, one second later is stale). The window is deliberately wider than the 24h staged TVL/price freshness window, which is unchanged: an admitted reading is still the provider's rolling 24h volume as of its own clock, and availability records publish the budget and the oldest/newest observation clocks. Older readings are stale, and absent or malformed ones are missing. Staged TVL still decays over the 14-day horizon, but volume is no longer multiplied by that confidence, so a 180-hour-old $50K reading contributes nothing instead of $25K",
      "Volume Activity = the existing log-scale formula over admitted 24h volume / admitted TVL. Stale and missing pools enter neither the numerator nor the denominator, and nothing is estimated for them. volumeCoverage = admitted TVL / retained scoring TVL (post-cap pool TVL). The composite is rated when the 24h window is complete or volumeCoverage >= DEX_VOLUME_COVERAGE_MIN (0.50, floor inclusive). Below the floor scoreComponents.volumeActivity and liquidityScore are null (NR); the other components stay displayed and weights are never renormalized. A complete measured zero stays a measured 0 and scores 0 activity; a coin with no admitted reading is NR",
      "totalVolume24hUsd, totalVolume7dUsd, history volume24h and pool volumeUsd1d are numbers only for a complete window over the full retained pool set. Otherwise the totals are null, and volume24hAvailability / volume7dAvailability give completeness, reason, pool counts, the window clock and partialGrossUsd, the observed volume over admitted pools, published with admittedTvlUsd, retainedTvlUsd and volumeCoverage so it is never read as a complete total. Pools publish volumeObservation { status, observedAtSec }",
      "The __global__ row summarizes the deduped pool set the same way: its volume24hAvailability publishes the observed 24h volume over admitted deduped pools (partialGrossUsd) with its deduped-TVL volumeCoverage, instead of a bare null",
      "Ambiguous zeros are resolved at the source. Adapters that publish no trailing volume (on-chain Slipstream and Uniswap V3 BSC pool state, Fluid tickers with a malformed side, PancakeSwap pools whose hour-data batch failed, Orca/Raydium/Meteora/Balancer rows without a usable 24h stat, DeFiLlama pools without volumeUsd1d, staged rows without volume) now emit a missing reading instead of a fresh 0. The GeckoTerminal and DexScreener discovery parsers store an absent or unparseable 24h field as missing and keep an explicit 0, and CoinGecko onchain stores 0 only when the provider also reports zero 24h buys and sells. Registry rows refreshed before the v6.9 activation at 2026-09-28 07:29 UTC (DEX_VOLUME_ZERO_PROVENANCE_SINCE_SEC) came from producers that coerced absent volume to 0, so a zero on such a row is treated as missing while its positive readings stay usable (CoinGecko onchain zeros excepted: a live sample showed them to be genuine zero-trade readings); this transitional rule is inert after 72 hours. A numeric 0 on a row written after the cutover is therefore a provider-reported zero",
      "The registry resolver takes a pool's volume reading from the most trusted source row observed within 24 hours, else the most trusted row inside the 72-hour admission window, else the freshest row that has a reading (classified stale). Rows dated after the run clock are never volume candidates. The staged-row volumeMeasured flag now marks the admitted reading instead of the presence of any value",
      "The vol/TVL > 50 retention exclusion runs only on admitted readings. The >$100M large-pool floor now requires admitted volume of at least $50K, so a stale reading no longer clears it (unmeasured volume already failed it). The visible top-10 ranks unobserved volume below a measured zero",
      "Placeholder rows record the vacuous complete-zero window. Stored rows add volume_availability_json (migration 0249): the legacy NOT NULL columns hold the complete sum, else the admitted partial gross, else 0, and are published as measured only when the record says complete. Legacy rows keep unknown completeness, and history is not backfilled or restamped",
      "Durability volume consistency (25% of durability) is now 1 − CV of daily 24h turnover (volume / TVL) instead of daily volume. A recorded day counts when its window is complete or its admitted pools cover at least 50% of retained TVL, using admitted volume over admitted TVL; days below the floor are skipped, never estimated. Legacy days without a record use their stored volume over stored TVL. Fewer than 7 qualifying days in 30 still falls back to the neutral 50",
      "Downstream readers see an NR composite as unavailable, never as a low score: the Selector trading profile skips NR coins as a coverage gap, the Depeg Resolver's legacy K5 thin-liquidity triggers cannot fire for them and its current/30-day volume inputs are null for non-complete windows (so K6 paths that need them cannot fire), and the DEWS liquidity signal is unavailable. The captured-stage estimate is 25–55 newly NR coins (11 in the top 50). Safety Score V9 is unchanged",
      "Operations: a deploy or rollback between roughly :08 and :17 can make one :16 run reject the other version's scoring stage and publish nothing (fails closed; the next hour recovers). A rollback to a pre-6.9 Worker must immediately run UPDATE dex_liquidity SET volume_availability_json = NULL, before the next :16 publication, so the old producer's totals are read as legacy rather than against stale 6.9 records",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.8",
    title: "Slipstream 100bp multiplier, PancakeSwap bounded-sample census, and cross-source price handling",
    date: "2026-09-23",
    effectiveAt: 1790167200,
    summary:
      "Three DEX-liquidity corrections shipped together: the reviewed 100bp Slipstream fee tier regains its documented 0.4x quality multiplier, the PancakeSwap rotating capture loses its staged-pool veto authority, and an implausible cross-source price drops only the price instead of erasing the whole staged pool.",
    impact: [
      "aerodrome-slipstream-100bp and velodrome-slipstream-100bp carry the documented 30bp+ 0.4x multiplier (previously the silent generic 0.3x fallback, a 25% underweight); a classifier contract test now fails when a fee-bearing bucket lacks a table entry",
      "The PancakeSwap direct fetcher is declared bounded-sample: its per-run response holds only the head page plus two rotating tail pages, so since the 2026-09-18 BSC removal, cycle-completion runs had been enforcing those three pages as an exhaustive census and vetoing every staged Pancake pool read on earlier runs; Balancer, Raydium, and Orca keep exhaustive authority and identity dedupe is unchanged, so staged rows duplicating direct pools still collapse",
      "When the per-source registry resolver pairs a trusted value row with a cross-source price that fails peg-aware sanity, only the price is dropped (priceMeasured: false) instead of skipping the whole hybrid view as invalid_price (R8); same-source rows keep the previous whole-row skip. Price-attribution and weight changes for surviving cross-source prices are recorded in the pricing-pipeline changelog",
    ],
    commits: [],
    reconstructed: false,
  },
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
