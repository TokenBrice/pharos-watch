import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-05-04", to: "2026-05-10" },
  headline:
    "Non-USD stablecoin batch ships, DEX pricing gains confidence telemetry, and Telegram adds depeg-step commands.",
  fieldNotes:
    "A quieter week, spent strengthening the parts of Pharos that nobody asks about until they fail. DEX pricing learned to admit when a source is wobbly. The reserve adapter set widened past the dollar peg. USND moved from the live shelf to the cemetery archive after the rsETH incident: the page stays, the watch ends. Most of the work was the kind that doesn't ship as a feature: an audit pass on freezability, a recalibration of issuer control posture.",
  summary: [
    {
      label: "Non-USD coverage expansion",
      tag: "coverage",
      description:
        "Non-USD peg batch ships with supply-backfill fallback, CADD joins with full redemption + live-reserve coverage, Tangent USG activates, and the homepage Fiat filter works on first click.",
    },
    {
      label: "Live reserve hardening",
      tag: "feature",
      description:
        "Reserve Protocol DTF adapter goes live, deferred and uncertain sync states surface in the UI, adapter helper contracts expand coverage, and River/SG Forge date handling hardens.",
    },
    {
      label: "DEX pricing telemetry",
      tag: "infra",
      description:
        "Confidence telemetry exposes per-source reliability, expanded bridge sources widen DEX coverage, impossible TVL and fee-variant duplicates rejected, and stale Coinbase DAI-USD dropped.",
    },
    {
      label: "Digest intelligence",
      tag: "feature",
      description:
        "Daily digest leads with critical risk signals and uses live prices for active depegs. Telegram gains depeg-step commands and hardened group UX; homepage preview rebalanced.",
    },
    {
      label: "Freezability and blacklist audit",
      tag: "feature",
      description:
        "Freezability classifications audited and corrected, USD3 reclassified as CeFi-dependent, blacklist identity tracking improved with new API artifacts and redemption backstop coverage.",
    },
    {
      label: "USND archive",
      tag: "coverage",
      description:
        "Nerite USND moves to the frozen cemetery archive after the rsETH collateral incident, preserving the detail page while removing live reserve tracking.",
    },
    {
      label: "Infrastructure and docs",
      tag: "infra",
      description:
        "Alt-peg atlas positioning fixed, LLMs stablecoin export refreshed, sitemap test prereqs generated correctly, and README gains TOC with AI guidance cross-reference.",
    },
  ],
  stats: { totalCommits: 45 },
  commits: [
    { hash: "78630d39", message: "fix: correct Tangent USG metadata and coverage" },
    { hash: "62f2181e", message: "Fix alt-peg atlas positioning" },
    { hash: "04727ff1", message: "Refresh llms stablecoin export" },
    { hash: "335effcf", message: "Activate USG Tangent tracking" },
    { hash: "4b52bf43", message: "Fix River live reserve source" },
    { hash: "925c76de", message: "Fix CoinGecko onchain lookup miss breaker accounting" },
    { hash: "5cbb5b01", message: "test(reserves): review mixed stablecoin buckets" },
    { hash: "f2220212", message: "chore: refresh llms artifact" },
    { hash: "6781166c", message: "fix(reserves): refresh drifted reserve metadata" },
    { hash: "98470d5e", message: "fix(live-reserves): handle sg forge ambiguous dates" },
    { hash: "4af6a09a", message: "Reclassify USD3 as CeFi-dependent" },
    { hash: "b2b9f880", message: "docs: add README TOC and AI guidance cross-reference" },
    { hash: "55fe0ad3", message: "fix(digest): use live prices for active depegs" },
    { hash: "37b15584", message: "fix(ci): generate sitemap test prerequisites" },
    { hash: "e05d2f9c", message: "fix(dex-liquidity): index fee variant dedupe" },
    { hash: "7710d91b", message: "feat: support telegram depeg-step commands" },
    { hash: "fbf6e44a", message: "fix: balance homepage digest preview" },
    { hash: "8097ddd3", message: "fix(dex-liquidity): reject impossible staged TVL" },
    { hash: "38e56975", message: "Audit freezability classifications" },
    { hash: "973eb6e5", message: "Correct freezability classifications" },
  ],
};
