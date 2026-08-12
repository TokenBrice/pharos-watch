import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const YIELD_METHODOLOGY_V5: readonly MethodologyChangelogEntry[] = [
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
      "Yield manifest coverage now includes explicit price-derived fallbacks and intentional gaps, so assets like cetes-etherfuse no longer disappear from coverage reporting",
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
    effectiveAt: 1774310405,
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
    effectiveAt: 1774310404,
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
];
