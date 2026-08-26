import { z } from "zod";

const ApiKeySelfServeStatusSchema = z.enum([
  "pending_verification",
  "issued",
  "rejected",
  "blocked",
  "expired",
]);
export type ApiKeySelfServeStatus = z.infer<typeof ApiKeySelfServeStatusSchema>;

const ApiKeySelfServeClaimStatusSchema = z.enum(["pending_verification", "issued", "released"]);
export type ApiKeySelfServeClaimStatus = z.infer<typeof ApiKeySelfServeClaimStatusSchema>;

const API_KEY_SELF_SERVE_CADENCE_VALUES = [
  "hourly",
  "every_5_min",
  "every_1_min",
  "manual",
  "other",
] as const;
export const ApiKeySelfServeCadenceSchema = z.enum(API_KEY_SELF_SERVE_CADENCE_VALUES);
export type ApiKeySelfServeCadence = z.infer<typeof ApiKeySelfServeCadenceSchema>;

export interface ApiKeySelfServeRequest {
  email: string;
  requesterName?: string;
  organization?: string;
  projectUrl?: string;
  useCase: string;
  expectedCadence: ApiKeySelfServeCadence;
  expectedVolume?: string;
  acceptedTerms: boolean;
  website?: string;
}


const ApiKeySelfServeNonEmptyStringSchema = z.string().refine((value) => value.trim().length > 0);

export const ApiKeySelfServePendingResponseSchema = z.object({
  status: z.literal("pending_verification"),
}).passthrough();
export type ApiKeySelfServePendingResponse = z.output<typeof ApiKeySelfServePendingResponseSchema>;

// shared/types must not import shared/lib, so the expected self-serve rate
// limit is supplied by the caller (see SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE
// in @shared/lib/ops-limits) instead of being imported here.
export function buildApiKeySelfServeIssueResponseSchema(
  expectedRateLimitPerMinute: number,
) {
  return z.object({
    status: z.literal("issued"),
    key: z.object({
      keyPrefix: ApiKeySelfServeNonEmptyStringSchema,
      maskedToken: ApiKeySelfServeNonEmptyStringSchema,
      tier: z.literal("self-serve"),
      trafficClass: z.literal("external"),
      rateLimitPerMinute: z.literal(expectedRateLimitPerMinute),
      expiresAt: z.number().nullable(),
    }).passthrough(),
    token: ApiKeySelfServeNonEmptyStringSchema,
  }).passthrough();
}
export type ApiKeySelfServeIssueResponse = z.output<ReturnType<typeof buildApiKeySelfServeIssueResponseSchema>>;

const ApiKeySelfServeRequestAdminSummarySchema = z.object({
  requestId: z.string(),
  status: ApiKeySelfServeStatusSchema,
  email: z.string(),
  requesterName: z.string().nullable(),
  organization: z.string().nullable(),
  projectUrl: z.string().nullable(),
  useCase: z.string(),
  expectedCadence: z.string().nullable(),
  expectedVolume: z.string().nullable(),
  acceptedTerms: z.boolean(),
  emailVerified: z.boolean(),
  linkedKeyId: z.number().nullable(),
  linkedKeyPrefix: z.string().nullable(),
  linkedKeyActive: z.boolean().nullable(),
  linkedKeyExpiresAt: z.number().nullable(),
  rateLimitPerMinute: z.number(),
  selfServeExpiresAt: z.number().nullable(),
  claimStatus: ApiKeySelfServeClaimStatusSchema.nullable(),
  verificationSentAt: z.number().nullable(),
  verificationExpiresAt: z.number().nullable(),
  issuedAt: z.number().nullable(),
  rejectedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ApiKeySelfServeRequestAdminSummary = z.output<typeof ApiKeySelfServeRequestAdminSummarySchema>;

export const ApiKeySelfServeRequestAdminListResponseSchema = z.object({
  generatedAt: z.number(),
  requests: z.array(ApiKeySelfServeRequestAdminSummarySchema),
});
export type ApiKeySelfServeRequestAdminListResponse = z.output<typeof ApiKeySelfServeRequestAdminListResponseSchema>;

export interface ApiKeySelfServeAdminMutationResponse {
  ok: true;
  requestId: string;
  status: ApiKeySelfServeStatus;
  claimStatus: ApiKeySelfServeClaimStatus | null;
}
