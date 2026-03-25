import { errorResponse, jsonResponse, withErrorHandler } from "../lib/api-utils";
import { parseFeedbackRequest, prepareFeedbackSubmission } from "./feedback/request";
import {
  createFeedbackSubmissionRecord,
  markFeedbackSubmissionFailed,
  markFeedbackSubmissionSubmitted,
} from "./feedback/store";
import { submitFeedback } from "./feedback/submission";
import type { FeedbackEnv } from "./feedback/types";
export type { FeedbackEnv } from "./feedback/types";

// ── Main handler ──────────────────────────────────────────────────────────

export const handleFeedback = withErrorHandler(
  "feedback",
  async (db: D1Database, request: Request, env: FeedbackEnv): Promise<Response> => {
    const parsed = await parseFeedbackRequest(request);
    if (parsed instanceof Response) return parsed;

    const prepared = await prepareFeedbackSubmission(db, request, env, parsed);
    if (prepared instanceof Response) return prepared;

    const { submissionId } = await createFeedbackSubmissionRecord(db, prepared.feedback);

    try {
      const result = await submitFeedback(db, {
        ...prepared,
        submissionId,
      });
      await markFeedbackSubmissionSubmitted(db, submissionId, result);
      return jsonResponse({ ok: true, submissionId });
    } catch (err) {
      try {
        await markFeedbackSubmissionFailed(
          db,
          submissionId,
          err instanceof Error ? err.message : String(err),
        );
      } catch (storeErr) {
        console.error("[feedback] failed to mark submission failure:", storeErr);
      }
      console.error("[feedback] GitHub API error:", err);
      return errorResponse(500, "Failed to submit feedback. Please try again.");
    }
  },
);
