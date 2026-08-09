import type { DdrrRow, DdrrSummary } from "../../types/depeg-resolver-review";
import type { DdrrV2ReviewBatchInput } from "./inputs";
import { lookupActualEvent } from "./inputs";
import {
  buildDdrrCoverageRow,
  buildDdrrInvalidatedPredictionRow,
  reviewDepegResolverAssessment,
  reviewDepegResolverNoCall,
} from "./review";
import { summarizeDdrrRows } from "./summary";

export interface DdrrReviewBatchResult {
  rows: DdrrRow[];
  summary: DdrrSummary;
}

export function reviewDdrrV2Rows(input: DdrrV2ReviewBatchInput): DdrrReviewBatchResult {
  const actualEventsById = input.actualEventsById ?? {};
  const rows: DdrrRow[] = [
    ...(input.assessments ?? []).map((assessment) =>
      reviewDepegResolverAssessment(assessment, lookupActualEvent(actualEventsById, assessment.eventId), input.nowSec),
    ),
    ...(input.noCalls ?? []).map((assessment) =>
      reviewDepegResolverNoCall(assessment, lookupActualEvent(actualEventsById, assessment.eventId), input.nowSec),
    ),
    ...(input.coverageRows ?? []).map((row) => buildDdrrCoverageRow(row)),
    ...(input.invalidatedPredictions ?? []).map((row) => buildDdrrInvalidatedPredictionRow(row)),
  ];
  return {
    rows,
    summary: summarizeDdrrRows(rows),
  };
}

export * from "./inputs";
export * from "./outcomes";
export * from "./review";
export * from "./summary";
export * from "../../types/depeg-resolver-review";
