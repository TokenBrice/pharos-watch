import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const SAFETY_SCORE_V2: readonly MethodologyChangelogEntry[] = [
    {
      version: "2.0",
      title: "Remove Safety dimension",
      date: "2026-02-26",
      effectiveAt: 1772064000,
      summary:
        "Safety dimension removed due to sparse Bluechip rating coverage (~20/142 coins). Bluechip display kept for informational use.",
      impact: ["Safety dimension dropped; weight redistributed to remaining 5 dimensions"],
      commits: ["a272ca8"],
      reconstructed: true,
    },
];
