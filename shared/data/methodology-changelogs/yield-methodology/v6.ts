import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const YIELD_METHODOLOGY_V6: readonly MethodologyChangelogEntry[] = [
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
];
