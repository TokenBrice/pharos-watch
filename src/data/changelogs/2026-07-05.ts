import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-06-29", to: "2026-07-05" },
  headline:
    "The redesigned homepage canon now spans every nav group, a vaults.fyi yield source lands, and kUSD joins pre-launch.",
  fieldNotes:
    "This was a consolidation week more than a launch week. The redesigned homepage’s visual language finally reached the whole site; every nav group, the stablecoin detail template, and new hero surfaces now share one canon, while tablets gained the full table workbench. Beneath the surface the bulk of the work was quieter: a sweeping dead-code and duplication cleanup, a faster merge gate, and steadier worker pipelines. A vaults.fyi yield source and two pre-launch coins were the headline additions.",
  summary: [
    {
      label: "Site-wide design canon",
      tag: "design",
      description:
        "Every nav group, Markets, Risk, Learn, Reference, Analyze, and the coin detail template adopt the redesigned homepage canon: new hero surfaces, flat cards, the Whyte display face, and sidebar remnants removed.",
    },
    {
      label: "Tablet table workbench",
      tag: "design",
      description:
        "Tablets now get the full data-table workbench via a new lg breakpoint and auto-fit column priority (useFittedColumns plus a fit toggle), with widened overview columns and fixed header-glyph and price overflow.",
    },
    {
      label: "Yield intelligence",
      tag: "feature",
      href: "/methodology/yield-changelog/",
      description:
        "A new optional vaults.fyi yield source lands with structured logging and rollout guardrails, and venue risk scores are recalibrated against Yearn’s published reports in yield methodology v8.298.",
    },
    {
      label: "Coverage & data",
      tag: "coverage",
      description:
        "kUSD and Open USD join the pre-launch board, tGLD gains a Euler/JPEG partnership milestone, frozen stablecoins are fully retired from runtime, redemption, and cemetery surfaces, and verified metadata corrections land.",
    },
    {
      label: "Pipeline hardening",
      tag: "infra",
      description:
        "Worker hardening bounds idempotency reservations, cron leases, and slot timeouts, splits DDR repair debt from cron health, adds append-only D1 retention with queued destructive cleanup, and steadies Telegram failover.",
    },
    {
      label: "Faster merge gate",
      tag: "infra",
      description:
        "The local merge gate splits into per-root vitest projects, overlaps pages-release with validation, and adds telemetry, artifact-skip, and parallel a11y/smoke to cut wall-clock, with glob-safe coverage includes.",
    },
    {
      label: "Codebase simplification",
      tag: "infra",
      description:
        "A large dead-code and duplication sweep across worker, frontend, and shared libraries removes orphaned exports and components, unifies helpers for medians, percentiles, dates, and CSV, and trims bundle and hot-path work.",
    },
  ],
  stats: { totalCommits: 317 },
  commits: [
    { hash: "38290cae", message: "data: add tGLD Euler/JPEG Trading partnership milestone" },
    { hash: "b72d3bd9", message: "docs: refresh public docs metadata" },
    { hash: "c035dacb", message: "docs: update compliance and mint burn counts" },
    { hash: "9e8f275a", message: "docs: correct route and API operational references" },
    { hash: "20914df0", message: "docs: refresh deploy and agent process guidance" },
    { hash: "47834b4d", message: "Add kUSD as pre-launch stablecoin" },
    { hash: "956050a0", message: "Harden DDRR calibration API key forwarding" },
    { hash: "3617c20c", message: "Bump CodeQL action to 4.36.2" },
    { hash: "4888a717", message: "Validate editorial OG PNG signatures" },
    { hash: "1ed266de", message: "Fence stale slot cleanup after takeover" },
    { hash: "d088d726", message: "Bump @types/node to 26.0.1" },
    { hash: "ee03182f", message: "Bump minor and patch dependencies" },
    { hash: "bdc2f17c", message: "Gate Pages release on validation" },
    { hash: "f685dcf5", message: "Guard DDR repair-debt cache cleanup" },
    { hash: "22a3ed55", message: "Preserve mint/burn event watermark retry window" },
    { hash: "c74ef797", message: "Guard stale idempotency takeover by request hash" },
    { hash: "08bf8bea", message: "Clear actor-scoped Telegram flood cache on forget" },
    { hash: "122eb5b2", message: "Reject malformed yield cleanup value flags" },
    { hash: "e0d5700f", message: "Fix stablecoin detail address fast path" },
    { hash: "a38cb703", message: "Show live DDR card prices" },
  ],
};
