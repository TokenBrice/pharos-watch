import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-05-04", to: "2026-05-10" },
  headline:
    "Non-USD stablecoin batch ships, DEX pricing gains confidence telemetry, and Telegram adds depeg-step commands.",
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
    { hash: "a53a0dc9", message: "Blacklist Test Fixes" },
    { hash: "c5c1af2c", message: "Tune remaining blacklist and yield test coverage" },
    { hash: "e99c2370", message: "Improve blacklist pipeline identity tracking and API artifacts" },
    { hash: "8892936f", message: "Update redemption backstop coverage and documentation" },
    { hash: "03587b67", message: "Harden pricing refresh paths and depeg metadata" },
    { hash: "892a59de", message: "Fix stablecoin catalog additions and generated assets" },
    { hash: "3eeeb2c3", message: "docs(pricing): document dex source observability" },
    { hash: "ac1a2c5e", message: "feat(pricing): register expanded dex bridge sources" },
    { hash: "e9b86a85", message: "fix(dex-liquidity): harden direct api fetch and merge diagnostics" },
    { hash: "ad48ec4c", message: "feat(pricing): expose dex source confidence telemetry" },
    { hash: "e037af24", message: "docs: document live reserve sync operations" },
    { hash: "9e82f626", message: "live-reserves: cover adapter helper contracts" },
    { hash: "fd668e5f", message: "live-reserves: expose deferred and uncertain sync state" },
    { hash: "568d2ea5", message: "live-reserves: add reserve protocol DTF adapter" },
    { hash: "dbd7f44e", message: "Add stablecoin registry batch" },
    { hash: "18160b08", message: "Enrich daily digest intelligence" },
    { hash: "8c5b63d5", message: "Enforce critical digest risk leads" },
    { hash: "6ae74a3c", message: "Harden Telegram bot group UX" },
    { hash: "50e8e363", message: "Fix homepage Fiat non-USD peg filter first-click navigation" },
    { hash: "1ea7a066", message: "fix(data): harden non-USD stablecoin batch" },
    { hash: "13e258c9", message: "fix(data): remove active EURA tracking" },
    { hash: "d09a2794", message: "feat(data): add non-USD stablecoin batch" },
    { hash: "dc22f126", message: "feat(admin): support non-USD supply backfill fallback" },
    { hash: "56faffa9", message: "fix(pricing): drop stale Coinbase DAI-USD product" },
    { hash: "c25dc46d", message: "feat(data): add CADD with redemption, mint/burn, and live-reserve coverage" },
  ],
};
