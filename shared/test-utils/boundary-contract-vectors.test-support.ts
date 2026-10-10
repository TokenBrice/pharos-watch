// Inputs only: each boundary suite owns its oracle and reviewed source fixtures.
export const NUMERIC_INPUT_STATES = [
  { state: "absent", value: undefined },
  { state: "null", value: null },
  { state: "nan", value: Number.NaN },
  { state: "infinite", value: Number.POSITIVE_INFINITY },
  { state: "negative", value: -1 },
  { state: "zero", value: 0 },
  { state: "positive", value: 100 },
] as const;

export const SCAN_INPUT_STATES = ["exhausted", "capped", "failed", "decode-gap", "complete-empty"] as const;
export const READ_INPUT_STATES = ["confirmed-absent", "failed-read"] as const;

export const CLOCK_NOW_SEC = 1_800_000_000;
export const CLOCK_INPUT_STATES = [
  { state: "missing", updatedAt: null, generationId: "generation:current" },
  { state: "future", updatedAt: CLOCK_NOW_SEC + 61, generationId: "generation:current" },
  { state: "expired", updatedAt: CLOCK_NOW_SEC - 61, generationId: "generation:current" },
  { state: "mismatched-generation", updatedAt: CLOCK_NOW_SEC, generationId: "generation:other" },
  { state: "current", updatedAt: CLOCK_NOW_SEC, generationId: "generation:current" },
] as const;
