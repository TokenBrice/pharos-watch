import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { verifyAccessJwt, apiKeyMocks } = vi.hoisted(() => ({
  verifyAccessJwt: vi.fn(),
  apiKeyMocks: {
    authenticateApiKey: vi.fn(),
    authenticateApiKeyFromFreshCache: vi.fn(),
    checkApiKeyRateLimit: vi.fn(),
    checkIsolateLocalApiKeyRateLimit: vi.fn(),
    isApiKeyRateLimitDependencyCircuitOpen: vi.fn(),
    recordApiKeyRateLimitDependencyFailure: vi.fn(),
    recordApiKeyRateLimitDependencySuccess: vi.fn(),
    recordApiKeyUsage: vi.fn(),
    resolveIsolateFallbackApiKeyRateLimit: vi.fn(),
  },
}));

vi.mock("@shared/lib/cloudflare-access-jwt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/lib/cloudflare-access-jwt")>();
  return { ...actual, verifyAccessJwt };
});

vi.mock("../../../lib/api-key-auth", () => ({
  authenticateApiKey: apiKeyMocks.authenticateApiKey,
  authenticateApiKeyFromFreshCache: apiKeyMocks.authenticateApiKeyFromFreshCache,
}));

vi.mock("../../../lib/api-key-rate-limit", () => ({
  checkApiKeyRateLimit: apiKeyMocks.checkApiKeyRateLimit,
  checkIsolateLocalApiKeyRateLimit: apiKeyMocks.checkIsolateLocalApiKeyRateLimit,
  isApiKeyRateLimitDependencyCircuitOpen: apiKeyMocks.isApiKeyRateLimitDependencyCircuitOpen,
  recordApiKeyRateLimitDependencyFailure: apiKeyMocks.recordApiKeyRateLimitDependencyFailure,
  recordApiKeyRateLimitDependencySuccess: apiKeyMocks.recordApiKeyRateLimitDependencySuccess,
  recordApiKeyUsage: apiKeyMocks.recordApiKeyUsage,
  resolveIsolateFallbackApiKeyRateLimit: apiKeyMocks.resolveIsolateFallbackApiKeyRateLimit,
}));

import {
  checkCachedPublicApiReadFastRateLimit,
  evaluateAccessGate,
  evaluateCachedPublicApiReadFastGate,
  handleMaintenanceMode,
} from "../gates";

const validKey = {
  id: 7,
  keyPrefix: "pharos_test",
  name: "Test key",
  tier: "standard",
  trafficClass: "external",
  rateLimitPerMinute: 60,
};

