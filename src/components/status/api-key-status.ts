import { OPERATIONAL_PILL_CLASS } from "@/lib/status/dashboard-presentation";

export type ApiKeyStatus = "inactive" | "expired" | "active";

export interface ApiKeyStatusInput {
  isActive: boolean;
  expiresAt: number | null;
}

export function getApiKeyStatus(key: ApiKeyStatusInput, nowSeconds: number): ApiKeyStatus {
  if (!key.isActive) {
    return "inactive";
  }
  if (key.expiresAt != null && key.expiresAt <= nowSeconds) {
    return "expired";
  }
  return "active";
}

export function apiKeyStatusBadgeClassName(status: ApiKeyStatus): string {
  if (status === "active") {
    return OPERATIONAL_PILL_CLASS.ok;
  }
  if (status === "expired") {
    return OPERATIONAL_PILL_CLASS.error;
  }
  return OPERATIONAL_PILL_CLASS.unknown;
}
