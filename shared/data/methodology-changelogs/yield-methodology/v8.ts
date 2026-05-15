import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const YIELD_METHODOLOGY_V8: readonly MethodologyChangelogEntry[] = [
  {
    version: "8.12",
    title: "Tradable Private-Credit Yield Gaps",
    date: "2026-05-14",
    effectiveAt: 1778760000,
    summary:
      "Tradable private-credit note additions are inventoried as explicit yield intentional gaps until a reliable public APY or cashflow source is wired.",
    impact: [
      "`pc0000031-tradable`, `pc0000033-tradable`, `pc0000089-tradable`, and `pc0000101-tradable` stay yield-bearing but do not publish synthetic runtime APY rows",
      "The yield manifest reports the four Tradable notes as intentional gaps instead of silently dropping them from coverage accounting",
      "Contract-priced zero-volume private-credit notes stay out of live rankings until a trustworthy source can measure realized yield",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "8.11",
    title: "Yield Coverage Expansion and Rate-Derived Fund Sources",
    date: "2026-05-13",
    effectiveAt: 1778709900,
    summary:
      "Yield coverage now includes the May 2026 curated wrapper, tokenized-treasury, Tier C lending, and commodity exact-pool expansion while keeping invalid multi-exposure DeFiLlama rows out of the native pool lane.",
    impact: [
      "`gtusdc-gauntlet`, `susdc-spark`, `susdt-spark`, `sgho-aave`, `ybold-yearn`, and `yvusdc-yearn` now own curated single-exposure DeFiLlama native pool mappings",
      "`aa-falconx-mev-capital` remains covered by its NAV/price-derived fallback path until a usable single-exposure nonzero APY source is available; the current DeFiLlama tranche row is not pinned because it is multi-exposure and reports zero APY",
      "`benji-franklin-templeton`, `wtgxx-wisdomtree`, `ustbl-spiko`, and `eutbl-spiko` now resolve through the rate-derived benchmark lane, with EUTBL using the EUR benchmark override",
      "The curated lending allowlist now includes AutoFinance, Neverland, Metrom, Mystic Finance, Bitway, and Frankencoin, with exact deterministic lending pins for `reusd-resupply`, `xusd-babelfish`, and `usda-anzens`",
      "Exact-pool commodity coverage now includes XAUT on Lista Lending and PAXG on Hydration, and the source-link registry covers the new Tier C and Hydration labels",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "8.1",
    title: "Linked Variant Parent Source Projection",
    date: "2026-05-13",
    effectiveAt: 1778704800,
    summary:
      "Tracked yield-bearing variants now project eligible wrapper yield sources onto their active parent stablecoin as linked alternative sources, while retaining the variant's own first-class yield row.",
    impact: [
      "Resolved sources for active tracked variants such as `ybold-yearn` and `sbold-k3-capital` can now publish linked parent candidates under `bold-liquity` with `linked-variant:<variantId>:<sourceKey>` source keys",
      "Variant assets still own their native runtime rows and history; parent projection is a linked source route for comparison and coverage, not a reversion to parent-owned wrapper metadata",
      "Third-party `lending-opportunity` rows are not projected from variants to parents, and duplicate parent source pools are skipped so the parent does not receive repeated observations for the same venue",
      "`felix-cdp` and `sovryn-dex` are now in the curated lending allowlist, with deterministic pool pins for `feusd-felix`, `dllr-sovryn`, `doc-money-on-chain`, and `tgbp-tokenised` so current source-backed opportunities can pass normal APY, TVL, and safety gates",
      "Coverage can increase only where a parent has a live source-backed tracked variant; the publisher does not create no-source or synthetic APY rows to inflate coverage counts",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "8.0",
    title: "PYS v8 Source-Risk Penalty Rollout",
    date: "2026-05-13",
    effectiveAt: 1778630400,
    summary:
      "PYS now applies nested source-risk penalties derived from measured yield-source evidence, while missing or unknown source-risk evidence remains neutral for scoring and rollback compatibility.",
    impact: [
      "`sourceRisk.sourceRiskPenalty` is populated from measured reward share, source depth, source age, source-switch count, bootstrap history, and sourced venue tier where available; missing or invalid evidence stays neutral (`1`) and penalties clamp to the `1..2.5` range",
      "DeFiLlama rows without row-level observation timestamps inherit the DeFiLlama input metadata age, keeping provenance freshness and source-age scoring penalties aligned",
      "PYS now computes source-risk-adjusted row utility before applying the existing safety curve, volatility multiplier, benchmark spread weight, and scaling factor",
      "Same-confidence source arbitration compares source-risk-adjusted utility after penalty resolution, then falls back to APY and TVL tie-breakers",
      "The hourly publisher now writes the `yield-rankings` cache through CAS before replacing current `yield_data` rows, so failed cache writes or older-run CAS skips preserve the previous published D1 snapshot for downstream readers",
      "External lending opportunities remain no-op inputs for base stablecoin Safety Scores; report-card yield-risk helpers normalize the source-risk payload but return explicit no-op adjustments until a separate report-card methodology version consumes them",
      "Legacy `v7.48` payloads without `sourceRisk`, rank, attribution, or publication fields remain schema-valid, and missing source-risk fields continue to behave neutrally",
    ],
    commits: [],
    reconstructed: false,
  },
];
