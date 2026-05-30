import { z } from "zod";

export type ApiKeySelfServeStatus =
  | "pending_verification"
  | "issued"
  | "rejected"
  | "blocked"
  | "expired";

export type ApiKeySelfServeClaimStatus = "pending_verification" | "issued" | "released";

export const ApiKeySelfServeStatusSchema = z.enum([
  "pending_verification",
  "issued",
  "rejected",
  "blocked",
  "expired",
]);

export const ApiKeySelfServeClaimStatusSchema = z.enum(["pending_verification", "issued", "released"]);

export type ApiKeySelfServeCadence =
  | "hourly"
  | "every_5_min"
  | "every_1_min"
  | "manual"
  | "other";

export interface ApiKeySelfServeRequest {
  email: string;
  requesterName?: string;
  organization?: string;
  projectUrl?: string;
  useCase: string;
  intendedEndpoints?: string[];
  expectedCadence: ApiKeySelfServeCadence;
  expectedVolume?: string;
  acceptedTerms: boolean;
  website?: string;
}

export interface ApiKeySelfServePendingResponse {
  status: "pending_verification";
  message: string;
}

export interface ApiKeySelfServeVerifyRequest {
  token: string;
}

export interface ApiKeySelfServeIssueResponse {
  status: "issued";
  key: {
    keyPrefix: string;
    maskedToken: string;
    tier: "self-serve";
    trafficClass: "external";
    rateLimitPerMinute: 30;
    expiresAt: number | null;
  };
  token: string;
  usage: {
    baseUrl: string;
    headerName: string;
    retryGuidance: string;
  };
}

export interface ApiKeySelfServeRequestAdminSummary {
  requestId: string;
  status: ApiKeySelfServeStatus;
  email: string;
  requesterName: string | null;
  organization: string | null;
  projectUrl: string | null;
  useCase: string;
  intendedEndpoints: string[];
  expectedCadence: string | null;
  expectedVolume: string | null;
  acceptedTerms: boolean;
  emailVerified: boolean;
  linkedKeyId: number | null;
  linkedKeyPrefix: string | null;
  linkedKeyActive: boolean | null;
  linkedKeyExpiresAt: number | null;
  rateLimitPerMinute: number;
  selfServeExpiresAt: number | null;
  riskScore: number;
  riskReasons: string[];
  claimStatus: ApiKeySelfServeClaimStatus | null;
  verificationSentAt: number | null;
  verificationExpiresAt: number | null;
  issuedAt: number | null;
  rejectedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ApiKeySelfServeRequestAdminListResponse {
  generatedAt: number;
  requests: ApiKeySelfServeRequestAdminSummary[];
}

export const ApiKeySelfServeRequestAdminSummarySchema = z.object({
  requestId: z.string(),
  status: ApiKeySelfServeStatusSchema,
  email: z.string(),
  requesterName: z.string().nullable(),
  organization: z.string().nullable(),
  projectUrl: z.string().nullable(),
  useCase: z.string(),
  intendedEndpoints: z.array(z.string()),
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
  riskScore: z.number(),
  riskReasons: z.array(z.string()),
  claimStatus: ApiKeySelfServeClaimStatusSchema.nullable(),
  verificationSentAt: z.number().nullable(),
  verificationExpiresAt: z.number().nullable(),
  issuedAt: z.number().nullable(),
  rejectedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const ApiKeySelfServeRequestAdminListResponseSchema: z.ZodType<ApiKeySelfServeRequestAdminListResponse> = z.object({
  generatedAt: z.number(),
  requests: z.array(ApiKeySelfServeRequestAdminSummarySchema),
});

export interface ApiKeySelfServeAdminMutationResponse {
  ok: true;
  requestId: string;
  status: ApiKeySelfServeStatus;
  claimStatus: ApiKeySelfServeClaimStatus | null;
}
