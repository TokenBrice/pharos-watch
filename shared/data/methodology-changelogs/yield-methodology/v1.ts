import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const YIELD_METHODOLOGY_V1: readonly MethodologyChangelogEntry[] = [
  {
    version: "1.1",
    title: "Launch-audit corrections for APY windowing and display",
    date: "2026-03-01",
    effectiveAt: 1772375700,
    summary:
      "Early launch audit corrected APY window semantics and cleaned up yield stability presentation/lookup behavior.",
    impact: [
      "7-day APY switched to timestamp-window filtering instead of proportional sample slicing",
      "Tier-1 previous exchange-rate reads were reused from cached lookup state",
      "Yield stability display normalized as a true 0-100 percentage in UI components",
    ],
    commits: ["873842c"],
    reconstructed: true,
  },
  {
    version: "1.0",
    title: "Initial Yield Intelligence release",
    date: "2026-03-01",
    effectiveAt: 1772370812,
    summary:
      "Launched Yield Intelligence schema, cron computation pipeline, API surface, and dashboard integration.",
    impact: [
      "Introduced three-tier APY resolution (on-chain rate, DeFiLlama pool, NAV price-derived fallback)",
      "Launched PYS model (risk penalty + variance sustainability multiplier + scaling factor)",
      "Added yield_data/yield_history tables and public yield-rankings/yield-history API handlers",
    ],
    commits: ["0709a1d", "569664e", "22695dc", "81ba632", "0e7b8b3"],
    reconstructed: true,
  },
];
