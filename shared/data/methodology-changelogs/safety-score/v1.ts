import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const SAFETY_SCORE_V1: readonly MethodologyChangelogEntry[] = [
    {
      version: "1.0",
      title: "Initial implementation",
      date: "2026-02-25",
      effectiveAt: 1771977600,
      summary:
        "First release with six weighted dimensions: Peg Stability, Liquidity, Safety, Resilience, Decentralization, and Dependency Risk.",
      impact: [
        "Six dimensions with grade thresholds from A+ (>=97) to F (>=0)",
        "Minimum 3 rated dimensions required for overall grade",
      ],
      commits: ["66ec5c4", "9c7ccc9", "c11e37c"],
      reconstructed: true,
    },
];
