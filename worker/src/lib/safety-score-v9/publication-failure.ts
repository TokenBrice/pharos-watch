import { toErrorMessage } from "@shared/lib/error-utils";
import { V9AssetEvaluationError } from "@shared/lib/safety-score-v9/evaluate-set";
import type { V9PublicationAttempt } from "./publication-attempts";
import type { AcceptedProjectionUnavailableReason } from "./accepted-projections";

export const SAFETY_SCORE_V9_PUBLICATION_DIAGNOSTIC_BUDGET_MS = 5_000;

export type SafetyScoreV9PublicationFailureStage = Exclude<
  NonNullable<V9PublicationAttempt["failure"]>["stage"], "aborted"
>;

export class SafetyScoreV9AcceptedBaselineProjectionError extends Error {
  readonly code: string;

  constructor(reason: AcceptedProjectionUnavailableReason) {
    const suffix = reason === "projection-missing" ? "missing"
      : reason === "read-failed" ? "read-failed"
      : reason === "publication-mismatch" || reason === "health-mismatch" ? "publication-mismatch"
      : "invalid";
    super(`Accepted Safety Score v9 baseline projection unavailable: ${reason}`);
    this.name = "SafetyScoreV9AcceptedBaselineProjectionError";
    this.code = `safety-score-v9-accepted-baseline-projection-${suffix}`;
  }
}

export function safeFailure(
  error: unknown,
  stage: SafetyScoreV9PublicationFailureStage,
): { code: string; message: string } {
  if (error instanceof SafetyScoreV9AcceptedBaselineProjectionError) {
    return { code: error.code, message: error.message };
  }
  const name = error instanceof Error && error.name ? error.name : "Error";
  const assetAndField =
    error instanceof V9AssetEvaluationError
      ? `-${error.assetId}-${error.fieldPath ?? "unknown-field"}`
      : "";
  const rawMessage = toErrorMessage(error);
  return {
    code: `safety-score-v9-publication-${stage}-${name}${assetAndField}`
      .replace(/[^A-Za-z0-9._:-]/gu, "-")
      .slice(0, 160),
    message: (
      rawMessage.trim() || "Safety Score v9 publication attempt failed"
    ).slice(0, 500),
  };
}