function parseWarnEvents(warn: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return warn.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

function makeEnv() {
  return {
    CORS_ORIGIN: "https://pharos.watch",
    SITE_API_SHARED_SECRET: "site-secret",
    CF_ACCESS_OPS_API_AUD: "ops-aud",
    CF_ACCESS_TEAM_DOMAIN: "pharos-watch",
  };
}

describe("evaluateAccessGate", () => {
  beforeEach(() => {
    apiKeyMocks.isApiKeyRateLimitDependencyCircuitOpen.mockReturnValue(false);
    apiKeyMocks.recordApiKeyRateLimitDependencyFailure.mockReturnValue({
      consecutiveFailures: 1,
      openUntilMs: 0,
      opened: false,
    });
    apiKeyMocks.resolveIsolateFallbackApiKeyRateLimit.mockImplementation((limit: number) => Math.min(limit, 30));
  });

  afterEach(() => {
    verifyAccessJwt.mockReset();
    for (const mock of Object.values(apiKeyMocks)) {
      mock.mockReset();
    }
  });

  it("preserves Access-authenticated ops-api admin routing", async () => {
    verifyAccessJwt.mockResolvedValueOnce(true);
    const request = new Request("https://ops-api.pharos.watch/api/status", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-access-jwt" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), makeEnv() as never);

    expect(result.response).toBeNull();
    expect(result.isAdmin).toBe(true);
    expect(result.requestLane).toBeNull();
    expect(verifyAccessJwt).toHaveBeenCalledWith({
      token: "valid-access-jwt",
      aud: "ops-aud",
      teamDomain: "pharos-watch",
    });
  });

  it("serves maintenance mode for non-preflight requests only", async () => {
    const env = { MAINTENANCE_MODE: "true" };

    const blocked = handleMaintenanceMode(
      new Request("https://api.pharos.watch/api/stablecoins"),
      env as never,
    );
    const preflight = handleMaintenanceMode(
      new Request("https://api.pharos.watch/api/stablecoins", { method: "OPTIONS" }),
      env as never,
    );

    expect(blocked?.status).toBe(503);
    expect(blocked?.headers.get("Retry-After")).toBe("300");
    await expect(blocked?.json()).resolves.toMatchObject({ error: "maintenance" });
    expect(preflight).toBeNull();
  });

  it("denies site-api admin paths after a valid site-proxy credential", async () => {
    const request = new Request("https://site-api.pharos.watch/api/api-key-requests-admin?limit=1", {
      headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), makeEnv() as never);

    expect(result.response?.status).toBe(404);
    expect(result.requestLane).toBe("site-api");
    expect(result.isSiteProxy).toBe(false);
  });

  it("keeps site-api path rejection ahead of method rejection", async () => {
    const request = new Request("https://site-api.pharos.watch/api/api-key-requests", {
      method: "POST",
      headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), makeEnv() as never);

    expect(result.response?.status).toBe(404);
    expect(result.requestLane).toBe("site-api");
    expect(result.isSiteProxy).toBe(false);
  });

  it("returns 405 for non-GET requests to allowed site-api paths", async () => {
    const request = new Request("https://site-api.pharos.watch/api/stablecoins", {
      method: "POST",
      headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), makeEnv() as never);

    expect(result.response?.status).toBe(405);
    expect(result.response?.headers.get("Allow")).toBe("GET");
    expect(result.requestLane).toBe("site-api");
    expect(result.isSiteProxy).toBe(false);
  });

  it("grants the site-api lane to allowed preview (*.workers.dev) GETs with the site-proxy secret", async () => {
    const request = new Request("https://pharos-watch-preview.workers.dev/api/stablecoins", {
      headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), makeEnv() as never);

    expect(result.isSiteProxy).toBe(true);
    expect(result.requestLane).toBe("site-api");
    expect(result.response).toBeNull();
  });

  it("authenticates protected public API requests and records usage", async () => {
    apiKeyMocks.authenticateApiKey.mockResolvedValueOnce({ kind: "valid", key: validKey });
    apiKeyMocks.checkApiKeyRateLimit.mockResolvedValueOnce(null);
    apiKeyMocks.recordApiKeyUsage.mockResolvedValueOnce(undefined);
    const db = {} as D1Database;
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: { "X-API-Key": "pharos_test_valid" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), {
      ...makeEnv(),
      DB: db,
      API_KEY_HASH_PEPPER: "pepper",
    } as never);

    expect(result.response).toBeNull();
    expect(result.apiKey).toBe(validKey);
    expect(result.requestLane).toBe("public-api");
    expect(apiKeyMocks.checkApiKeyRateLimit).toHaveBeenCalledWith(db, 7, 60);
    expect(apiKeyMocks.recordApiKeyRateLimitDependencySuccess).toHaveBeenCalled();
    expect(apiKeyMocks.recordApiKeyUsage).toHaveBeenCalledWith(db, validKey, "/api/stablecoins");
  });

  it("requires API-key authentication for both V9 preview aliases", async () => {
    apiKeyMocks.authenticateApiKey.mockResolvedValue({ kind: "invalid" });

    for (const path of [
      "/api/report-cards/v9-preview",
      "/api/report-cards/v9-preview-412d818c031b7bc5",
    ]) {
      const request = new Request(`https://api.pharos.watch${path}`);
      const result = await evaluateAccessGate(request, new URL(request.url), makeEnv() as never);

      expect(result.response?.status).toBe(401);
      expect(result.apiKey).toBeNull();
      expect(result.requestLane).toBe("public-api");
    }
    expect(apiKeyMocks.authenticateApiKey).toHaveBeenCalledTimes(2);
  });

  it("uses the isolate-local limiter when public GET rate-limit storage fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    apiKeyMocks.authenticateApiKey.mockResolvedValueOnce({ kind: "valid", key: validKey });
    apiKeyMocks.checkApiKeyRateLimit.mockRejectedValueOnce(new Error("d1 unavailable"));
    apiKeyMocks.checkIsolateLocalApiKeyRateLimit.mockReturnValueOnce(null);
    apiKeyMocks.recordApiKeyUsage.mockResolvedValueOnce(undefined);
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: { "X-API-Key": "pharos_test_valid" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), {
      ...makeEnv(),
      DB: {} as D1Database,
      API_KEY_HASH_PEPPER: "pepper",
    } as never);

    expect(result.response).toBeNull();
    expect(apiKeyMocks.recordApiKeyRateLimitDependencyFailure).toHaveBeenCalled();
    expect(apiKeyMocks.checkIsolateLocalApiKeyRateLimit).toHaveBeenCalledWith(7, 30);
    expect(parseWarnEvents(warn)).toContainEqual(expect.objectContaining({
      event: "api_key_rate_limit_dependency_unavailable_fallback",
      message: "API key rate-limit dependency unavailable; using isolate-local fallback limiter",
      route: "public-api-auth",
      requestLane: "public-api",
      metadata: expect.objectContaining({
        consecutiveFailures: 1,
        circuitOpened: false,
      }),
    }));
    warn.mockRestore();
  });

  it("uses the isolate-local limiter while the public API rate-limit circuit is open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    apiKeyMocks.authenticateApiKey.mockResolvedValueOnce({ kind: "valid", key: validKey });
    apiKeyMocks.isApiKeyRateLimitDependencyCircuitOpen.mockReturnValueOnce(true);
    apiKeyMocks.checkIsolateLocalApiKeyRateLimit.mockReturnValueOnce(null);
    apiKeyMocks.recordApiKeyUsage.mockResolvedValueOnce(undefined);
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: { "X-API-Key": "pharos_test_valid" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), {
      ...makeEnv(),
      DB: {} as D1Database,
      API_KEY_HASH_PEPPER: "pepper",
    } as never);

    expect(result.response).toBeNull();
    expect(apiKeyMocks.checkApiKeyRateLimit).not.toHaveBeenCalled();
    expect(apiKeyMocks.checkIsolateLocalApiKeyRateLimit).toHaveBeenCalledWith(7, 30);
    expect(parseWarnEvents(warn)).toContainEqual(expect.objectContaining({
      event: "api_key_rate_limit_circuit_open_fallback",
      message: "API key rate-limit dependency circuit open; using isolate-local fallback limiter",
      route: "public-api-auth",
      requestLane: "public-api",
    }));
    warn.mockRestore();
  });

  it("fails closed for non-cacheable public API requests while the rate-limit circuit is open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    apiKeyMocks.authenticateApiKey.mockResolvedValueOnce({ kind: "valid", key: validKey });
    apiKeyMocks.isApiKeyRateLimitDependencyCircuitOpen.mockReturnValueOnce(true);
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      method: "POST",
      headers: { "X-API-Key": "pharos_test_valid" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), {
      ...makeEnv(),
      DB: {} as D1Database,
      API_KEY_HASH_PEPPER: "pepper",
    } as never);

    expect(result.response?.status).toBe(503);
    expect(apiKeyMocks.checkApiKeyRateLimit).not.toHaveBeenCalled();
    expect(apiKeyMocks.checkIsolateLocalApiKeyRateLimit).not.toHaveBeenCalled();
    expect(apiKeyMocks.recordApiKeyUsage).not.toHaveBeenCalled();
    expect(parseWarnEvents(warn)).toContainEqual(expect.objectContaining({
      event: "api_key_rate_limit_circuit_open_fail_closed",
      message: "API key rate-limit dependency circuit open; failing closed",
      route: "public-api-auth",
      requestLane: "public-api",
    }));
    warn.mockRestore();
  });

  it("fails closed when non-cacheable public API rate-limit storage fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    apiKeyMocks.authenticateApiKey.mockResolvedValueOnce({ kind: "valid", key: validKey });
    apiKeyMocks.checkApiKeyRateLimit.mockRejectedValueOnce(new Error("d1 unavailable"));
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      method: "POST",
      headers: { "X-API-Key": "pharos_test_valid" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), {
      ...makeEnv(),
      DB: {} as D1Database,
      API_KEY_HASH_PEPPER: "pepper",
    } as never);

    expect(result.response?.status).toBe(503);
    expect(apiKeyMocks.checkIsolateLocalApiKeyRateLimit).not.toHaveBeenCalled();
    expect(apiKeyMocks.recordApiKeyUsage).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns public API dependency errors distinctly from invalid keys", async () => {
    apiKeyMocks.authenticateApiKey.mockResolvedValueOnce({ kind: "unavailable" });
    const unavailableRequest = new Request("https://api.pharos.watch/api/stablecoins");

    const unavailable = await evaluateAccessGate(
      unavailableRequest,
      new URL(unavailableRequest.url),
      { ...makeEnv(), DB: {} as D1Database } as never,
    );

    apiKeyMocks.authenticateApiKey.mockResolvedValueOnce({ kind: "invalid" });
    const invalidRequest = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: { "X-API-Key": "bad" },
    });

    const invalid = await evaluateAccessGate(
      invalidRequest,
      new URL(invalidRequest.url),
      { ...makeEnv(), DB: {} as D1Database } as never,
    );

    expect(unavailable.response?.status).toBe(503);
    expect(unavailable.response?.headers.get("Retry-After")).toBeTruthy();
    expect(invalid.response?.status).toBe(401);
  });

  it("accepts fresh cached API-key auth only for eligible public GETs", async () => {
    apiKeyMocks.authenticateApiKeyFromFreshCache.mockResolvedValueOnce({ kind: "valid", key: validKey });
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: { "X-API-Key": "pharos_test_valid" },
    });

    const accepted = await evaluateCachedPublicApiReadFastGate(
      request,
      new URL(request.url),
      { ...makeEnv(), API_KEY_HASH_PEPPER: "pepper" } as never,
    );

    const adminRequest = new Request("https://ops-api.pharos.watch/api/stablecoins", {
      headers: { "X-API-Key": "pharos_test_valid" },
    });
    const bypassed = await evaluateCachedPublicApiReadFastGate(
      adminRequest,
      new URL(adminRequest.url),
      { ...makeEnv(), API_KEY_HASH_PEPPER: "pepper" } as never,
    );

    expect(accepted?.apiKey).toBe(validKey);
    expect(accepted?.requestLane).toBe("public-api");
    expect(bypassed).toBeNull();
  });

  it("applies the isolate-local limiter to cached public reads", () => {
    const rateLimitResponse = new Response("limited", { status: 429 });
    apiKeyMocks.checkIsolateLocalApiKeyRateLimit.mockReturnValueOnce(rateLimitResponse);

    expect(checkCachedPublicApiReadFastRateLimit(validKey as never)).toBe(rateLimitResponse);
    expect(apiKeyMocks.checkIsolateLocalApiKeyRateLimit).toHaveBeenCalledWith(7, 60);
  });

  it("caps cached public reads while the API-key rate-limit circuit is open", () => {
    apiKeyMocks.isApiKeyRateLimitDependencyCircuitOpen.mockReturnValueOnce(true);
    apiKeyMocks.resolveIsolateFallbackApiKeyRateLimit.mockReturnValueOnce(30);
    apiKeyMocks.checkIsolateLocalApiKeyRateLimit.mockReturnValueOnce(null);

    expect(checkCachedPublicApiReadFastRateLimit({ ...validKey, rateLimitPerMinute: 180 } as never)).toBeNull();
    expect(apiKeyMocks.resolveIsolateFallbackApiKeyRateLimit).toHaveBeenCalledWith(180);
    expect(apiKeyMocks.checkIsolateLocalApiKeyRateLimit).toHaveBeenCalledWith(7, 30);
  });
});
