export type ApiKeyTrafficClass = "external" | "site";

export interface ApiKeySummary {
  id: number;
  keyPrefix: string;
  maskedToken: string;
  name: string;
  ownerEmail: string | null;
  tier: string;
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

export interface ApiKeyCreateRequest {
  name: string;
  ownerEmail?: string | null;
  tier?: string | null;
  trafficClass?: ApiKeyTrafficClass | null;
  rateLimitPerMinute?: number | null;
  expiresAt?: number | null;
}

export interface ApiKeyUpdateRequest {
  name?: string | null;
  ownerEmail?: string | null;
  tier?: string | null;
  trafficClass?: ApiKeyTrafficClass | null;
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
