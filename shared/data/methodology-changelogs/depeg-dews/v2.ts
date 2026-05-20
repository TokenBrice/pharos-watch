import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const DEPEG_DEWS_V2: readonly MethodologyChangelogEntry[] = [
  {
    version: "2.1",
    title: "Four-year peg-score lookback window",
    date: "2026-02-20",
    effectiveAt: 1771617846,
    summary:
      "Peg scoring moved to an explicit rolling 4-year horizon instead of unbounded historical span.",
    impact: [
      "computePegScoreWithWindow introduced a 4-year tracking cap",
      "Detail-page peg scores became explicitly lookback-bounded",
      "Boundary logic was later corrected in v3.2 for firstSeen direction",
    ],
    commits: ["29c1bdc"],
    reconstructed: true,
  },
  {
    version: "2.0",
    title: "Peg-score severity rebalance + spread penalty",
    date: "2026-02-20",
    effectiveAt: 1771586345,
    summary:
      "Peg score shifted to stronger magnitude sensitivity and penalized erratic event-size variance.",
    impact: [
      "Severity penalty changed from sqrt-based to linear (peakBps/100 scaling)",
      "Added spreadPenalty from event-magnitude standard deviation (cap 15)",
      "Composite became: 0.5*pegPct + 0.5*severity - activePenalty - spreadPenalty",
    ],
    commits: ["d2954c3"],
    reconstructed: true,
  },
];
