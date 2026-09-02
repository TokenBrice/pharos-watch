import type { StatusResponse } from "@shared/types/status";
import type { StatusLevel } from "../status-reliability";
import { clampConfidence } from "../status-reliability";
import {
  evaluateAvailabilityStatus,
  evaluateDataQualityStatus,
  evaluateReserveCompositionStatus,
  type AvailabilityStatusInput,
  type DataQualityStatusInput,
  type ReserveCompositionAssessment,
} from "./evaluation-rules";

export type { ReserveCompositionAssessment } from "./evaluation-rules";

const STATUS_SEVERITY: Record<StatusLevel, number> = {
  healthy: 0,
  degraded: 1,
  stale: 2,
};

export function maxStatus(a: StatusLevel, b: StatusLevel): StatusLevel {
  return STATUS_SEVERITY[a] >= STATUS_SEVERITY[b] ? a : b;
}

export function deriveReserveCompositionStatus(
  reserveComposition: StatusResponse["reserveComposition"],
): ReserveCompositionAssessment {
  return evaluateReserveCompositionStatus(reserveComposition);
}

export function deriveAvailabilityStatus(input: AvailabilityStatusInput): StatusResponse["availabilityStatus"] {
  return evaluateAvailabilityStatus(input).status;
}

export function deriveDataQualityStatus(input: DataQualityStatusInput): StatusResponse["dataQualityStatus"] {
  return evaluateDataQualityStatus(input).status;
}

export function scoreStatusConfidence(input: {
  availabilityStatus: StatusLevel;
  dataQualityStatus: StatusLevel;
  unhealthyCrons: number;
  degradedCrons: number;
  diagnosticIssueCount: number;
  missingPriceRatio: number;
  onchainMonitoringActive: boolean;
}): number {
  let confidence = 1;

  if (input.availabilityStatus === "degraded") confidence -= 0.12;
  if (input.availabilityStatus === "stale") confidence -= 0.28;
  if (input.dataQualityStatus === "degraded") confidence -= 0.12;
  if (input.dataQualityStatus === "stale") confidence -= 0.28;

  confidence -= Math.min(0.2, input.unhealthyCrons * 0.03);
  confidence -= Math.min(0.08, input.degradedCrons * 0.01);
  confidence -= Math.min(0.09, input.diagnosticIssueCount * 0.03);
  confidence -= Math.min(0.18, input.missingPriceRatio * 0.35);
  if (!input.onchainMonitoringActive) confidence -= 0.03;

  return Math.round(clampConfidence(confidence) * 1000) / 1000;
}
