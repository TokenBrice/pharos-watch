import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const BLACKLIST_TRACKER_V4: readonly MethodologyChangelogEntry[] = [
  {
    version: "4.0",
    title: "Canonical reviewed exposure status",
    date: "2026-08-11",
    effectiveAt: 1786406400, // 2026-08-11T00:00:00Z
    summary:
      "Makes the sourced blacklistability review the sole product-level FreezeWatch status authority, removing the parallel authored override and runtime inference path without changing current classifications.",
    impact: [
      "`blacklistabilityReview.reviewedStatus` is now the only authored Yes, Upstream, Possible, or No verdict",
      "The generated client-registry `blacklistStatus` is a direct projection of that verdict for FreezeWatch, Report Cards, coverage views, and Selector data",
      "Safety Score V9 continues to consume the same review for evidence and scoring, but its access projection is no longer a fallback product-status source",
      "All 404 tracked stablecoin classifications are unchanged by the migration",
    ],
    commits: [],
    reconstructed: false,
  },
];
