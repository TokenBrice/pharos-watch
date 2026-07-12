import { withErrorHandler } from "../lib/api-utils";
import { handleFeedbackRequest } from "./feedback/handler";
export type { FeedbackEnv } from "./feedback/types";

// ── Main handler ──────────────────────────────────────────────────────────

export const handleFeedback = withErrorHandler("feedback", handleFeedbackRequest);
