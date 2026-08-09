import { handleFeedbackRequest } from "./feedback/handler";
export type { FeedbackEnv } from "./feedback/types";

// ── Main handler ──────────────────────────────────────────────────────────

export const handleFeedback = handleFeedbackRequest;
