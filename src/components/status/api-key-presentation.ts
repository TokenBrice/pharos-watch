import type { ApiKeySummary } from "@pharos/contracts/api-keys";

export function apiKeyAccessibleIdentity(apiKey: ApiKeySummary): string {
  return `${apiKey.name} (${apiKey.maskedToken}, ID ${apiKey.id})`;
}
