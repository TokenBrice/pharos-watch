import type { ApiKeyListResponse, ApiKeySummary } from "@shared/types";
import { STATUS_FIXTURE_NOW_SECONDS } from "./status-fixtures";

export function makeApiKeySummary(index: number, overrides: Partial<ApiKeySummary> = {}): ApiKeySummary {
  const sequence = String(index + 1).padStart(3, "0");
  return {
    id: index + 1,
    keyPrefix: `fx_${sequence}`,
    maskedToken: `fx_${sequence}...fixture`,
    name: `Fixture integration ${sequence}`,
    ownerEmail: `operator-${sequence}@example.invalid`,
    tier: index % 5 === 0 ? "internal" : "standard",
    trafficClass: index % 4 === 0 ? "site" : "external",
    rateLimitPerMinute: 60 + (index % 5) * 30,
    isActive: index % 9 !== 0,
    expiresAt: index % 7 === 0 ? null : STATUS_FIXTURE_NOW_SECONDS + (index + 1) * 86_400,
    createdAt: STATUS_FIXTURE_NOW_SECONDS - (index + 30) * 86_400,
    updatedAt: STATUS_FIXTURE_NOW_SECONDS - index * 3_600,
    lastUsedAt: index % 6 === 0 ? null : STATUS_FIXTURE_NOW_SECONDS - index * 900,
    lastUsedRoute: index % 6 === 0 ? null : `/api/fixture-resource/${sequence}`,
    ...overrides,
  };
}

export function makeLargeApiKeyInventory(count = 75): ApiKeyListResponse {
  const safeCount = Math.max(0, Math.floor(count));
  return {
    generatedAt: STATUS_FIXTURE_NOW_SECONDS,
    keys: Array.from({ length: safeCount }, (_, index) => makeApiKeySummary(index)),
  };
}
