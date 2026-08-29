import { z } from "zod";

export const FEEDBACK_TYPES = ["bug", "data-correction", "feature-request"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

const FeedbackTypeSchema = z.enum(FEEDBACK_TYPES, {
  message: "Invalid feedback type",
});

/** Shared feedback fields; runtime boundaries add their own validation depth. */
export const FeedbackWireFieldsSchema = z.object({
  type: FeedbackTypeSchema,
  title: z.string().optional(),
  description: z
    .string()
    .min(10, "Description must be 10–2000 characters")
    .max(2000, "Description must be 10–2000 characters"),
  expectedValue: z.string().optional(),
  stablecoinId: z.string().optional(),
  stablecoinName: z.string().optional(),
  pageUrl: z.string(),
  pegValue: z.string().optional(),
  contactHandle: z.string().optional(),
  website: z.string().optional(),
  // Retained for payloads from older feedback bundles; the current UI does
  // not send these fields and the Worker does not act on them.
  contactConsent: z.boolean().optional(),
  contactChannel: z.enum(["telegram", "x"]).optional(),
  // Optional keeps current and legacy feedback bundles valid. New callers
  // that send it must acknowledge the terms explicitly at the Worker edge.
  acceptedTerms: z.boolean().optional(),
});

export const FeedbackResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
export type FeedbackResponse = z.infer<typeof FeedbackResponseSchema>;
