import { z } from "zod";

export const ApiKeyTrafficClassSchema = z.enum(["external", "site"]);
export type ApiKeyTrafficClass = z.infer<typeof ApiKeyTrafficClassSchema>;

/**
 * Issuance tiers. Only these two are writable: `standard` for operator-created
 * keys and `self-serve` for the verified public issuance path.
 */
export const API_KEY_TIER_VALUES = ["standard", "self-serve"] as const;
export type ApiKeyTier = (typeof API_KEY_TIER_VALUES)[number];

const ApiKeySummarySchema = z.object({
  id: z.number(),
  keyPrefix: z.string(),
  maskedToken: z.string(),
  name: z.string(),
  ownerEmail: z.string().nullable(),
  tier: z.string(),
  trafficClass: ApiKeyTrafficClassSchema,
  rateLimitPerMinute: z.number(),
  isActive: z.boolean(),
  expiresAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number().nullable(),
  lastUsedRoute: z.string().nullable(),
});
export type ApiKeySummary = z.output<typeof ApiKeySummarySchema>;

export const ApiKeyListResponseSchema = z.object({
  generatedAt: z.number(),
  keys: z.array(ApiKeySummarySchema),
});
export type ApiKeyListResponse = z.output<typeof ApiKeyListResponseSchema>;

const ApiKeyAuditEntrySchema = z.object({
  id: z.number(),
  apiKeyId: z.number(),
  action: z.string(),
  actor: z.string(),
  detail: z.unknown(),
  createdAt: z.number(),
});
export type ApiKeyAuditEntry = z.output<typeof ApiKeyAuditEntrySchema>;

export const ApiKeyAuditLogResponseSchema = z.object({
  entries: z.array(ApiKeyAuditEntrySchema),
});
export type ApiKeyAuditLogResponse = z.output<typeof ApiKeyAuditLogResponseSchema>;

export const CredentialLifecycleSummaryResponseSchema = z.object({
  generatedAt: z.number(),
  totalKeys: z.number(),
  active: z.number(),
  expiringSoon: z.number(),
  expired: z.number(),
  nonExpiring: z.number(),
  auditAnomalies7d: z.number().nullable(),
});
export type CredentialLifecycleSummaryResponse = z.output<typeof CredentialLifecycleSummaryResponseSchema>;

export interface ApiKeyCreateRequest {
  name: string;
  ownerEmail?: string | null;
  tier?: ApiKeyTier | null;
  rateLimitPerMinute?: number | null;
  expiresAt?: number | null;
}

export interface ApiKeyUpdateRequest {
  name?: string | null;
  ownerEmail?: string | null;
  tier?: ApiKeyTier | null;
  rateLimitPerMinute?: number | null;
  isActive?: boolean | null;
  expiresAt?: number | null;
}

export interface ApiKeyMutationResponse {
  key: ApiKeySummary;
}

export interface ApiKeyCreateResponse extends ApiKeyMutationResponse {
  token: string;
}

export interface ApiKeyRotateResponse extends ApiKeyMutationResponse {
  token: string;
}
