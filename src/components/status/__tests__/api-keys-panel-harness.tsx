import { afterEach, beforeEach, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ApiKeyListResponse, ApiKeySummary } from "@shared/types";

const { useApiKeysMock, useApiKeyAuditLogMock } = vi.hoisted(() => ({
  useApiKeysMock: vi.fn(),
  useApiKeyAuditLogMock: vi.fn(),
}));

vi.mock("@/hooks/admin-api-hooks", () => ({ useApiKeys: useApiKeysMock, useApiKeyAuditLog: useApiKeyAuditLogMock }));

export const { ApiKeysPanel } = await import("../api-keys-panel");
export const GENERATED_AT = 1_700_000_000;

export function getApiKeysMock() {
  return useApiKeysMock;
}

export function getApiKeyAuditLogMock() {
  return useApiKeyAuditLogMock;
}

export function makeKey(overrides: Partial<ApiKeySummary> = {}): ApiKeySummary {
  return {
    id: overrides.id ?? 1,
    keyPrefix: overrides.keyPrefix ?? "0123456789abcdef",
    maskedToken: overrides.maskedToken ?? "ph_live_0123456789abcdef_********",
    name: overrides.name ?? "Ops Key",
    ownerEmail: overrides.ownerEmail ?? "ops@pharos.watch",
    tier: overrides.tier ?? "standard",
    trafficClass: overrides.trafficClass ?? "external",
    rateLimitPerMinute: overrides.rateLimitPerMinute ?? 120,
    isActive: overrides.isActive ?? true,
    expiresAt: overrides.expiresAt === undefined ? GENERATED_AT + 2 * 24 * 60 * 60 : overrides.expiresAt,
    createdAt: overrides.createdAt ?? GENERATED_AT - 100,
    updatedAt: overrides.updatedAt ?? GENERATED_AT - 50,
    lastUsedAt: overrides.lastUsedAt ?? null,
    lastUsedRoute: overrides.lastUsedRoute ?? null,
  };
}

export function renderPanel(keys: ApiKeySummary[], refetch = vi.fn().mockResolvedValue(undefined)) {
  const data: ApiKeyListResponse = { generatedAt: GENERATED_AT, keys };
  useApiKeysMock.mockReturnValue({ data, error: null, isLoading: false, refetch });
  render(<ApiKeysPanel />);
  return { refetch };
}

export function requestIdempotencyKey(callIndex: number): string | null {
  const fetchMock = vi.mocked(fetch);
  const [, init] = fetchMock.mock.calls[callIndex] ?? [];
  return new Headers(init?.headers).get("Idempotency-Key");
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  useApiKeyAuditLogMock.mockReturnValue({
    data: { entries: [] },
    error: null,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
