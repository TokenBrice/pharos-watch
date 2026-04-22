import {
  createMethodologyVersion,
} from "./methodology-version";

const yieldMethodology = createMethodologyVersion({
  currentVersion: "7.43",
  changelogPath: "/methodology/yield-changelog/",
  changelog: [
  {
    version: "7.43",
    title: "Tracked savings wrappers own their native APY history",
    date: "2026-04-22",
    effectiveAt: 1776816000,
    summary:
      "Base stablecoins no longer publish tracked savings-wrapper APY through parent-owned config or historical series when the wrapper is itself a tracked asset.",
    impact: [
      "`sUSDe`, `sUSDS`, `sDAI`, `sfrxUSD`, and `scrvUSD` now own the native runtime pool and deterministic rate readers that used to live on `USDe`, `USDS`, `DAI`, `frxUSD`, and `crvUSD`",
      "Those five base assets no longer advertise wrapper-owned `yieldBearing` metadata or serve the old wrapper APY series through `/api/yield-history`; the historical discontinuity is intentional and reflects corrected ownership rather than a missing backfill",
      "Parent-side wrapper source keys are filtered immediately at read time and purged on the hourly yield sync path, so misattributed pre-handoff rows do not linger under the base ids after rollout",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.42",
    title: "First-Class Risk Wrapper Yield Assets",
    date: "2026-04-21",
    effectiveAt: 1776777600,
    summary:
      "Yield wrappers whose holder risk differs materially from the base stablecoin now own their yield rows directly instead of publishing through the base asset.",
    impact: [
      "Cap `stcUSD`, GAIB `sAID`, Main Street `msY`, and K3 `sBOLD` are tracked as first-class yield-bearing NAV/wrapper assets rather than as native yield on cUSD, AID, msUSD, or BOLD",
      "`stUSDS` uses the generic on-chain ERC-4626 exchange-rate reader because the risk-capital token is distinct from Sky's plain sUSDS savings wrapper and has no standalone DeFiLlama stablecoin row",
      "Aave Umbrella `stkGHO` is inventoried as an intentional runtime-yield gap until a reliable reward APY source is available, avoiding a misleading zero-yield publication",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.41",
    title: "On-Chain Bootstrap Seeds Excluded From Rolling APY",
    date: "2026-04-21",
    effectiveAt: 1776729600,
    summary:
      "Deterministic on-chain seed rows used only to establish a 7-day exchange-rate anchor no longer count as observed zero-yield samples in rolling APY, excess-yield, stability, or PYS calculations.",
    impact: [
      "On-chain rows whose first observations were bootstrap `0%` APY placeholders now compute `apy7d`, `apy30d`, `excessYield`, yield stability, and PYS from real APY samples once an anchor exists",
      "`excessYield` remains defined as `apy30d - benchmarkRate`; detail-page and hero-chip copy now labels it as 30-day based so it is not confused with current APY spread",
      "Historical seed rows remain in `yield_history` for exchange-rate anchoring, but the evaluator excludes rows with `data_source='onchain'`, `exchange_rate IS NOT NULL`, `apy = 0`, and `apy_base IS NULL` from rolling stats",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.4",
    title: "Pre-Launch Lending Overrides Quarantined",
    date: "2026-04-13",
    effectiveAt: 1776038400,
    summary:
      "Pre-launch assets are now isolated from deterministic lending override publication, so upcoming coins cannot appear in live yield rankings before launch.",
    impact: [
      "`pusd-polaris` is now an explicit pre-launch intentional gap instead of resolving through a deterministic Silo v2 lending override",
      "Yield source resolution now skips configured explicit or deterministic lending candidates unless the target asset is in the active stablecoin universe",
      "The stablecoin metadata registry now keeps pre-launch assets in `shared/data/stablecoins/pre-launch.json`, preserving upcoming pages and launch alerts while avoiding accidental live-pipeline inclusion from the main data shards",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.3",
    title: "scrvUSD Current-Rate On-Chain Reader",
    date: "2026-04-11",
    effectiveAt: 1775892600,
    summary:
      "Curve Savings crvUSD now uses a dedicated Yearn V3 profit-unlock reader for current APY instead of the generic 7-day ERC-4626 exchange-rate delta.",
    impact: [
      "`crvusd-curve` is quarantined from the generic `convertToAssets(1e18)` Tier 1 reader because that trailing 7-day delta understated Curve's current savings APY",
      "The new `onchain:crvusd-curve:scrvusd-current-rate` source reads scrvUSD vault `totalSupply`, `totalAssets`, `profitUnlockingRate`, and `fullProfitUnlockDate` to compute the current daily-compounded APY",
      "The existing DeFiLlama scrvUSD pool remains as a curated alternative and fallback row, while source-specific history starts fresh under the new current-rate source key",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.2",
    title: "USD.AI Base/Yield Token Split",
    date: "2026-04-04",
    effectiveAt: 1775314800,
    summary:
      "Yield coverage now treats sUSDai as its own tracked yield-bearing NAV token instead of hanging the savings venue off the base USDai page via wrapper indirection.",
    impact: [
      "`usdai-usd-ai` is no longer treated as a yield-bearing wrapper host, so base USDai stops inheriting sUSDai's savings pool as its native yield source",
      "New tracked asset `susdai-usd-ai` now owns the existing USD.AI savings pool mapping directly, aligning yield rankings with the dedicated sUSDai detail page and nav-token semantics",
      "The stale USD.AI wrapper config that pointed at Arbitrum PYUSD as the `sUSDai` variant address is removed, eliminating a concrete address-level misbinding",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.1",
    title: "Explicit Intentional Gaps For Pre-Launch Yield Assets",
    date: "2026-04-03",
    effectiveAt: 1775214000,
    summary:
      "Pre-launch yield-bearing assets without a live runtime source are now emitted as explicit intentional manifest gaps instead of appearing as covered entries with zero strategies.",
    impact: [
      "`bd-basedollar` is now classified the same way as other pre-launch yield-bearing assets with no live runtime source, so the manifest no longer reports it as a covered entry with zero strategies",
      "Coverage audits and operator tooling continue to inventory every yield-bearing asset, but pre-launch gaps are now fail-closed and explicit rather than implicit",
      "The public yield methodology docs and timeline now call out the intentional-gap treatment for these pre-launch assets",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.0",
    title: "Supply-Relative Size Gates For Published Lending Suggestions",
    date: "2026-04-03",
    effectiveAt: 1775210400,
    summary:
      "Published lending-opportunity rows now require observable venue TVL and must be large enough relative to the tracked stablecoin's circulating supply before they can surface as live recommendations.",
    impact: [
      "For tracked stablecoins, lending-opportunity rows now require `sourceTvlUsd` and must clear `max(existing absolute floor, 0.1% of current supply)` before publication",
      "This applies across auto-discovered DeFiLlama lending markets, deterministic exact-pool overrides, and supplemental protocol-native lending venues",
      "TVL-less protocol suggestions no longer fail open into live recommendations; until venue size is observable they are omitted from published lending-opportunity coverage",
      "Yield methodology docs and changelog entries now document the new supply-relative recommendation gate explicitly",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.9",
    title: "K3 sBOLD Added As A Distinct Native BOLD Yield Source",
    date: "2026-03-28",
    effectiveAt: 1774692000,
    summary:
      "Yield Intelligence now publishes Liquity's K3 `sBOLD` wrapper as a second native BOLD source instead of limiting BOLD coverage to the base `yBOLD` wrapper path.",
    impact: [
      "The supplemental Yearn/Kong reader now recognizes Ethereum `Staked yBOLD` and pins it to `bold-liquity` as `K3: sBOLD`",
      "This source is classified as `lending-vault`, keeping BOLD's wrapper-over-wrapper Stability Pool path in the native-yield bucket rather than `lending-opportunity` or `governance-set`",
      "Source-link resolution now deep-links `K3: sBOLD` to Liquity's dedicated earn route",
      "Yield methodology docs and the public changelog now document the additional native BOLD source coverage",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.8",
    title: "Blocked USR-Linked Lending Suggestions",
    date: "2026-03-28",
    effectiveAt: 1774688400,
    summary:
      "Yield suggestion publication now excludes lending-opportunity venues that are explicitly tied to Resolv / USR wrappers, so severely impaired wrapper ecosystems cannot surface as recommended base-asset yield routes.",
    impact: [
      "Supplemental protocol-API lending candidates such as `Morpho: Resolv USDC` are dropped before ranking publication when the venue label resolves to Resolv / `USR`, `stUSR`, or `wstUSR` exposures",
      "Auto-discovered DeFiLlama lending pools now preserve `poolMeta` in the shared cache and apply the same Resolv / USR exclusion rule, keeping the hourly publisher and the slower supplemental lane aligned",
      "The exclusion is scoped to `lending-opportunity` venues, so native tracked yield assets and their own methodology coverage remain unchanged",
      "Wrapper-over-native venues such as BOLD / `yBOLD` are documented and classified as native yield rather than `governance-set` when the wrapper only packages the protocol's own Stability Pool return",
      "Yield methodology docs and the public changelog now document the explicit USR-linked venue exclusion rule",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.7",
    title: "Benchmark-Aware PYS For Cross-Currency Yield Context",
    date: "2026-03-27",
    effectiveAt: 1774609200,
    summary:
      "Pharos Yield Score now preserves raw APY as the base yield term, then adds a modest share of row-level benchmark spread before applying the steep safety curve and consistency multiplier.",
    impact: [
      "PYS now computes `effectiveYield = max(0, apy30d + 0.25 * (apy30d - benchmarkRate))` before dividing by the adjusted risk penalty, so local-currency benchmark outperformance affects the score directly",
      "The change rewards rows that clear tighter EUR, CHF, or other native hurdles without turning PYS into a pure excess-yield ranker",
      "Worker-time scoring and live `/api/yield-rankings` safety hydration now pass row benchmark context into the shared scorer, removing another source of score drift risk",
      "Leaderboard/detail breakdowns, methodology docs, and yield-changelog entries now expose the benchmark adjustment and effective-yield terms explicitly",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.6",
    title: "Supplemental Freshness Windows Match The 4-Hour Cache Lane",
    date: "2026-03-27",
    effectiveAt: 1774602000,
    summary:
      "Read-time `data-stale` warnings now give supplemental protocol-API and optional Aave/Compound rows a freshness window that matches their 4-hour cache cadence instead of treating them like hourly publisher data.",
    impact: [
      "Supplemental-backed protocol-API rows now wait 6 hours before surfacing `data-stale`, so normal end-of-cycle hourly publishes no longer show false stale warnings",
      "Optional Aave V3 and Compound V3 rows now use the same 6 hour freshness window because they are refreshed by `sync-yield-supplemental`, not the hourly publisher",
      "Deterministic hourly on-chain rows keep the existing three-hour stale threshold, so only the slower supplemental families move",
      "Yield methodology and operations docs now distinguish hourly, supplemental, and daily freshness windows explicitly",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.5",
    title: "Optional RPC Hardening And Explicit Wrapper Venue Pins",
    date: "2026-03-27",
    effectiveAt: 1774600200,
    summary:
      "Supplemental optional RPC readers now probe configured endpoints more resiliently and expose per-family miss telemetry, while wrapper matching can pin the intended DeFiLlama venue when one wrapper token appears across multiple pools.",
    impact: [
      "Compound V3 now probes both configured RPC endpoints instead of only the fallback URL, and Aave V3 plus Compound V3 rotate endpoint order across targets with a slightly deeper retry budget on the best-effort supplemental lane",
      "`sync-yield-supplemental` metadata now records optional RPC family target counts, attempted counts, resolved target counts, emitted row counts, missing target counts, per-chain miss breakdowns, and miss reasons",
      "Layer 2 wrapper matching can now pin a preferred DeFiLlama project in addition to chain and address, so shared wrapper tokens like `sUSDe`, `sUSDS`, and similar cases stay fail-closed without attaching to the wrong venue",
      "Under-specified wrapper configs now carry explicit live chain/address/project pins for native venues such as `sUSDai`, `sNUSD`, `savUSD`, `sUSDu`, `syzUSD`, `sAID`, `stCUSD`, and `sGHO`",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.4",
    title: "Protocol-Native Lending Readers No Longer Outrank Stronger Native Wrapper Yields",
    date: "2026-03-27",
    effectiveAt: 1774587600,
    summary:
      "Supplemental lending-market readers that query protocol state directly now stay in the curated protocol-native tier instead of inheriting Tier 1 deterministic precedence reserved for native wrapper sources.",
    impact: [
      "Aave V3 supplemental supply-rate rows now participate in arbitration as curated protocol-native venues rather than deterministic wrapper rows",
      "Native wrapper yields such as sDAI no longer lose the primary row to a lower-yield supplemental lending market purely because the lending reader used an on-chain transport",
      "Source keys and alternative-source history remain unchanged, so only arbitration precedence moves",
      "Yield methodology docs and the timeline now document that Tier 2.5 lending readers do not outrank stronger native wrapper yields by source family alone",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.3",
    title: "Restored Mixed-View Scatter Benchmark Frame",
    date: "2026-03-27",
    effectiveAt: 1774576800,
    summary:
      "The `/yield` scatter plot now keeps its four-zone benchmark frame visible on mixed-benchmark scopes by using the default USD benchmark for orientation, instead of dropping the overlay entirely.",
    impact: [
      "Mixed-benchmark scopes such as the default `All` view now render the horizontal benchmark line and four shaded quadrants again",
      "When the visible set mixes USD, EUR, and CHF hurdles, the scatter frame explicitly uses the USD benchmark as a shared visual reference",
      "Mixed-view copy now tells users that the background zones are an orientation frame and that each row's benchmark tag still governs excess-yield interpretation",
      "Yield methodology docs and the changelog now describe the restored mixed-view scatter behavior explicitly",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.2",
    title: "Source-Cadence-Aware Freshness Warnings",
    date: "2026-03-26",
    effectiveAt: 1774483209,
    summary:
      "Read-time `data-stale` warnings now respect the cadence of the underlying source family, so daily price-derived rows are not marked stale by the hourly publisher threshold.",
    impact: [
      "`price-derived` rankings now use a 36 hour stale threshold because they are backed by daily `supply_history` snapshots rather than hourly source observations",
      "Hourly publication families such as on-chain, DeFiLlama, protocol-native, and auto-discovered rows still mark stale after three missed `sync-yield-data` intervals",
      "Healthy daily snapshot rows such as USTB, USDA, and CETES no longer show false `data-stale` warnings after roughly one day of normal operation",
      "The methodology docs, changelog, and operations note now document the source-cadence freshness windows explicitly",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.1",
    title: "3M Risk-Free Benchmarks For EUR And CHF",
    date: "2026-03-26",
    effectiveAt: 1774483208,
    summary:
      "Yield Intelligence now benchmarks EUR pegs against 3-month compounded €STR and CHF pegs against 3-month compounded SARON instead of using overnight €STR and a CHF policy-rate proxy.",
    impact: [
      "EUR benchmark refreshes now use the ECB's official 3-month compounded €STR series (`EST/B.EU000A2QQF32.CR`) instead of the overnight €STR series",
      "CHF benchmark refreshes now fetch delayed public `SAR3MC` from SIX via the guest OAuth plus report-download flow, replacing the old SNB policy-rate proxy",
      "CHF benchmark entries are no longer labeled as proxies, and mixed-benchmark UI copy now names the 3-month compounded EUR and CHF cash hurdles explicitly",
      "Methodology docs, API examples, and the about-page source inventory now reflect the new EUR/CHF risk-free benchmark stack",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.0",
    title: "Asset-Scoped Supplemental Identity and Actionable Coverage Audits",
    date: "2026-03-26",
    effectiveAt: 1774483207,
    summary:
      "Supplemental protocol families now keep asset-scoped source identity instead of collapsing same-chain markets together, and the monthly coverage audit now measures the real exact-pool DL surface rather than only the native static map.",
    impact: [
      "Aave V3 supplemental on-chain rows now use asset-scoped source keys, so same-chain markets no longer overwrite each other in the supplemental cache",
      "`sync-yield-supplemental` now reports raw candidate count, deduped candidate count, and dropped-row count in cron metadata so silent row loss becomes visible to operators",
      "The monthly coverage audit now counts explicit auto-discovery overrides and curated exact-pool overrides as covered DL surfaces instead of treating only `YIELD_POOL_MAP` UUIDs as covered",
      "High-TVL coverage-gap reporting now focuses on unsupported protocol surfaces rather than flooding the audit with already-supported allowlisted markets",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.9",
    title: "Cadence-Aligned Data-Stale Warnings",
    date: "2026-03-26",
    effectiveAt: 1774483206,
    summary:
      "The read-time `data-stale` warning now follows the shared hourly `sync-yield-data` cadence instead of a leftover fixed 90-minute threshold from the old half-hourly lane.",
    impact: [
      "`data-stale` now triggers after three `sync-yield-data` intervals (currently about 3 hours) instead of after a hard-coded 90 minutes",
      "Stablecoin detail Yield Intelligence cards no longer flag healthy hourly snapshots as stale after only one delayed publish window",
      "The stale-warning threshold is now derived from shared cron metadata so future cadence moves stay aligned automatically",
      "Methodology docs and the internal timeline now describe the cadence-aware stale-warning rule explicitly",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.8",
    title: "First-Party EUR Benchmarks and Resilient CHF Parsing",
    date: "2026-03-26",
    effectiveAt: 1774483205,
    summary:
      "Yield benchmark fetching now sources EUR €STR from the ECB's official data API with the FRED mirror as fallback, and the CHF proxy parser now tolerates the SNB's current HTML structure instead of depending on one plain-text sentence layout.",
    impact: [
      "EUR benchmark refreshes now try the ECB Data API first and only fall back to the FRED €STR mirror when the official feed is unavailable",
      "CHF benchmark parsing now normalizes the SNB page to text before extracting the policy-rate sentence, avoiding breakage from harmless markup changes",
      "Degraded benchmark metadata now reports explicit EUR and CHF failure modes instead of collapsing first-run failures into a generic `unavailable` bucket",
      "Yield methodology, API examples, and source inventory now reflect the official ECB feed plus the hardened SNB proxy parser",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.7",
    title: "Safety-Reweighted PYS Curve and Shared Scoring Hydration",
    date: "2026-03-26",
    effectiveAt: 1774483204,
    summary:
      "Pharos Yield Score now uses a steeper safety penalty curve so risky names need much larger yield spreads to outrank safe ones, and the scaling factor was retuned to keep the score range readable.",
    impact: [
      "PYS now computes yield efficiency as `apy30d / (riskPenalty ^ 1.75)` instead of dividing by a linear safety penalty",
      "The global `PYS_SCALING_FACTOR` increased from `5` to `8` so score distribution remains readable after the steeper safety curve",
      "Live `/api/yield-rankings` hydration now reuses the shared PYS scorer, removing formula drift risk between cron-time scoring and read-time safety hydration",
      "Leaderboard, detail-surface breakdowns, docs, and the methodology page now reference the adjusted risk penalty explicitly",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.6",
    title: "Currency-Aware Benchmarks For Excess Yield",
    date: "2026-03-26",
    effectiveAt: 1774483203,
    summary:
      "Yield Intelligence now resolves row-level benchmark context by peg currency, using USD T-bills by default, EUR €STR when available, and a CHF SNB policy-rate proxy for Swiss-franc pegs.",
    impact: [
      "The benchmark cache now publishes a small benchmark registry instead of only a single global USD risk-free rate",
      "Each ranking row now exposes its selected benchmark label, rate, fallback state, and selection mode so excess-yield semantics remain explicit downstream",
      "Detail pages, hero chips, and yield-history charts now label excess yield against the row's actual benchmark instead of hard-coding `vs T-Bill`",
      "The `/yield` page now hides the single benchmark line on mixed-benchmark views and restores it only when the visible scope shares one benchmark",
      "CHF support uses the public SNB policy rate as a proxy rather than the SNB-published SARON display, whose usage is restricted",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.5",
    title: "Non-USD Yield Scoping and Exact-Pool Commodity Overrides",
    date: "2026-03-26",
    effectiveAt: 1774483202,
    summary:
      "Yield Intelligence now exposes a shareable non-USD ranking scope on `/yield`, and commodity coverage can use curated exact-pool DeFiLlama venues without relaxing the generic gold/silver discovery guardrails.",
    impact: [
      "The `/yield` page now supports peg-scoped ranking views, including a `non-usd` preset that groups the live EUR, CHF, SGD, MXN, and commodity rows into one visible universe",
      "Tier-2 DeFiLlama ingestion now preserves exact curated non-stablecoin pool UUIDs in addition to native pool IDs and wrapper symbols",
      "A new exact-pool override lane can publish assets like `xaut-tether` from a named venue when the UUID, project, chain, and symbol all match and the APY/TVL quality gates pass",
      "Generic gold/silver auto-discovery remains disabled, preventing mixed baskets such as Multipli's RWAUSDI pool from being misclassified as single-asset commodity yield sources",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.4",
    title: "Address-First Identity, Explicit Coverage, and Publish-Consistent History",
    date: "2026-03-26",
    effectiveAt: 1774483201,
    summary:
      "Yield resolution now matches by chain and address before symbol fallbacks, every yield-bearing asset has explicit manifest coverage or an intentional gap, and published history is bounded to the latest rankings snapshot.",
    impact: [
      "DeFiLlama discovery, variant matching, and protocol-native adapters now prefer chain+address identity and drop ambiguous symbol-only candidates instead of attaching them to the first matching coin",
      "Protocol-native source keys now use full chain-aware identifiers (Morpho, Pendle, Yearn, Kong, Beefy, Compound, Aave) and source-link matching understands prefixed and chain-qualified labels",
      "Yield manifest coverage now includes explicit price-derived fallbacks and intentional gaps, so assets like cetes-etherfuse and usg-tangent are no longer invisible to coverage reporting",
      "Warning heuristics and published `medianApy` now share the same TVL-weighted 30d benchmark",
      "yield-history no longer advances past the latest published yield-rankings snapshot when DB writes and cache publication diverge",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.3",
    title: "Yield Infrastructure Automation",
    date: "2026-03-26",
    effectiveAt: 1774483200,
    summary:
      "Chain-scoped Layer 3 symbol matching prevents cross-chain false positives in auto-lending discovery, variant symbol auto-scanner detects new wrapper tokens (advisory mode), and monthly yield coverage audit cron provides protocol expansion recommendations.",
    impact: [
      "Chain-scoped matching adds optional chainFilter to findBestLendingPool, derived from coin contract deployments",
      "Variant scanner detects sXXX/stXXX/wXXX prefix and SAVE/VAULT/EARN/STAKE suffix patterns in DL pools",
      "Monthly coverage audit cron (1st of month, 06:00 UTC) flags unmatched high-TVL pools and missing protocols",
      "Protocol recommendations classify missing protocols as high-confidence (>$10M, 3+ pools) or review-needed",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.2",
    title: "Yield Coverage Expansion — Protocol-Native API Wave",
    date: "2026-03-25",
    effectiveAt: 1774396800,
    summary:
      "Major yield coverage expansion: 10 protocol-native adapters (Hashnote USYC, Ondo oracle, Morpho GraphQL, Pendle REST, Yearn Kong GraphQL, Beefy REST, Aave V3 on-chain, Compound V3 on-chain, BIMA Earn), USTB + thBILL promoted to on-chain ERC-4626, cusd-cap flagged yield-bearing, 19 new lending protocols added, TVL floor lowered for smaller ecosystems, DeFiLlama yield history backfill for instant 365-day charts.",
    impact: [
      "10 protocol-native adapters provide direct yield data, reducing DeFiLlama intermediation",
      "Aave V3 + Compound V3 direct on-chain supply rates across Ethereum, Arbitrum, and Base",
      "Kong adapter covers 2,083 ERC-4626 vaults (Yearn + Morpho + Spark + Fluid + others)",
      "USTB + thBILL upgraded from T-bill proxy to actual on-chain ERC-4626 exchange rate reads",
      "DeFiLlama yield history backfill gives instant 365-day charts for newly tracked coins",
      "Expanded lending protocol allowlist with 19 new protocols (Wildcat $235M, Tectonic $100M, etc.)",
      "cusd-cap flagged as yield-bearing with stCUSD savings wrapper ($68M TVL)",
      "Lower TVL floor ($25K) captures Solana/Sui/Aptos/Cardano/Stacks lending markets",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.1",
    title: "Protocol-native BIMA savings fallback for USBD",
    date: "2026-03-24",
    effectiveAt: 1774310402,
    summary:
      "USBD now resolves through BIMA's public earn API when DeFiLlama has no usable sUSBD wrapper pool, closing the remaining native-yield coverage gap without introducing a hand-set rate.",
    impact: [
      "usbd-bima now emits a protocol-native `BIMA savings (sUSBD)` source row sourced from BIMA's published `/api/earn/pools` feed",
      "Yield arbitration treats protocol-owned earn APIs as curated sources rather than misclassifying them as on-chain or DeFiLlama data",
      "The about page and source-link registry now expose BIMA's earn surface as an official yield-source reference",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.0",
    title: "Richer freshness provenance and curated lending source links",
    date: "2026-03-24",
    effectiveAt: 1774310401,
    summary:
      "Yield rankings provenance now carries source-observation and comparison-anchor timing for derived sources, and the lending allowlist now has curated source-link coverage for all supported protocols.",
    impact: [
      "Price-derived and on-chain rankings now expose the age of their actual observation inputs instead of always presenting as fresh at sync time",
      "Derived-source provenance now includes comparison-anchor timing so older anchors are visible to downstream consumers",
      "All allowlisted lending protocols now resolve to curated source links instead of falling back to coin-level websites or nulls",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.9",
    title: "Publish-safe retention and deterministic adapter quarantine",
    date: "2026-03-24",
    effectiveAt: 1774310400,
    summary:
      "Yield publication now preflights rankings payloads before mutating live rows, degraded runs retain prior rows instead of destructively pruning, and the two known-bad generic deterministic vault probes were quarantined from Tier 1 coverage.",
    impact: [
      "Rankings publication is now validated before live row mutation, reducing DB/cache divergence risk on schema or publish-guard failures",
      "Degraded runs retain prior current rows by skipping destructive cleanup instead of deleting rows while upstream inputs are impaired",
      "dUSD and reUSD were removed from the generic ERC-4626 deterministic adapter set until protocol-specific readers exist, reducing false confidence in Tier 1 coverage",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.8",
    title: "Explicit edge-case overrides for remaining high-signal lending markets",
    date: "2026-03-24",
    effectiveAt: 1774360200,
    summary:
      "A final selective pass added deterministic lending overrides for the remaining high-signal exact-symbol markets that were still blocked only by report-card coverage gaps or sub-C safety gating.",
    impact: [
      "Polaris pUSD now resolves through a deterministic Silo v2 lending market override, fixing the prior bypass-only configuration gap",
      "USDX, USDO, and USDM now use deterministic exact-symbol lending overrides rather than waiting on the generic dynamic discovery path",
      "These explicit overrides bypass the normal C- safety gate only for a short named list of high-TVL or protocol-native edge cases, preserving the broader global discovery standard",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.7",
    title: "Early NAV fallback support and deeper long-tail lending coverage",
    date: "2026-03-24",
    effectiveAt: 1774357200,
    summary:
      "Yield coverage widened again through lower but still curated lending floors, two additional protocol families, and price-derived fallbacks that can bootstrap younger NAV tokens before day 30.",
    impact: [
      "Auto-discovered lending opportunities now accept single-asset pools down to $100K TVL and 0.10% APY, capturing still-meaningful long-tail markets without opening full dust-pool coverage",
      "The curated lending allowlist now includes More Markets and SmarDex USDN, while Polaris pUSD can bypass the report-card gate through an explicit vetted edge-case override",
      "Price-derived APY now annualizes from the oldest available price anchor between 7 and 45 days instead of requiring a strict 30-day sample, improving early coverage for newer NAV tokens",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.6",
    title: "Rate-derived treasury expansion and broader lending discovery",
    date: "2026-03-24",
    effectiveAt: 1774346400,
    summary:
      "Yield coverage widened through new deterministic Treasury fallbacks plus a broader but still curated lending auto-discovery set for long-tail safe assets.",
    impact: [
      "USYC and thBILL now participate in rate-derived Treasury fallback coverage alongside the existing BUIDL/USTB/YLDS/mTBILL/OUSG set",
      "Auto-discovered lending coverage now recognizes additional curated protocol slugs already present in live DeFiLlama data, including Loopscale, Vesper, Lista Lending, Liqwid, Overnight, Lagoon, and NAVI Lending",
      "The lending auto-discovery TVL floor was reduced from $1.0M to $0.5M to capture still-meaningful long-tail lending markets without opening the door to dust pools",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.5",
    title: "Fail-closed source validation and retained-market benchmark continuity",
    date: "2026-03-23",
    effectiveAt: 1774263600,
    summary:
      "Yield sync now treats broken direct-source payloads and total deterministic on-chain outages as degraded inputs, while retained Treasury benchmarks preserve the last market-derived rate across fallback streaks.",
    impact: [
      "Direct DeFiLlama yield fetches now degrade on invalid payloads or zero relevant stablecoin pools instead of being treated as a benign empty set",
      "Runs now degrade when all configured deterministic on-chain sources fail in the same cycle, exposing that outage in rankings provenance",
      "Retained `risk_free_rate` fallbacks preserve the last market-derived benchmark fields across degraded streaks, and rankings-cache publication now blocks on severe shrink versus the prior cache",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.4",
    title: "On-chain rate bootstrapping and pipeline hardening",
    date: "2026-03-20",
    effectiveAt: 1774022400,
    summary:
      "Fixed a bootstrapping deadlock preventing all 13 Tier 1 vault configs from computing on-chain APY, plus DRY and performance improvements.",
    impact: [
      "On-chain rate configs now emit a seed row when no previous exchange rate exists, breaking the bootstrapping deadlock that prevented Tier 1 APY computation since launch",
      "buildOnChainSourceKey consolidated from 3 duplicate definitions into a single shared export",
      "Pool pre-filter set allocations promoted from per-call to module-level for improved DL pool ingestion performance",
      "Live safety hydration coverage ratio now uses active card count instead of total card count for accurate degradation detection",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.3",
    title: "Wrapper-preserving ingestion and hydration hardening",
    date: "2026-03-19",
    effectiveAt: 1773878400,
    summary:
      "Yield ingestion now preserves wrapper-relevant pools through pre-filtering, separates deterministic history from curated pools, and hardens public hydration paths against partial safety or warning data.",
    impact: [
      "DeFiLlama pool ingestion now retains single-exposure wrapper pools that are explicitly relevant via native or variant config even when upstream `stablecoin` flags are false",
      "Deterministic on-chain rows now use `onchain:<stablecoinId>` source keys so previous-rate lookups and source-aware history cannot collide with curated pool UUIDs",
      "Live `/api/yield-rankings` safety hydration keeps rows with `DEFAULT_SAFETY_SCORE` / `NR` when report-card coverage is incomplete instead of dropping yield coverage",
      "Retained benchmark fallbacks stay marked as degraded, and malformed stored `warning_signals` payloads no longer fail `yield-history` requests",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.2",
    title: "Source-aware history and confidence-weighted arbitration",
    date: "2026-03-10",
    effectiveAt: 1773100800,
    summary:
      "Yield rankings now preserve per-source history, retain benchmark provenance, and prefer higher-confidence sources when multiple candidates disagree.",
    impact: [
      "yield_history now persists per-source rows with best-source markers instead of a single mixed best series",
      "7d and 30d APY metrics are computed from source-specific history, preventing source-switch contamination",
      "Rankings now include provenance for benchmark freshness, safety coverage, source-switch state, and selection reasoning",
      "Cross-source arbitration can reject divergent discovered or fallback sources when canonical sources disagree materially",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.1",
    title: "Conservative LUSD Stability Pool source",
    date: "2026-03-07",
    effectiveAt: 1772884800,
    summary:
      "LUSD gained a deterministic B.Protocol / Liquity Stability Pool source that estimates only the LQTY incentive stream and labels that limitation explicitly.",
    impact: [
      "Added direct on-chain LUSD source using Liquity Stability Pool deposits and CommunityIssuance totals",
      "APR converts projected LQTY emissions to USD using CoinGecko spot price and excludes ETH liquidation gains by design",
      "LUSD can now surface both B.Protocol Stability Pool and auto-discovered lending alternatives in the same ranking payload",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.0",
    title: "Multi-source rankings and alternative-source transparency",
    date: "2026-03-03",
    effectiveAt: 1772559178,
    summary:
      "Yield rankings moved from single-source rows to per-source modeling, so each coin can expose both native and wrapper yield paths.",
    impact: [
      "yield_data primary key changed to (stablecoin_id, source_key) with per-source rows",
      "is_best now marks the highest-APY source per coin; non-best alternatives are retained",
      "Tier 2 matching aggregates all valid sources (native map, wrapper map, symbol fallback)",
      "/api/yield-rankings now includes altSources[] and UI exposes +N alternative source details",
    ],
    commits: ["b94e042"],
    reconstructed: true,
  },
  {
    version: "3.3",
    title: "Coverage ratchet: deterministic overrides + address-aware discovery",
    date: "2026-03-03",
    effectiveAt: 1772529534,
    summary:
      "Auto-discovered lending coverage expanded with stricter quality gates, deterministic overrides, and contract-address fallback matching for symbol drift.",
    impact: [
      "Auto-discovery added minimum APY/TVL filters and expanded protocol allowlist coverage",
      "Deterministic pool overrides introduced for hard-to-match symbols (including explicit safety bypass handling)",
      "findBestLendingPool now falls back to underlying token address matches when symbol matching fails",
      "Price-derived fallback explicitly extended to BUIDL when no usable on-chain or DL source exists",
    ],
    commits: ["d9bf617", "39f3f95", "2a45230", "ce2293d"],
    reconstructed: true,
  },
  {
    version: "3.2",
    title: "Inherited blacklistability alignment for inline safety scoring",
    date: "2026-03-02",
    effectiveAt: 1772459422,
    summary:
      "Yield sync safety scoring switched to shared blacklistability logic (including reserve inheritance), improving parity with report-card safety behavior.",
    impact: [
      "Resilience inputs in inline safety computation now use shared isBlacklistable() logic",
      "Risk penalties in PYS better reflect inherited blacklist exposure",
      "Reduced divergence between yield-page safety grades and safety-scores page outputs",
    ],
    commits: ["595f176"],
    reconstructed: true,
  },
  {
    version: "3.1",
    title: "Auto-discovery hardening and finite-math safeguards",
    date: "2026-03-01",
    effectiveAt: 1772386997,
    summary:
      "Post-launch hardening pass improved reliability of discovered yield rows and prevented non-finite volatility values from polluting persisted rankings.",
    impact: [
      "NAV tokens were included in inline safety scoring instead of defaulting to implicit NR behavior",
      "Yield sync now reuses cached DeFiLlama pools from DEX sync to reduce upstream fetch failures",
      "Non-finite 30-day APY volatility values are sanitized before D1 writes",
    ],
    commits: ["2e2a0aa", "9decd36", "4402307"],
    reconstructed: true,
  },
  {
    version: "3.0",
    title: "Automatic lending-opportunity discovery",
    date: "2026-03-01",
    effectiveAt: 1772380525,
    summary:
      "Yield Intelligence expanded beyond explicitly yield-bearing tokens by automatically discovering best lending pools for safer non-yield-bearing coins.",
    impact: [
      "Added allowlist-based auto-discovery pass over DeFiLlama lending pools",
      "Eligibility gated by safety score threshold before pool selection",
      "Introduced defillama-auto source type and lending-opportunity yield classification",
    ],
    commits: ["2b1a551"],
    reconstructed: true,
  },
  {
    version: "2.1",
    title: "Warning-signal telemetry and fxUSD native mapping",
    date: "2026-03-01",
    effectiveAt: 1772380127,
    summary:
      "Yield rows gained warning-signal state for anomaly detection, while deterministic pool coverage expanded with fxUSD native yield mapping.",
    impact: [
      "warning_signals persistence added with spike/divergence/trend/reward/TVL-outflow checks",
      "Signal detection now uses market-median APY and prior TVL context per coin",
      "Tier-2 deterministic source map added explicit fxUSD Stability Pool coverage",
    ],
    commits: ["dcdefde", "35f8021"],
    reconstructed: true,
  },
  {
    version: "2.0",
    title: "Wave-1 coverage expansion and numerical hardening",
    date: "2026-03-01",
    effectiveAt: 1772378501,
    summary:
      "Wave-1 expanded native/wrapper mappings and tightened core PYS stability math to avoid edge-case distortion.",
    impact: [
      "Added wave-1 variant/pool mappings for additional native-yield stablecoins",
      "Near-zero mean handling in stability/variance math prevents coefficient-of-variation blowups",
      "Safety fallback and finite-value guards were formalized for ranking writes",
    ],
    commits: ["f5ecd72", "6b327eb"],
    reconstructed: true,
  },
  {
    version: "1.1",
    title: "Launch-audit corrections for APY windowing and display",
    date: "2026-03-01",
    effectiveAt: 1772375700,
    summary:
      "Early launch audit corrected APY window semantics and cleaned up yield stability presentation/lookup behavior.",
    impact: [
      "7-day APY switched to timestamp-window filtering instead of proportional sample slicing",
      "Tier-1 previous exchange-rate reads were reused from cached lookup state",
      "Yield stability display normalized as a true 0-100 percentage in UI components",
    ],
    commits: ["873842c"],
    reconstructed: true,
  },
  {
    version: "1.0",
    title: "Initial Yield Intelligence release",
    date: "2026-03-01",
    effectiveAt: 1772370812,
    summary:
      "Launched Yield Intelligence schema, cron computation pipeline, API surface, and dashboard integration.",
    impact: [
      "Introduced three-tier APY resolution (on-chain rate, DeFiLlama pool, NAV price-derived fallback)",
      "Launched PYS model (risk penalty + variance sustainability multiplier + scaling factor)",
      "Added yield_data/yield_history tables and public yield-rankings/yield-history API handlers",
    ],
    commits: ["0709a1d", "569664e", "22695dc", "81ba632", "0e7b8b3"],
    reconstructed: true,
  },
  ],
});

/** Display-ready Yield Intelligence methodology version (with "v" prefix). */
export const YIELD_METHODOLOGY_VERSION = yieldMethodology.currentVersion;

/** Display-ready Yield Intelligence methodology version (with "v" prefix). */
export const YIELD_METHODOLOGY_VERSION_LABEL = yieldMethodology.versionLabel;

/** Public changelog route for Yield Intelligence methodology history. */
export const YIELD_METHODOLOGY_CHANGELOG_PATH = yieldMethodology.changelogPath;

/** Reconstructed changelog data. */
export const YIELD_METHODOLOGY_CHANGELOG = yieldMethodology.changelog;
