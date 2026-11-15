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
    getCachedApiKeyByPrefix: vi.fn(),
  },
}));

vi.mock("@shared/lib/cloudflare-access-jwt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/lib/cloudflare-access-jwt")>();
  return { ...actual, verifyAccessJwt };
});

vi.mock("../../../lib/api-key-auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/api-key-auth")>(),
  authenticateApiKey: apiKeyMocks.authenticateApiKey,
  authenticateApiKeyFromFreshCache: apiKeyMocks.authenticateApiKeyFromFreshCache,
}));

vi.mock("../../../lib/api-key-core", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/api-key-core")>(),
  getCachedApiKeyByPrefix: apiKeyMocks.getCachedApiKeyByPrefix,
  isApiKeyRateLimitDependencyCircuitOpen: apiKeyMocks.isApiKeyRateLimitDependencyCircuitOpen,
  recordApiKeyRateLimitDependencyFailure: apiKeyMocks.recordApiKeyRateLimitDependencyFailure,
  recordApiKeyRateLimitDependencySuccess: apiKeyMocks.recordApiKeyRateLimitDependencySuccess,
}));

vi.mock("../../../lib/api-key-rate-limit", () => ({
  checkApiKeyRateLimit: apiKeyMocks.checkApiKeyRateLimit,
  checkIsolateLocalApiKeyRateLimit: apiKeyMocks.checkIsolateLocalApiKeyRateLimit,
  recordApiKeyUsage: apiKeyMocks.recordApiKeyUsage,
  resolveIsolateFallbackApiKeyRateLimit: apiKeyMocks.resolveIsolateFallbackApiKeyRateLimit,
}));

import {
  checkCachedPublicApiReadFastRateLimit,
  evaluateAccessGate,
  evaluateCachedPublicApiReadFastGate,
  handleMaintenanceMode,
} from "../gates";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeApiKeyPrefixLookup, makeAuthenticatedApiKeyRow } from "../../../test-helpers/api-key-test-support";
import { clearApiKeyCache, lookupApiKeyByPrefix, resetApiKeyStateForTests } from "../../../lib/api-key-core";
import { createWorkerEnv } from "../../../test-helpers/__shared/worker-env";

async function useRealApiKeyAuth() {
  apiKeyMocks.authenticateApiKey.mockImplementation((await vi.importActual<typeof import("../../../lib/api-key-auth")>("../../../lib/api-key-auth")).authenticateApiKey);
  apiKeyMocks.getCachedApiKeyByPrefix.mockImplementation((await vi.importActual<typeof import("../../../lib/api-key-core")>("../../../lib/api-key-core")).getCachedApiKeyByPrefix);
}

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
  return createWorkerEnv({
    SITE_API_SHARED_SECRET: "site-secret",
    CF_ACCESS_OPS_API_AUD: "ops-aud",
    CF_ACCESS_TEAM_DOMAIN: "pharos-watch",
  });
}

