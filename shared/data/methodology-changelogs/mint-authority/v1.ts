import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const MINT_AUTHORITY_V1: readonly MethodologyChangelogEntry[] = [
  {
    version: "1.0",
    title: "Initial Mint Authority Score release",
    date: "2026-06-11",
    effectiveAt: 1781136000,
    summary:
      "Introduced the standalone Mint Authority Score for reviewed stablecoin mint routes, controller topology, quantitative bounds, posture caps, and incident caps.",
    impact: [
      "Scores reviewed mint-authority profiles from 0-100 without feeding Safety Score or report-card grades",
      "Uses weakest-link controller scoring so one weak mint-capable route can constrain the result",
      "Adds unbounded and exploited-route caps, with NR preserved for missing or unresolved reviews",
    ],
    commits: [],
    reconstructed: false,
  },
];
