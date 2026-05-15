import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const YIELD_METHODOLOGY_V2: readonly MethodologyChangelogEntry[] = [
  {
    version: "2.1",
    title: "Warning-signal telemetry and fxUSD native mapping",
    date: "2026-03-01",
    effectiveAt: 1772380127,
    summary:
      "Yield rows gained warning-signal state for anomaly detection, while deterministic pool coverage expanded with fxUSD native yield mapping.",
    impact: [
      "warning_signals persistence added with spike/divergence/trend/reward/TVL-outflow checks",
      "Signal detection now uses market-median APY and prior TVL context per coin",
      "Tier-2 deterministic source map added explicit fxUSD Stability Pool coverage",
    ],
    commits: ["dcdefde", "35f8021"],
    reconstructed: true,
  },
  {
    version: "2.0",
    title: "Wave-1 coverage expansion and numerical hardening",
    date: "2026-03-01",
    effectiveAt: 1772378501,
    summary:
      "Wave-1 expanded native/wrapper mappings and tightened core PYS stability math to avoid edge-case distortion.",
    impact: [
      "Added wave-1 variant/pool mappings for additional native-yield stablecoins",
      "Near-zero mean handling in stability/variance math prevents coefficient-of-variation blowups",
      "Safety fallback and finite-value guards were formalized for ranking writes",
    ],
    commits: ["f5ecd72", "6b327eb"],
    reconstructed: true,
  },
];
