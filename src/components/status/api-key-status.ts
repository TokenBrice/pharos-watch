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
    return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
  }
  if (status === "expired") {
    return "bg-red-500/15 text-red-700 dark:text-red-400";
  }
  return "bg-muted text-muted-foreground";
}

