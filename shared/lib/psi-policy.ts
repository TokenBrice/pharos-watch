import type { PsiConditionBand } from "../types/stability-constants";
import { PSI_CONDITION_BANDS } from "./classification/psi";
import { bandFromThresholds } from "./math";
import { DAY_SECONDS } from "./time-constants";

export { PSI_CONDITION_BANDS };

/** PSI below STEADY marks the systemic-stress boundary. */
export const PSI_STRESS_BOUNDARY = PSI_CONDITION_BANDS.find(({ band }) => band === "STEADY")!.min;

/** Penalty ceilings and the absolute trend bound, shared by scoring and display. */
export const PSI_COMPONENT_LIMITS = { severity: 68, breadth: 17, stressBreadth: 5, trend: 5 } as const;

export function getConditionBand(score: number): PsiConditionBand {
  return bandFromThresholds(score, PSI_CONDITION_BANDS, PSI_CONDITION_BANDS[PSI_CONDITION_BANDS.length - 1]).band;
}

/**
 * Daily PSI aggregation coverage floor. A completed day normally carries one
 * sample per producer interval; a partial day is still a valid average over
 * observed members, but it is not proof of complete publication.
 */
const PSI_DAILY_MIN_SAMPLE_SHARE = 0.8;

export function getPsiDailySampleBudget(
  producerIntervalSec: number,
): { expectedSampleCount: number; minimumSampleCount: number } {
  const expectedSampleCount = Math.ceil(DAY_SECONDS / producerIntervalSec);
  return {
    expectedSampleCount,
    minimumSampleCount: Math.ceil(expectedSampleCount * PSI_DAILY_MIN_SAMPLE_SHARE),
  };
}

/**
 * PSI admitted-universe coverage bands. One free missing asset absorbs registry
 * churn; beyond that the missing share is measured against the expected core
 * cohort (1% degraded, 10% error). A sample is still a valid index over its
 * admitted members, so the producer publishes with a quality finding and the
 * canary raises the finding to `/status`.
 */
const PSI_UNIVERSE_COVERAGE_THRESHOLDS = {
  degradedFreeMissing: 1,
  degradedMissingRatio: 0.01,
  errorMissingRatio: 0.1,
} as const;

export function classifyPsiUniverseCoverage(
  expected: number,
  admitted: number,
): "ok" | "degraded" | "error" {
  const missing = Math.max(0, expected - admitted);
  const degradedFloor = Math.max(
    PSI_UNIVERSE_COVERAGE_THRESHOLDS.degradedFreeMissing,
    Math.ceil(expected * PSI_UNIVERSE_COVERAGE_THRESHOLDS.degradedMissingRatio),
  );
  const errorFloor = Math.max(
    degradedFloor,
    Math.ceil(expected * PSI_UNIVERSE_COVERAGE_THRESHOLDS.errorMissingRatio),
  );
  if (missing > errorFloor) return "error";
  if (missing > degradedFloor) return "degraded";
  return "ok";
}
