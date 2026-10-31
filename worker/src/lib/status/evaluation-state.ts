import type { StatusHealthValue } from "@shared/types/status/core";
import { clampConfidence } from "../status-reliability-shared";

/** Availability-term penalty for each published status; one authority for scoring and re-scoring. */
const AVAILABILITY_CONFIDENCE_PENALTY: Record<StatusHealthValue, number> = {
  healthy: 0,
  degraded: 0.12,
  stale: 0.28,
};

export function scoreStatusConfidence(input: {
  availabilityStatus: StatusHealthValue;
  dataQualityStatus: StatusHealthValue;
  unhealthyCrons: number;
  degradedCrons: number;
  diagnosticIssueCount: number;
  missingPriceRatio: number;
  onchainMonitoringActive: boolean;
}): number {
  let confidence = 1;

  confidence -= AVAILABILITY_CONFIDENCE_PENALTY[input.availabilityStatus];
  if (input.dataQualityStatus === "degraded") confidence -= 0.12;
  if (input.dataQualityStatus === "stale") confidence -= 0.28;

  confidence -= Math.min(0.2, input.unhealthyCrons * 0.03);
  confidence -= Math.min(0.08, input.degradedCrons * 0.01);
  confidence -= Math.min(0.09, input.diagnosticIssueCount * 0.03);
  confidence -= Math.min(0.18, input.missingPriceRatio * 0.35);
  if (!input.onchainMonitoringActive) confidence -= 0.03;

  return Math.round(clampConfidence(confidence) * 1000) / 1000;
}

/**
 * Re-score the availability term when live evidence raises a cached verdict
 * above the status it was scored against; the other scoring inputs are unchanged.
 */
export function rescoreConfidenceForAvailability(
  confidence: number,
  scoredStatus: StatusHealthValue,
  flooredStatus: StatusHealthValue,
): number {
  const delta = AVAILABILITY_CONFIDENCE_PENALTY[flooredStatus] - AVAILABILITY_CONFIDENCE_PENALTY[scoredStatus];
  return delta <= 0 ? confidence : Math.round(clampConfidence(confidence - delta) * 1000) / 1000;
}
