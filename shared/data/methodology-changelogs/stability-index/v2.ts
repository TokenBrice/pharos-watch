import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const STABILITY_INDEX_V2: readonly MethodologyChangelogEntry[] = [
  {
    version: "2.1",
    title: "Trend hardening and retention safety",
    date: "2026-02-27",
    effectiveAt: 1772186337,
    summary:
      "Hardened trend input handling and operationalized rolling retention for PSI samples.",
    impact: [
      "NaN/Infinity trend values now treated as 0 before clamp",
      "No formula change, but edge-case score corruption prevented",
      "Sample retention/pruning standardized to 90 days",
    ],
    commits: ["76aa8c6", "74aa1cd"],
    reconstructed: true,
  },
  {
    version: "2.0",
    title: "Removed freezes, rebalanced caps",
    date: "2026-02-26",
    effectiveAt: 1772069915,
    summary:
      "Major methodology revision removing freezes and reallocating penalty capacity.",
    impact: [
      "Removed freezes component from formula",
      "Severity cap increased 60 -> 68",
      "Breadth cap increased 15 -> 17",
      "Formula became: 100 - severity - breadth + trend",
    ],
    commits: ["bc2cfcf"],
    reconstructed: true,
  },
];
