import { handleFeedbackRequest } from "./feedback/handler";
export type { FeedbackEnv } from "./feedback/types";

export const handleFeedback = handleFeedbackRequest;
