import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-04-27", to: "2026-05-03" },
  headline:
    "Frozen stablecoin lifecycle phase preserves dead-coin detail pages alongside the existing cemetery archive.",
  summary: [
    {
      label: "Frozen lifecycle phase",
      tag: "feature",
      description:
        "Tracked stablecoins gain a third lifecycle phase — frozen — for coins that have effectively died. Frozen coins keep their detail page and historical data as a read-only archive, drop out of every live aggregate and score recomputation, and surface in the cemetery with an archived-data link.",
    },
    {
      label: "Registry universes split",
      tag: "infra",
      description:
        "shared/lib/stablecoins/registry.ts now exposes TRACKED, ACTIVE, READABLE, and FROZEN universes. Write-side crons key off ACTIVE_IDS so frozen coins receive no new INSERT/UPDATE rows; read-side endpoints (sitemap, search, compare picker, OG, detail-page reserves/stress-signals) key off READABLE_IDS so archives stay reachable.",
    },
    {
      label: "Cemetery merge + dataset export",
      tag: "feature",
      description:
        "/cemetery merges DEAD_STABLECOINS with FROZEN_STABLECOINS, badging each frozen entry with a 'View archived data →' link to the preserved detail page. The static cemetery dataset (JSON + CSV) carries a new archivedDataAvailable column.",
    },
    {
      label: "Detail-page archive surfaces",
      tag: "design",
      description:
        "Frozen detail pages render a FrozenStateBanner above the hero, a 'Data frozen on YYYY-MM-DD' footer above each chart section, and an archive-themed metadata variant. The compare picker badges frozen coins and renders null-cell tooltips for live-only metrics.",
    },
    {
      label: "Operator runbook + CI guards",
      tag: "infra",
      description:
        "New docs/freezing-stablecoins.md captures the freeze procedure end-to-end. npm run check:frozen-invariants enforces every cross-file invariant (no frozen coins in independent registries, schema-required obituary, snapshot presence). Per-domain methodology version constants are unchanged — frozen is a data-collection lifecycle policy, not a scoring change.",
    },
  ],
  stats: { totalCommits: 32 },
  commits: [
    { hash: "0427b2ee", message: "feat(types): add frozen status and StablecoinObituary" },
    { hash: "702d2dcb", message: "refactor(cause-of-death): relocate enum + display meta to shared lib" },
    { hash: "b19cb85a", message: "feat(stablecoins/schema): validate frozen-status invariants" },
    { hash: "65df0300", message: "feat(registry): add FROZEN_* and READABLE_* universes; redefine ACTIVE_*" },
    { hash: "2f28437e", message: "feat(frozen-snapshots): add capture file + loader + registry invariants" },
    { hash: "a94081f2", message: "feat(sync-stablecoins): inject frozen-snapshots when upstream drops them" },
    { hash: "4ef75140", message: "feat(scripts): add freeze-stablecoin freeze-time capture helper" },
    { hash: "80e8fef4", message: "feat(crons): gate write-side iterations on ACTIVE_IDS; exempt orphan-close for frozen coins" },
    { hash: "613a76fa", message: "feat(crons): exclude frozen ids from independent membership registries" },
    { hash: "36f1cf30", message: "feat(psi): exclude frozen coins from market-wide stability index" },
    { hash: "af36a021", message: "feat(api): block backfill admin endpoints from running on frozen coins" },
    { hash: "8165ff63", message: "fix(dex-liquidity/persistence): preserve frozen-coin DEX rows on cleanup" },
    { hash: "5b4bd484", message: "fix(dews/persistence): preserve frozen-coin stress-signal rows" },
    { hash: "fa18999c", message: "fix(crons): exempt frozen coins from time-based retention prunes" },
    { hash: "361f0a93", message: "feat(api): widen reserves+stress-signals gates to READABLE_IDS" },
    { hash: "3216ee8e", message: "feat(og): keep OG image rendering for frozen coins; add archive subtitle" },
    { hash: "669d44b3", message: "feat(api/stablecoins): expose frozen and frozenAt per-coin" },
    { hash: "02d30a58", message: "feat(report-cards): emit defunct cards for frozen stablecoins" },
    { hash: "fbafe98c", message: "feat(telegram): emit cemetery appendix on first detection of frozen coins" },
    { hash: "7dc11954", message: "feat(stablecoin-detail): FrozenStateBanner component" },
    { hash: "f3f979c1", message: "feat(stablecoin-detail): FrozenDataNote chart footer component" },
    { hash: "0302188c", message: "feat(stablecoin-detail): render frozen banner, chart footers, and archive-themed metadata" },
    { hash: "ad57eb4d", message: "feat(compare): include frozen coins in picker and URL; render badge + null-cell tooltips" },
    { hash: "208ed5ca", message: "feat(compare-pages): drop static comparison pairs containing frozen coins" },
    { hash: "5a93ea94", message: "feat(command-palette): badge frozen entries; demote on tied scores" },
    { hash: "320c309d", message: "test(sitemap): assert frozen detail pages remain indexable" },
    { hash: "a93c0915", message: "feat(cemetery): merge dead and frozen stablecoins; render archive link for frozen tombstones" },
    { hash: "07ac227e", message: "feat(cemetery-dataset): export merged dead+frozen entries; add archivedDataAvailable column" },
    { hash: "a9a247a3", message: "feat(ci): check:frozen-invariants verifies every cross-file freeze invariant" },
    { hash: "5666f630", message: "chore(docs): enforce active/pre-launch/cemetery counts in check:doc-counts" },
    { hash: "d64d3257", message: "docs(methodology): document frozen lifecycle phase" },
    { hash: "b59fad58", message: "fix(tests): expose new frozen registry exports in stablecoins mocks" },
  ],
};
