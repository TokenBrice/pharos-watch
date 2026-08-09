import { errorResponse, jsonResponse } from "../../lib/api-utils";
import { isWellFormedIdempotencyKey, runIdempotentAction } from "../../lib/idempotency";
import { releaseFeedbackRateLimit } from "../../lib/rate-limit";
import { logWorkerEvent } from "../../lib/structured-log";
import { GitHubIssueRejectedError } from "./github";
import {
  FEEDBACK_REQUEST_MAX_BYTES,
  parseFeedbackRequest,
  prepareFeedbackSubmission,
  validateFeedbackSubmission,
} from "./request";
import { submitFeedback } from "./submission";
import type { FeedbackEnv } from "./types";

export async function handleFeedbackRequest(
  db: D1Database,
  request: Request,
  env: FeedbackEnv,
  execCtx?: ExecutionContext,
): Promise<Response> {
  const idempotencyRequest = request.clone();
  const parsed = await parseFeedbackRequest(request);
  if (parsed instanceof Response) return parsed;

  const validated = validateFeedbackSubmission(parsed);
  if (validated instanceof Response) return validated;

  if (!isWellFormedIdempotencyKey(request.headers.get("Idempotency-Key"))) {
    return errorResponse(400, "A valid Idempotency-Key header is required");
  }

  let preExecutionRetryableResponse: Response | null = null;
  return runIdempotentAction(
    db,
    "feedback-submit",
    idempotencyRequest,
    async () => {
      const prepared = await prepareFeedbackSubmission(db, request, env, validated, execCtx);
      if (prepared instanceof Response) {
        preExecutionRetryableResponse = prepared;
        return prepared;
      }

      try {
        await submitFeedback(db, prepared);
        return jsonResponse({ ok: true });
      } catch (error) {
        if (error instanceof GitHubIssueRejectedError) {
          const released = await releaseFeedbackRateLimit(db, prepared.rateLimitReservation);
          if (!released) {
            throw new Error(`Failed to release rejected feedback rate-limit reservation: ${error.message}`);
          }
          logWorkerEvent({
            scope: "api",
            level: "warn",
            event: "feedback_submission_rejected",
            route: "/api/feedback",
            provider: "github",
            message: "GitHub rejected feedback issue creation",
            error,
          });
          return errorResponse(500, "Failed to submit feedback. Please try again.");
        }
        logWorkerEvent({
          scope: "api",
          level: "error",
          event: "feedback_execution_outcome_unknown",
          route: "/api/feedback",
          provider: "github",
          message: "GitHub feedback execution outcome is unknown",
          error,
        });
        throw error;
      }
    },
    {
      requestMaxBytes: FEEDBACK_REQUEST_MAX_BYTES,
      isPreExecutionRetryable: (response) => response === preExecutionRetryableResponse,
      isExecutionOutcomeUnknown: (response) =>
        response.headers.get("X-Execution-Certainty")?.trim().toLowerCase() === "unknown",
    },
  );
}
