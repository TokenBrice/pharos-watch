import type { ApiKeySummary } from "@shared/types";

export function apiKeyAccessibleIdentity(apiKey: ApiKeySummary): string {
  return `${apiKey.name} (${apiKey.maskedToken}, ID ${apiKey.id})`;
}
