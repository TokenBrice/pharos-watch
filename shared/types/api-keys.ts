import { z } from "zod";

export type ApiKeyTrafficClass = "external" | "site";

export const ApiKeyTrafficClassSchema = z.enum(["external", "site"]);

/**
 * Issuance tiers. Only these two are writable: `standard` for operator-created
 * keys and `self-serve` for the verified public issuance path.
 */
export const API_KEY_TIER_VALUES = ["standard", "self-serve"] as const;
export type ApiKeyTier = (typeof API_KEY_TIER_VALUES)[number];
export const ApiKeyTierSchema = z.enum(API_KEY_TIER_VALUES);

export interface ApiKeySummary {
  id: number;
  keyPrefix: string;
  maskedToken: string;
  name: string;
  ownerEmail: string | null;
  /** Read surface stays a plain string: rows written before the tier union narrowed keep their legacy value. */
  tier: string;
  /**
   * Descriptive attribution label only. The real request lane is derived per
   * request in `worker/src/handlers/http/gates.ts`; no issuance path assigns
   * anything other than "external" any more.
   */
  trafficClass: ApiKeyTrafficClass;
  rateLimitPerMinute: number;
  isActive: boolean;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  lastUsedRoute: string | null;
}

export interface ApiKeyListResponse {
  generatedAt: number;
  keys: ApiKeySummary[];
}

export const ApiKeySummarySchema = z.object({
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

export const ApiKeyListResponseSchema: z.ZodType<ApiKeyListResponse> = z.object({
  generatedAt: z.number(),
  keys: z.array(ApiKeySummarySchema),
});

export interface ApiKeyAuditEntry {
  id: number;
  apiKeyId: number;
  action: string;
  actor: string;
  detail: unknown;
  createdAt: number;
}

export interface ApiKeyAuditLogResponse {
  entries: ApiKeyAuditEntry[];
}

export interface CredentialLifecycleSummaryResponse {
  generatedAt: number;
  totalKeys: number;
  active: number;
  expiringSoon: number;
  expired: number;
  nonExpiring: number;
  auditAnomalies7d: number | null;
}

export const ApiKeyAuditEntrySchema: z.ZodType<ApiKeyAuditEntry> = z.object({
  id: z.number(),
  apiKeyId: z.number(),
  action: z.string(),
  actor: z.string(),
  detail: z.unknown(),
  createdAt: z.number(),
});

export const ApiKeyAuditLogResponseSchema: z.ZodType<ApiKeyAuditLogResponse> = z.object({
  entries: z.array(ApiKeyAuditEntrySchema),
});

export const CredentialLifecycleSummaryResponseSchema: z.ZodType<CredentialLifecycleSummaryResponse> = z.object({
  generatedAt: z.number(),
  totalKeys: z.number(),
  active: z.number(),
  expiringSoon: z.number(),
  expired: z.number(),
  nonExpiring: z.number(),
  auditAnomalies7d: z.number().nullable(),
});

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
