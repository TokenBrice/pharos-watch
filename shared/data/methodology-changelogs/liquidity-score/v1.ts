import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const LIQUIDITY_SCORE_V1: readonly MethodologyChangelogEntry[] = [
  {
    version: "1.0",
    title: "Initial DEX liquidity score release",
    date: "2026-02-19",
    effectiveAt: 1771488526,
    summary: "Launched baseline DEX liquidity scoring, API surface, and dashboard integration.",
    impact: [
      "Initial five-component composite (TVL depth, volume, pool quality, diversity, cross-chain)",
      "DeFiLlama-driven pool aggregation and top-pool persistence introduced",
      "Liquidity map endpoint and page-level leaderboard shipped",
    ],
    commits: ["a7ae273", "443ac1b", "f26fdf3"],
    reconstructed: true,
  },
];