describe("evaluateAccessGate", () => {
  beforeEach(() => {
    resetApiKeyStateForTests();
    apiKeyMocks.isApiKeyRateLimitDependencyCircuitOpen.mockReturnValue(false);
    apiKeyMocks.recordApiKeyRateLimitDependencyFailure.mockReturnValue({
      consecutiveFailures: 1,
      openUntilMs: 0,
      opened: false,
    });
    apiKeyMocks.resolveIsolateFallbackApiKeyRateLimit.mockImplementation((limit: number) => Math.min(limit, 30));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetApiKeyStateForTests();
    verifyAccessJwt.mockReset();
    for (const mock of Object.values(apiKeyMocks)) {
      mock.mockReset();
    }
  });

  it.each(["/api/safety-grades", "/api/dependency-graph/v1", "/api/dependency-scenarios/v1"])("limits anonymous %s before reading data and fails closed", async (path) => {
    const env = makeEnv();
    const limit = vi.fn().mockResolvedValue({ success: true });
    env.SAFETY_GRADES_RATE_LIMIT = { limit };
    const request = new Request(`https://api.pharos.watch${path}`, { headers: { "CF-Connecting-IP": "192.0.2.1" } });
    expect((await evaluateAccessGate(request, new URL(request.url), env)).response).toBeNull();
    expect(limit).toHaveBeenCalledWith({ key: "192.0.2.1" });
    expect(apiKeyMocks.authenticateApiKey).not.toHaveBeenCalled();
    limit.mockResolvedValueOnce({ success: false });
    expect((await evaluateAccessGate(request, new URL(request.url), env)).response?.status).toBe(429);
    limit.mockRejectedValueOnce(new Error("unavailable"));
    expect((await evaluateAccessGate(request, new URL(request.url), env)).response?.status).toBe(503);
    env.SAFETY_GRADES_RATE_LIMIT = undefined as never;
    expect((await evaluateAccessGate(request, new URL(request.url), env)).response?.status).toBe(503);
  });

  it.each([false, true])("shares IPv6 /64 anonymous buckets (Pages=%s)", async (siteProxy) => {
    const env = makeEnv();
    const limit = vi.fn().mockResolvedValue({ success: true });
    env.SAFETY_GRADES_RATE_LIMIT = { limit };
    for (const ip of ["2001:db8:1:2::1", "2001:0DB8:1:0002:ffff::abcd"]) {
      const request = new Request(`https://${siteProxy ? "site-api" : "api"}.pharos.watch/api/dependency-scenarios/v1`, {
        headers: { "CF-Connecting-IP": siteProxy ? "192.0.2.1" : ip,
          ...(siteProxy ? { "X-Pharos-Site-Proxy-Secret": "site-secret", "X-Pharos-Client-IP": ip } : {}) },
      });
      expect((await evaluateAccessGate(request, new URL(request.url), env)).response).toBeNull();
    }
    expect(limit.mock.calls).toEqual([[{ key: "2001:db8:1:2::/64" }], [{ key: "2001:db8:1:2::/64" }]]);
  });

  it("blocks uncached prefixes after invalid attempts until the minute ends", async () => {
    await useRealApiKeyAuth();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(60_000);
    const env = makeEnv();
    env.API_KEY_HASH_PEPPER = "pepper";
    const limit = vi.fn().mockResolvedValueOnce({ success: true }).mockResolvedValue({ success: false });
    env.API_KEY_LOOKUP_RATE_LIMIT = { limit };
    env.DB = mockD1([makeApiKeyPrefixLookup({ prefix: "0123456789abcdef" }),
      makeApiKeyPrefixLookup({ prefix: "fedcba9876543210" })]);
    const request = (prefix: string, ip = "2001:db8:1:2::1") => new Request("https://api.pharos.watch/api/stablecoins", {
      headers: { "CF-Connecting-IP": ip, "X-API-Key": `ph_live_${prefix}_abcdefghijklmnopqrstuvwxyzABCDEF` },
    });
    const first = request("0123456789abcdef");
    expect((await evaluateAccessGate(first, new URL(first.url), env)).response?.status).toBe(401);
    const rotated = request("fedcba9876543210", "2001:0db8:1:0002::ffff");
    const denied = (await evaluateAccessGate(rotated, new URL(rotated.url), env)).response;
    expect(denied?.status).toBe(429);
    expect(denied?.headers.get("Retry-After")).toBe("60");
    const reads = () => (env.DB as ReturnType<typeof mockD1>).getHistory().length;
    expect(reads()).toBe(2);
    expect((await evaluateAccessGate(first, new URL(first.url), env)).response?.status).toBe(429);
    expect(reads()).toBe(2);
    expect(apiKeyMocks.authenticateApiKey).toHaveBeenCalledTimes(2);
    expect(limit.mock.calls).toEqual([[{ key: "2001:db8:1:2::/64" }], [{ key: "2001:db8:1:2::/64" }]]);
    env.DB = mockD1([makeApiKeyPrefixLookup({ row: await makeAuthenticatedApiKeyRow() }),
      makeApiKeyPrefixLookup({ prefix: "fedcba9876543210" })]);
    await lookupApiKeyByPrefix(env.DB, "0123456789abcdef");
    expect((await evaluateAccessGate(first, new URL(first.url), env)).response).toBeNull();
    const malformed = request("bad");
    expect((await evaluateAccessGate(malformed, new URL(malformed.url), env)).response?.status).toBe(401);
    expect(limit).toHaveBeenCalledTimes(2);
    vi.setSystemTime(120_000);
    limit.mockResolvedValue({ success: true });
    expect((await evaluateAccessGate(rotated, new URL(rotated.url), env)).response?.status).toBe(401);
    expect(limit).toHaveBeenCalledTimes(3);
  });

  it.each([["standard", "pepper"], ["donor", "old"], ["self-serve", "old"]])("rejects cached wrong secrets without D1 and never charges valid %s keys", async (tier, pepper) => {
    await useRealApiKeyAuth();
    const env = makeEnv();
    env.API_KEY_HASH_PEPPER = "pepper";
    env.API_KEY_HASH_PEPPER_PREVIOUS = "old";
    const limit = vi.fn().mockResolvedValue({ success: true });
    env.API_KEY_LOOKUP_RATE_LIMIT = { limit };
    const db = mockD1([makeApiKeyPrefixLookup({ row: await makeAuthenticatedApiKeyRow({ tier, pepper }) }),
      { match: "api_key_self_serve_revocations", rows: [] }, { match: "UPDATE api_keys", rows: [] }]);
    env.DB = db;
    const request = (secret: string) => new Request("https://api.pharos.watch/api/stablecoins", {
      headers: { "X-API-Key": `ph_live_0123456789abcdef_${secret}` },
    });
    const wrong = request("_".repeat(32));
    for (let i = 0; i < 10; i++) expect((await evaluateAccessGate(wrong, new URL(wrong.url), env)).response?.status).toBe(401);
    const reads = () => db.getHistory().filter(({ sql }) => sql.includes("FROM api_keys")).length;
    expect(reads()).toBe(1);
    expect(limit).toHaveBeenCalledTimes(10);
    limit.mockResolvedValue({ success: false });
    const valid = request("abcdefghijklmnopqrstuvwxyzABCDEF");
    for (let i = 0; i < 2; i++) {
      clearApiKeyCache("0123456789abcdef");
      expect((await evaluateAccessGate(valid, new URL(valid.url), env)).response).toBeNull();
    }
    expect(reads()).toBe(3);
    expect(limit).toHaveBeenCalledTimes(10);
  });

  it.each(["missing", "throws"])("authenticates when lookup limiter %s", async (mode) => {
    const env = makeEnv();
    env.API_KEY_HASH_PEPPER = "pepper";
    env.API_KEY_LOOKUP_RATE_LIMIT = mode === "missing" ? undefined : { limit: vi.fn().mockRejectedValue(new Error("offline")) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    apiKeyMocks.authenticateApiKey.mockResolvedValue({ kind: "valid", key: validKey });
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: { "X-API-Key": "ph_live_0123456789abcdef_abcdefghijklmnopqrstuvwxyzABCDEF" },
    });
    expect((await evaluateAccessGate(request, new URL(request.url), env)).response).toBeNull();
    expect(apiKeyMocks.authenticateApiKey).toHaveBeenCalledOnce();
    apiKeyMocks.authenticateApiKey.mockResolvedValue({ kind: "invalid" });
    expect((await evaluateAccessGate(request, new URL(request.url), env)).response?.status).toBe(401);
    expect(parseWarnEvents(warn)).toContainEqual(expect.objectContaining({ event: "api_key_lookup_rate_limit_unavailable" }));
    warn.mockRestore();
  });

  it.each(["site-api.pharos.watch", "pharos-api.example.workers.dev"])(
    "limits uncached scenarios on the credentialed Pages/preview lane %s", async (hostname) => {
      const env = makeEnv();
      const limit = vi.fn().mockResolvedValue({ success: false });
      env.SAFETY_GRADES_RATE_LIMIT = { limit };
      const request = new Request(`https://${hostname}/api/dependency-scenarios/v1`, {
        headers: { "X-Pharos-Site-Proxy-Secret": "site-secret", "CF-Connecting-IP": "192.0.2.2" },
      });
      const denied = await evaluateAccessGate(request, new URL(request.url), env);
      expect(denied.response?.status).toBe(429);
      expect(denied.response?.headers.get("Retry-After")).toBe("60");
      expect(limit).toHaveBeenCalledWith({ key: "192.0.2.2" });
      expect(apiKeyMocks.authenticateApiKey).not.toHaveBeenCalled();
      limit.mockResolvedValueOnce({ success: true });
      expect((await evaluateAccessGate(request, new URL(request.url), env)).response).toBeNull();
      limit.mockRejectedValueOnce(new Error("unavailable"));
      expect((await evaluateAccessGate(request, new URL(request.url), env)).response?.status).toBe(503);
      env.SAFETY_GRADES_RATE_LIMIT = undefined as never;
      expect((await evaluateAccessGate(request, new URL(request.url), env)).response?.status).toBe(503);
    },
  );

  it("limits site-data public status history on the Pages-forwarded client IP", async () => {
    const env = makeEnv();
    const limit = vi.fn().mockResolvedValue({ success: false });
    env.SAFETY_GRADES_RATE_LIMIT = { limit };
    const request = new Request("https://site-api.pharos.watch/api/public-status-history?window=7d", {
      headers: {
        "X-Pharos-Site-Proxy-Secret": "site-secret",
        "X-Pharos-Client-IP": "203.0.113.9",
        "CF-Connecting-IP": "192.0.2.9",
      },
    });

    const denied = await evaluateAccessGate(request, new URL(request.url), env);

    expect(denied.response?.status).toBe(429);
    expect(denied.response?.headers.get("Retry-After")).toBe("60");
    expect(limit).toHaveBeenCalledWith({ key: "203.0.113.9" });
    expect(apiKeyMocks.authenticateApiKey).not.toHaveBeenCalled();
  });

  it("preserves Access-authenticated ops-api admin routing", async () => {
    verifyAccessJwt.mockResolvedValueOnce(true);
    const request = new Request("https://ops-api.pharos.watch/api/status", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-access-jwt" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), makeEnv());

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
    const env = createWorkerEnv({ MAINTENANCE_MODE: "true" });

    const blocked = handleMaintenanceMode(
      new Request("https://api.pharos.watch/api/stablecoins"),
      env,
    );
    const preflight = handleMaintenanceMode(
      new Request("https://api.pharos.watch/api/stablecoins", { method: "OPTIONS" }),
      env,
    );

    expect(blocked?.status).toBe(503);
    expect(blocked?.headers.get("Retry-After")).toBe("300");
    await expect(blocked?.json()).resolves.toMatchObject({ error: "maintenance" });
    expect(preflight).toBeNull();
  });

  it("denies site-api admin paths after a valid site-proxy credential", async () => {
    const request = new Request("https://site-api.pharos.watch/api/api-keys?limit=1", {
      headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), makeEnv());

    expect(result.response?.status).toBe(404);
    expect(result.requestLane).toBe("site-api");
    expect(result.isSiteProxy).toBe(false);
  });

  it("keeps site-api path rejection ahead of method rejection", async () => {
    const request = new Request("https://site-api.pharos.watch/api/feedback", {
      method: "POST",
      headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), makeEnv());

    expect(result.response?.status).toBe(404);
    expect(result.requestLane).toBe("site-api");
    expect(result.isSiteProxy).toBe(false);
  });

  it("returns 405 for non-GET requests to allowed site-api paths", async () => {
    const request = new Request("https://site-api.pharos.watch/api/stablecoins", {
      method: "POST",
      headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), makeEnv());

    expect(result.response?.status).toBe(405);
    expect(result.response?.headers.get("Allow")).toBe("GET");
    expect(result.requestLane).toBe("site-api");
    expect(result.isSiteProxy).toBe(false);
  });

  it("no longer admits the retired Telegram adoption mutation on the site-api lane", async () => {
    const request = new Request("https://site-api.pharos.watch/api/telegram-adoption", {
      method: "POST",
      headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), makeEnv());

    expect(result.response?.status).toBe(404);
    expect(result.isSiteProxy).toBe(false);
  });

  it("rejects site-api requests without the site-proxy credential", async () => {
    const request = new Request("https://site-api.pharos.watch/api/stablecoins");

    const result = await evaluateAccessGate(request, new URL(request.url), makeEnv());

    expect(result.response?.status).toBe(401);
    expect(result.requestLane).toBe("site-api");
    expect(result.isSiteProxy).toBe(false);
  });

  it("grants the site-api lane to allowed site-api GETs with the site-proxy secret", async () => {
    const request = new Request("https://site-api.pharos.watch/api/stablecoins", {
      headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), makeEnv());

    expect(result.response).toBeNull();
    expect(result.isSiteProxy).toBe(true);
    expect(result.requestLane).toBe("site-api");
  });

  it("grants the site-api lane to allowed preview (*.workers.dev) GETs with the site-proxy secret", async () => {
    const request = new Request("https://pharos-watch-preview.workers.dev/api/stablecoins", {
      headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), makeEnv());

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

    const execCtx = { waitUntil: vi.fn(), passThroughOnException: () => {} } as unknown as ExecutionContext;
    const result = await evaluateAccessGate(request, new URL(request.url), {
      ...makeEnv(),
      DB: db,
      API_KEY_HASH_PEPPER: "pepper",
    } as never, execCtx);

    expect(result.response).toBeNull();
    expect(result.apiKey).toBe(validKey);
    expect(result.requestLane).toBe("public-api");
    // The ExecutionContext is forwarded so the limiter can schedule its own
    // bucket prune instead of parking it in module state for a later flush.
    expect(apiKeyMocks.checkApiKeyRateLimit).toHaveBeenCalledWith(db, 7, 60, undefined, execCtx);
    expect(apiKeyMocks.recordApiKeyRateLimitDependencySuccess).toHaveBeenCalled();
    expect(apiKeyMocks.recordApiKeyUsage).toHaveBeenCalledWith(db, validKey, "/api/stablecoins");
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

  it.each(["donor", "self-serve"])("fails closed for %s keys while the rate-limit circuit is open instead of degrading per isolate", async (tier) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    apiKeyMocks.authenticateApiKey.mockResolvedValueOnce({
      kind: "valid",
      key: { ...validKey, id: 9, tier, rateLimitPerMinute: tier === "donor" ? 10 : 30 },
    });
    apiKeyMocks.isApiKeyRateLimitDependencyCircuitOpen.mockReturnValueOnce(true);
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: { "X-API-Key": "pharos_test_valid" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), {
      ...makeEnv(),
      DB: {} as D1Database,
      API_KEY_HASH_PEPPER: "pepper",
    } as never);

    expect(result.response?.status).toBe(503);
    expect(result.response?.headers.get("Retry-After")).toBe("60");
    expect(apiKeyMocks.checkIsolateLocalApiKeyRateLimit).not.toHaveBeenCalled();
    expect(apiKeyMocks.recordApiKeyUsage).not.toHaveBeenCalled();
    expect(parseWarnEvents(warn)).toContainEqual(expect.objectContaining({
      event: "api_key_rate_limit_circuit_open_fail_closed",
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
