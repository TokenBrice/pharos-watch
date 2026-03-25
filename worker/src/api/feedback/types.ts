import { z } from "zod";

export const FeedbackBodySchema = z.object({
  type: z.enum(["bug", "data-correction", "feature-request"], {
    message: "Invalid feedback type",
  }),
  title: z.string().max(100).optional(),
  description: z
    .string()
    .min(10, "Description must be 10–2000 characters")
    .max(2000, "Description must be 10–2000 characters"),
  expectedValue: z.string().max(500).optional(),
  stablecoinId: z.string().max(100).optional(),
  stablecoinName: z.string().max(100).optional(),
  pageUrl: z.string().startsWith("/", "Invalid pageUrl").max(300),
  pegValue: z.string().max(100).optional(),
  contactHandle: z.string().max(100).optional(),
  website: z.string().optional(),
});

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
}

export const GITHUB_OWNER = "TokenBrice";
export const GITHUB_REPO = "stablecoin-dashboard";
export const FEEDBACK_RATE_LIMIT_WINDOW_SEC = 600;
export const FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS = 3;
