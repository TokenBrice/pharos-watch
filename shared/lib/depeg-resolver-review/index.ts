import type { DdrrRow, DdrrSummary } from "../../types/depeg-resolver-review";
import type { DdrrReviewBatchInput } from "./inputs";
import { lookupActualEvent } from "./inputs";
import { reviewDepegResolverAssessment } from "./review";
import { summarizeDdrrRows } from "./summary";

export interface DdrrReviewBatchResult {
  rows: DdrrRow[];
  summary: DdrrSummary;
}

export function reviewDepegResolverAssessments(input: DdrrReviewBatchInput): DdrrReviewBatchResult {
  const rows = input.assessments.map((assessment) =>
    reviewDepegResolverAssessment(assessment, lookupActualEvent(input.actualEventsById, assessment.eventId), input.nowSec),
  );
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
