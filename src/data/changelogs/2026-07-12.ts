import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-07-06", to: "2026-07-12" },
  headline:
    "The coin page completes its redesign, PharosWatchBot adds personalized daily recaps, and ~$189B of reserves go live.",
  fieldNotes:
    "A week that ran from deep plumbing to a marquee arrival. Western Union's USDPT graduated from pre-launch to active tracking, and new adapters put roughly $189 billion of reserves under direct verification. PharosWatchBot learned to send personalized daily recaps while its delivery layer turned durable and truthful, the operator admin split into routed workspaces, and the yield workbench gained market-level opportunity scoring.",
  summary: [
    {
      label: "Coverage & lifecycle",
      tag: "coverage",
      description:
        "Western Union's USDPT is promoted from pre-launch to active tracking, GYEN freezes after GMO's wind-down, the cemetery archives confirmed wind-downs, 76 AI summaries refresh, and depeg pages become a permanent archive.",
    },
    {
      label: "Live reserve coverage",
      tag: "coverage",
      href: "/methodology/#safety-scores-methodology",
      description:
        "Live reserve adapters land for USDT and XAUt (~$186B), Spiko, USDtb, United's U, and PUSD, and redemption methodology v4.17 adds live-direct capacity telemetry for USTB and the 13-coin Mento family.",
    },
    {
      label: "Personalized daily recaps",
      tag: "feature",
      href: "/pharoswatchbot/",
      description:
        "PharosWatchBot gains opt-in personalized daily recaps: planned, delivered, and cleaned up durably per chat, with settings controls, a rollout kill switch, operator telemetry, and a privacy disclosure.",
    },
    {
      label: "Truthful bot delivery",
      tag: "security",
      description:
        "Delivery preserves opt-outs across chat migrations, applies presets atomically, serializes per-chat sends, and pauses during outages; ingress is bounded, logs stay aggregate-only, adoption is measured without tracking.",
    },
    {
      label: "Yield decision workbench",
      tag: "feature",
      href: "/methodology/yield-changelog/",
      description:
        "The yield workbench moves to summary rankings with a complete decision and comparison workflow, and yield v8.32 scores external opportunities at the market level while preserving opportunity risk end to end.",
    },
    {
      label: "Routed operator workspaces",
      tag: "infra",
      description:
        "The single-page admin dashboard splits into eight routed workspaces: Triage, Pipeline, Reliability, Crons, Actions, Comms, History, and API Management, with guarded replay-safe actions and durable audit history.",
    },
    {
      label: "Coin page & bot hero",
      tag: "design",
      description:
        "The stablecoin detail page completes its Figma template, pill-tab nav, hero KPI band, xl right rail, Sources modal, and the PharosWatchBot page gets a benefits-led signal-board hero with a lighthouse watch beam.",
    },
    {
      label: "Pipeline correctness",
      tag: "infra",
      description:
        "A worker-wide remediation adds durable operations schemas, effect fencing, and exact publication generations so partial data cannot publish as complete, and a sweep resolves 33 numbered issue reports across the stack.",
    },
  ],
  stats: { totalCommits: 572 },
  commits: [
    { hash: "5efd1900", message: "fix(telegram): launch personalized recap publicly" },
    { hash: "a6d7d0d5", message: "fix(datasets): prove rolling depeg source coverage" },
    { hash: "1bb9c543", message: "fix(worker): hide benchmark query failures" },
    { hash: "eafb672e", message: "fix(ci): validate rolling depeg dataset coverage" },
    { hash: "b4c134e7", message: "test(worker): decouple stress signals from USDPT lifecycle" },
    { hash: "161d638f", message: "chore(data): refresh USDPT public projections" },
    { hash: "c6e3e838", message: "chore(docs): refresh docs metadata after report-card count update" },
    { hash: "40ec3dca", message: "chore(sitemap): refresh usdpt-western-union lastmod after promotion" },
    { hash: "9cc78402", message: "data(registry): promote USDPT (Western Union) from pre-launch to active" },
    { hash: "a83d2fd3", message: "fix(ci): classify consolidated CLI entrypoints" },
    { hash: "b41a0a03", message: "chore(generated): refresh release projections" },
    { hash: "6943678d", message: "data(pre-launch): log trUSD vault fill and iM Bank iMKRW PoC milestones" },
    { hash: "800ed72d", message: "refactor(worker): resolve operational shadow authorities" },
    { hash: "a5113189", message: "refactor(worker): derive cron timeouts from job metadata" },
    { hash: "3d1fef4c", message: "test(worker): consolidate stateful scenario fixtures" },
    { hash: "b06b735c", message: "refactor(methodology): key scoring changelog details" },
    { hash: "099f5db3", message: "refactor(redemption): consolidate stablecoin redeem configs" },
    { hash: "e74e73d1", message: "refactor(api): collapse endpoint query registries" },
    { hash: "a918630a", message: "refactor(ci): consolidate validation and generated artifacts" },
    { hash: "3e082d1b", message: "test(simplification): capture parity baselines" },
  ],
};
