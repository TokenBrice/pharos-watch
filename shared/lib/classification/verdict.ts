import type { StablecoinVerdictArchetype } from "../stablecoin-verdict";

export const VERDICT_LABELS = {
  "pre-launch": "Pre-launch",
  "quarantined-record": "Quarantined Record",
  "delisted-record": "Delisted Record",
  "frozen-archive": "Frozen Archive",
  distressed: "Distressed",
  "low-safety-score": "Low Safety Score",
  "yield-bearing-hybrid": "Yield-Bearing Hybrid",
  "decentralized-benchmark": "Decentralized Benchmark",
  "institutional-default": "Institutional Default",
  uncategorized: "Uncategorized",
} as const satisfies Record<StablecoinVerdictArchetype, string>;
