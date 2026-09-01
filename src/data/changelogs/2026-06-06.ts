import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-06-01", to: "2026-06-06" },
  headline:
    "Navigation redesign reshapes the sidebar and homepage, a compare hub launches, and the depeg resolver locks forecasts.",
  fieldNotes:
    "A heads-down week. The visible change is a navigation rework: a sticky core rail, a watch-column sidebar, and a homepage that rotates through what's worth looking at, plus a compare hub for putting two stablecoins beside each other. Underneath, the resolver learned to withhold forecasts until it's actually ready, apxUSD's wobble got handled live, and a long correctness pass taught the data pipeline to fail closed rather than guess.",
  summary: [
    {
      label: "Navigation & homepage redesign",
      tag: "design",
      description:
        "The sidebar becomes a lit 'watch column', a sticky core tape rail spans the top routes, and the homepage swaps static callouts for a rotating discovery module. The depeg resolver is promoted in primary navigation.",
    },
    {
      label: "Public compare hub",
      tag: "feature",
      description:
        "A new indexable compare hub launches for side-by-side stablecoin lookups, the DEWS radar now surfaces high-risk coin logos scaled by escalation tier, and the public dataset catalog gains JSON-LD structured data.",
    },
    {
      label: "Resolver readiness & apxUSD",
      tag: "feature",
      href: "/methodology/depeg-resolver-changelog/",
      description:
        "The depeg resolver now locks predictions by forecast readiness or backstop, persisting lock metadata behind a readiness contract. The apxUSD incident reopened across DDR/DDRR with hardened pricing and projection.",
    },
    {
      label: "Reserves & Royco yield",
      tag: "coverage",
      href: "/methodology/yield-changelog/",
      description:
        "A structured tranche-yield safety model lands and ingests Royco Dawn rows, while live-reserve coverage gains audit hardening, finalization fixes, and corrected source mappings for assigned assets.",
    },
    {
      label: "Scoring updates",
      tag: "feature",
      href: "/methodology/scoring-changelog/",
      description:
        "Safety Score advances to v7.291, and PegScore coverage extends to more priced assets.",
    },
    {
      label: "Pipeline fail-closed hardening",
      tag: "infra",
      description:
        "Pricing, depeg, DEWS, yield, reserves, and blacklist paths now fail closed on stale or uncorroborated data, with freshness guards, input gating, and hardened parsing. The ops proxy now requires Access JWTs.",
    },
    {
      label: "Codebase consolidation",
      tag: "infra",
      description:
        "A broad refactor wave shares helpers across worker, Telegram, and UI layers, derives types from schemas, and prunes dead code; perf work defers heavy detail bundles, memoizes the coverage matrix, and chunks cron queries.",
    },
  ],
  stats: { totalCommits: 298 },
  commits: [
    { hash: "653624f9", message: "fix(worker): harden APXUSD pricing and depeg projection" },
    { hash: "4dedee8d", message: "chore: refresh generated baselines" },
    { hash: "cd0a404c", message: "fix(seo): preserve prerendered static pages" },
    { hash: "0735c14d", message: "fix(cleanup): harden runtime edge cases" },
    { hash: "bac18b3a", message: "perf(frontend): defer heavy stablecoin detail bundles" },
    { hash: "d4e8e849", message: "fix(worker): harden pricing bounds and fx parsing" },
    { hash: "33bc5c54", message: "Fix depeg recovery edge cases and DEWS curves" },
    { hash: "e04fedf8", message: "test(coverage): restore critical ratchet coverage" },
    { hash: "75ca1172", message: "Add indexable compare hub" },
    { hash: "f8784b5a", message: "test(coverage): enroll depeg repair edge cases" },
    { hash: "4c0e0744", message: "test(pricing): timestamp dl list consensus fixtures" },
    { hash: "0ccd32a6", message: "test(flows): expose bridge validation count mock" },
    { hash: "83f7a9a8", message: "fix(methodology): render safety score v7.291 changelog" },
    { hash: "92024168", message: "docs: refresh editorial og images" },
    { hash: "b41d9aca", message: "docs: refresh docs metadata" },
    { hash: "216e3712", message: "chore(exports): trim internal helper exports" },
    { hash: "be7f7dda", message: "docs: refresh agent code map" },
    { hash: "419e8f4a", message: "chore(cron): avoid raw console additions" },
    { hash: "3f22a05b", message: "test(dews): remove unused mock binding" },
    { hash: "ff0cd364", message: "fix(cache): honor stablecoin cache modes" },
  ],
};
