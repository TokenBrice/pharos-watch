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

/**
 * Tone per verdict, as a `SEVERITY_TONE_CLASS` key: measured distress is a
 * danger, a low grade a caution, lifecycle records are neutral, and identity
 * labels are informational.
 */
export const VERDICT_TONES = {
  "pre-launch": "neutral",
  "quarantined-record": "neutral",
  "delisted-record": "neutral",
  "frozen-archive": "neutral",
  distressed: "danger",
  "low-safety-score": "caution",
  "yield-bearing-hybrid": "sky",
  "decentralized-benchmark": "sky",
  "institutional-default": "sky",
  uncategorized: "neutral",
} as const satisfies Record<StablecoinVerdictArchetype, "danger" | "caution" | "neutral" | "sky">;
