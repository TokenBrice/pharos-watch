import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const DEPEG_DEWS_V1: readonly MethodologyChangelogEntry[] = [
  {
    version: "1.2",
    title: "Non-USD thresholding + ongoing false-positive control",
    date: "2026-02-20",
    effectiveAt: 1771581783,
    summary:
      "Depeg detection adopted peg-type-aware thresholds and began actively retiring stale false-positive open events.",
    impact: [
      "Non-USD depeg threshold raised to 150 bps (USD remained 100 bps)",
      "Cleanup migration removed legacy non-USD events below 150 bps",
      "Ongoing events auto-close after sustained DEX disagreement (30m+, >=$1M TVL)",
    ],
    commits: ["9c0d1a6", "7bc5361", "8b01716"],
    reconstructed: true,
  },
  {
    version: "1.1",
    title: "Early lifecycle hardening + active penalty floor",
    date: "2026-02-18",
    effectiveAt: 1771407222,
    summary:
      "Early stability pass reduced under-penalization and fixed event-time accounting/state-lifecycle edge cases.",
    impact: [
      "Added active-depeg penalty to peg score, then introduced a minimum floor",
      "Merged overlapping depeg intervals to prevent pegPct double-counting",
      "Detection now closes orphan open events and tracks open state by event ID",
    ],
    commits: ["cb67892", "c6c1391", "4c818f5", "8b0fe61"],
    reconstructed: true,
  },
  {
    version: "1.0",
    title: "Initial Depeg Tracker scoring + live event detection",
    date: "2026-02-18",
    effectiveAt: 1771397626,
    summary:
      "First operational release of depeg scoring and event detection primitives.",
    impact: [
      "Launched computePegScore baseline (peg time + severity blend)",
      "Introduced detectDepegEvents cron pipeline with live open/close/update logic",
      "Added duplicate-open-event merge and new-event DEX disagreement suppression",
    ],
    commits: ["f1ea0d8", "2556ae4"],
    reconstructed: true,
  },
];
