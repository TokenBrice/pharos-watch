import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-09-14", to: "2026-09-20" },
  headline:
    "A 128-commit codebase review hardens every Worker boundary, and Safety Score 9.5 rates PAXG on executable notional.",
  fieldNotes:
    "The week belonged to the 2026-09-16 codebase review: 128 commits across five priority tiers replaced casts and silent fallbacks with fail-closed contracts, bounded every unbounded scan, and deleted the duplicated plumbing that had accumulated around them. The review also broke production twice, once through a null-prototype logo map and once through a coverage floor calibrated against the wrong denominator, and both repairs are in this entry alongside the methodology work that shipped around it.",
  summary: [
    {
      label: "Codebase review hardening",
      tag: "security",
      description:
        "P0 to P4 of the 2026-09-16 review: Zod-validated Worker JSON boundaries, fail-closed depeg, DEWS, status, reserve and pricing paths, bounded retention, guardrails against hidden D1 mutations, and 30 dedup commits.",
    },
    {
      label: "Safety Score 9.5",
      tag: "feature",
      description:
        "Exit materiality tests measured executable notional before output retention (PAXG NR to 65/B-), a share rounding past 100% no longer halts publication, and the live-reserve coverage floor recalibrates from 90% to 60%.",
      href: "/methodology/scoring-changelog/",
    },
    {
      label: "Pricing 6.22 and 6.23",
      tag: "feature",
      description:
        "CHFm, CADm and COPm recover through guarded Mento quotes and dEURO through its EURC redemption bridge; hourly corroboration runs before publication, and a lone DEX protocol needs an agreeing hard source.",
      href: "/methodology/pricing-pipeline-changelog/",
    },
    {
      label: "Liquidity Score 6.5",
      tag: "feature",
      description:
        "Staged pool memory becomes a per-source registry, so a pool's family, cap treatment and V9 exit-evidence class no longer depend on which lane carried it this hour; the unresponsive BSC PancakeSwap subgraph is dropped.",
      href: "/methodology/liquidity-score-changelog/",
    },
    {
      label: "Reserve feed campaign",
      tag: "coverage",
      description:
        "The 22 degraded or erroring feeds were reworked: CADD moves to the August Baker Tilly report, APX excludes reconciled own claims, OUSG, mTBILL and RLUSD gain dated composition producers, and KRWQ units are corrected.",
    },
    {
      label: "Mint-burn 6.2 and supply scope",
      tag: "coverage",
      description:
        "BUIDL tracks both registered Ethereum share classes, nine incompatible supply definitions are rejected with reasons, EURCV and alUSD scope mismatches are explained, and USDm capacity binds to verified Mento V3 pools.",
      href: "/methodology/mint-burn-flow-changelog/",
    },
    {
      label: "Release and rendering repairs",
      tag: "infra",
      description:
        "The Pages prerender broken by a null-prototype logo map and the release workflow's invalid job-level env are fixed; dates render in UTC, DEWS visuals follow the canonical ladder, and API schemas state their scales.",
    },
  ],
  stats: { totalCommits: 175 },
  commits: [
    { hash: "8ce1d493", message: "fix(v9): score exit materiality before retention" },
    { hash: "251d4b8f", message: "fix(reserves): honor latest-state freshness" },
    { hash: "b694bacb", message: "fix(reserves): reconcile mTBILL totals by scope" },
    { hash: "28c78bcb", message: "fix(v9): clamp backing material share percentages" },
    { hash: "93742faf", message: "feat(dex-liquidity): per-source pool registry with hourly step counters (Liquidity Score v6.5)" },
    { hash: "a7e1174d", message: "fix(dex-liquidity): drop the BSC PancakeSwap subgraph that never answers" },
    { hash: "0240a8d1", message: "Recalibrate V9 live-reserve coverage floor to 60%" },
    { hash: "877c1b0b", message: "Accept real upstream shapes in InfiniFi and Quantoz reserve adapters" },
    { hash: "e75aed08", message: "Read legacy V9 attempt records without quarantine causes" },
    { hash: "a624c2ef", message: "Align logos mocks with getLogoSrc cutover" },
    { hash: "552d4867", message: "Add logo registry reserved-key regression test" },
    { hash: "cbf813e0", message: "Publish percentage-point scales in API schemas" },
    { hash: "cbbe0337", message: "Retry held freeze rows before bounded escalation" },
    { hash: "d1a67d8c", message: "Surface rejected Tape rows in timeline totals" },
    { hash: "b100b854", message: "Restore atomic held-publication CAS" },
    { hash: "c8a22c59", message: "Guard all logo registry lookups" },
    { hash: "8aca63e0", message: "Track every heredoc opened on a shell line" },
    { hash: "17dc344d", message: "Allow null stablecoin summary price sources" },
    { hash: "6a60f330", message: "Preserve depeg counts migration guidance" },
    { hash: "b6af46cd", message: "Preserve KRWQ raw amount whitespace handling" },
  ],
};
