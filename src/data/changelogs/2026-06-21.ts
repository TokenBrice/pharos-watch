import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-06-15", to: "2026-06-21" },
  headline:
    "Yield gains a Yearn-style venue-risk rubric (61 venues), Telegram adds reserve-drift alerts, and case studies reach 24.",
  fieldNotes:
    "The visible work this week was scoring and storytelling: a Yearn-style venue-risk rubric gave yield scores real venue granularity, the Telegram bot grew into a proper alerting surface, and the case-study archive more than doubled. Underneath, the larger effort was quieter — depeg and worker pipelines hardened against stale data and aborted writes, a security pass tightened logs and price freshness, and a broad refactor sweep paid down internal debt.",
  summary: [
    {
      label: "Yield venue-risk rubric",
      tag: "feature",
      href: "/methodology/yield-changelog/",
      description:
        "A Yearn-style 5-category venue-risk rubric lands in the Protected Yield Score, growing the scored-venue registry from 12 to 61. Source-risk cards, confidence flags, and concentration chips surface it across yield views.",
    },
    {
      label: "Telegram alerting overhaul",
      tag: "feature",
      description:
        "The bot becomes a real alerting surface: a reserve-drift alert family with mini-app, watchlist export/import, 24h net mint/burn on /status, durable /pause, and per-coin muting, atop a deep rate-limit and opt-out pass.",
    },
    {
      label: "Case studies & learn hub",
      tag: "feature",
      description:
        "The case-study archive more than doubles from 11 to 24 retrospectives, each with social cards and timelines, now surfaced on mechanism, cemetery, and glossary pages. A content-rich /learn hub ties the surfaces together.",
    },
    {
      label: "Depeg engine hardening",
      tag: "feature",
      href: "/methodology/depeg-resolver-changelog/",
      description:
        "The depeg resolver and DEWS early-warning engine (v6.09) harden against stale and mixed-freshness rows: monotonic watermarks, bounded incident adoption, and DDRR scoring that waits for terminal evidence before recovery.",
    },
    {
      label: "Coverage & pricing",
      tag: "coverage",
      description:
        "Smokehouse USDC joins the tracked set and bbqUSDC gains NAV, yield, and redemption routing. Resupply gains live redemption-capacity telemetry, and supplemental pricing adds exact-contract sources with stricter freshness.",
    },
    {
      label: "Security hardening",
      tag: "security",
      description:
        "A security pass redacts provider URLs from worker logs, hardens phishing-signature extraction and supplemental price freshness, passes Access credentials to the release marker, and rejects future-dated price data.",
    },
    {
      label: "Reliability & code health",
      tag: "infra",
      description:
        "Worker pipelines stop persisting aborted mint/burn and digest writes and bound yield-history reads. A broad refactor sweep dedups helpers and clears dead code across worker, frontend, scripts, and tests.",
    },
  ],
  stats: { totalCommits: 1421 },
  commits: [
    { hash: "15d17dce", message: "refactor code health cleanup follow-ups" },
    { hash: "2440a77c", message: "Fix yield history D1 lookups" },
    { hash: "327d2964", message: "test depeg resolver projection coverage" },
    { hash: "3b863470", message: "chore: waive ddr methodology coverage helper" },
    { hash: "91cb50e7", message: "chore: retire cron lease hotspot waiver" },
    { hash: "21288de4", message: "fix env contract script api key scanning" },
    { hash: "a758e94c", message: "chore: refresh generated metadata after health refactors" },
    { hash: "bb7473e3", message: "refactor scripts health helpers" },
    { hash: "95775c6e", message: "refactor worker health hotspots" },
    { hash: "e020dc93", message: "refactor test fixtures and mocks" },
    { hash: "bb22b8f5", message: "refactor frontend health hotspots" },
    { hash: "bfc95064", message: "refactor shared frontend health helpers" },
    { hash: "543c5396", message: "chore: refresh docs metadata after docs updates" },
    { hash: "b76da871", message: "chore: refresh agent code map after hardening merges" },
    { hash: "5eb3791c", message: "docs: refresh MiCA tracker data counts" },
    { hash: "949caad5", message: "docs: update design carve-out references" },
    { hash: "980c4d19", message: "docs: refresh methodology examples and changelog data" },
    { hash: "9d80add4", message: "docs: align API and runtime process references" },
    { hash: "fd0d9967", message: "fix(sync): avoid circuit failures on staleness aborts (#397)" },
    { hash: "4a428eed", message: "fix(dex-liquidity): reject exchange-only orderbook exact keys (#396)" },
  ],
};
