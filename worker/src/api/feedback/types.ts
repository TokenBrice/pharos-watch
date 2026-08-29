import { z } from "zod";
import type { FeedbackRateLimitReservation } from "../../lib/rate-limit";
import { FeedbackWireFieldsSchema } from "@shared/types/feedback";
export { FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS, FEEDBACK_RATE_LIMIT_WINDOW_SEC } from "@shared/lib/ops-limits";

const HONEYPOT_MAX_LENGTH = 300;

export const FeedbackBodySchema = FeedbackWireFieldsSchema.extend({
  title: z.string().max(100).optional(),
  expectedValue: z.string().max(500).optional(),
  stablecoinId: z.string().max(100).optional(),
  stablecoinName: z.string().max(100).optional(),
  pageUrl: z
    .string()
    .max(300)
    .regex(/^\/(?!\/)[^\r\n]*$/, "Invalid pageUrl"),
  pegValue: z.string().max(100).optional(),
  contactHandle: z.string().max(100).optional(),
  website: z.string().max(HONEYPOT_MAX_LENGTH).optional(),
  acceptedTerms: z.literal(true).optional(),
}).strict();

export type FeedbackBody = z.infer<typeof FeedbackBodySchema>;
export type VerifiedLabel = "verified: confirmed" | "verified: unconfirmed" | "verified: pending";

export interface FeedbackEnv {
  GITHUB_PAT?: string;
  FEEDBACK_IP_SALT?: string;
}

export interface VerificationResult {
  block: string;
  verifiedLabel: VerifiedLabel;
}

export interface PreparedFeedbackSubmission {
  feedback: FeedbackBody;
  pat: string;
  canonicalStablecoinId?: string;
  rateLimitReservation: FeedbackRateLimitReservation;
}

export interface ValidatedFeedbackSubmission {
  feedback: FeedbackBody;
  canonicalStablecoinId?: string;
}

export const GITHUB_OWNER = "TokenBrice";
export const GITHUB_REPO = "pharos-watch";
