import { REPORT_CARDS_FIXED_INPUT_MAX_UNCOMPRESSED_BYTES } from "../report-cards-fixed-input-cache-codec";

// Reviewed full catalog and active publication cardinalities. Never truncate a
// catalog or card inventory to satisfy these admission limits.
export const SAFETY_SCORE_V9_CATALOG_MAX_ASSETS = 488;
export const SAFETY_SCORE_V9_ACTIVE_MAX_ASSETS = 397;

/** Structural match for S2's ResourcePressureSchema until slice integration. */
export type SafetyScoreV9ResourcePressure = {
  phase: string;
  observedAt: number;
  bodyCapBytes: number | null;
  cacheCapBytes: number | null;
  cacheEntryCapBytes: number | null;
  maxConcurrentDecodes: number | null;
  inputCapBytes: number | null;
  catalogMaxAssets: number | null;
  intakeBytes: number | null;
  cacheBytes: number | null;
  rejectedBodies: number | null;
  inputBytes: number | null;
  catalogAssets: number | null;
  intakeBasis: "actual-stream" | "unavailable";
  cacheBasis: "intake-estimate" | "declared-estimate" | "mixed" | "unavailable";
  guard: "not-measured" | "within-policy" | "cache-bypassed" | "resource-budget-exceeded";
  platformOutcome: "platform-abandoned" | "platform-interrupted" | null;
  platformOutcomeSource: "slot-reconciliation" | null;
  heapUsedBytes: null;
  heapUnavailableReason: "workers-runtime-no-heap-api";
};

export function buildSafetyScoreV9ResourcePressure(
  input: Partial<SafetyScoreV9ResourcePressure> = {},
): SafetyScoreV9ResourcePressure {
  const measured = input.intakeBytes != null || input.cacheBytes != null ||
    input.inputBytes != null || input.catalogAssets != null;
  const guard = input.guard === "resource-budget-exceeded" || (input.rejectedBodies != null && input.rejectedBodies > 0)
    ? "resource-budget-exceeded" : input.guard ?? (measured ? "within-policy" : "not-measured");
  return {
    phase: (input.phase?.trim() || "not-measured").slice(0, 80),
    observedAt: input.observedAt ?? Math.floor(Date.now() / 1_000),
    bodyCapBytes: input.bodyCapBytes ?? null,
    cacheCapBytes: input.cacheCapBytes ?? null,
    cacheEntryCapBytes: input.cacheEntryCapBytes ?? null,
    maxConcurrentDecodes: input.maxConcurrentDecodes ?? null,
    inputCapBytes: input.inputCapBytes ?? null,
    catalogMaxAssets: input.catalogMaxAssets ?? null,
    intakeBytes: input.intakeBytes ?? null,
    cacheBytes: input.cacheBytes ?? null,
    rejectedBodies: input.rejectedBodies ?? null,
    inputBytes: input.inputBytes ?? null,
    catalogAssets: input.catalogAssets ?? null,
    intakeBasis: input.intakeBytes == null ? "unavailable" : "actual-stream",
    cacheBasis: input.cacheBasis ?? "unavailable",
    guard,
    platformOutcome: input.platformOutcome ?? null,
    platformOutcomeSource: input.platformOutcomeSource ?? null,
    heapUsedBytes: null,
    heapUnavailableReason: "workers-runtime-no-heap-api",
  };
}

export function assessSafetyScoreV9ResourceBudget(input: {
  catalogAssets: number;
  activeAssets: number;
  inputBytes: number | null;
}): {
  admitted: boolean;
  reason: "resource-budget-exceeded" | null;
  resourcePressure: SafetyScoreV9ResourcePressure;
} {
  const admitted = Number.isSafeInteger(input.catalogAssets) && input.catalogAssets >= 0 &&
    input.catalogAssets <= SAFETY_SCORE_V9_CATALOG_MAX_ASSETS &&
    Number.isSafeInteger(input.activeAssets) && input.activeAssets >= 0 &&
    input.activeAssets <= SAFETY_SCORE_V9_ACTIVE_MAX_ASSETS &&
    (input.inputBytes === null || (Number.isSafeInteger(input.inputBytes) && input.inputBytes >= 0 &&
      input.inputBytes <= REPORT_CARDS_FIXED_INPUT_MAX_UNCOMPRESSED_BYTES));
  return {
    admitted,
    reason: admitted ? null : "resource-budget-exceeded",
    resourcePressure: buildSafetyScoreV9ResourcePressure({
      phase: "compile-admission",
      inputCapBytes: REPORT_CARDS_FIXED_INPUT_MAX_UNCOMPRESSED_BYTES,
      catalogMaxAssets: SAFETY_SCORE_V9_CATALOG_MAX_ASSETS,
      inputBytes: input.inputBytes,
      catalogAssets: input.catalogAssets,
      guard: admitted ? "within-policy" : "resource-budget-exceeded",
    }),
  };
}
