import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { verifyAccessJwt, apiKeyMocks, endpointRequiredPlansMock } = vi.hoisted(() => ({
  verifyAccessJwt: vi.fn(),
  endpointRequiredPlansMock: vi.fn(),
  apiKeyMocks: {
    authenticateApiKey: vi.fn(),
    authenticateApiKeyFromFreshCache: vi.fn(),
    checkApiKeyRateLimit: vi.fn(),
    checkApiKeyMonthlyRequestQuota: vi.fn(),
    checkCachedApiKeyMonthlyRequestQuota: vi.fn(),
    checkIsolateLocalApiKeyRateLimit: vi.fn(),
    isApiKeyRateLimitDependencyCircuitOpen: vi.fn(),
    recordApiKeyRateLimitDependencyFailure: vi.fn(),
    recordApiKeyRateLimitDependencySuccess: vi.fn(),
    recordApiKeyUsage: vi.fn(),
    resolveIsolateFallbackApiKeyRateLimit: vi.fn(),
    getCachedApiKeyByPrefix: vi.fn(),
  },
}));

vi.mock("@shared/lib/api-endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/lib/api-endpoints")>();
  endpointRequiredPlansMock.mockImplementation(actual.getEndpointRequiredKeyPlans);
  return { ...actual, getEndpointRequiredKeyPlans: endpointRequiredPlansMock };
});

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
  checkApiKeyMonthlyRequestQuota: apiKeyMocks.checkApiKeyMonthlyRequestQuota,
  checkCachedApiKeyMonthlyRequestQuota: apiKeyMocks.checkCachedApiKeyMonthlyRequestQuota,
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
import { jsonResponse } from "../../../lib/api-response";
import { makeApiKeyPrefixLookup, makeAuthenticatedApiKeyRow } from "../../../test-helpers/api-key-test-support";
import { clearApiKeyCache, lookupApiKeyByPrefix, resetApiKeyStateForTests } from "../../../lib/api-key-core";
import { createWorkerEnv } from "../../../test-helpers/__shared/worker-env";
import { mintSiteSessionToken, readSiteSessionCookie, SITE_SESSION_COOKIE_NAME, SITE_SESSION_HEADER } from "@shared/lib/site-session-token";
import { onRequest as issueSession, resetSiteSessionRateLimitStateForTests } from "../../../../../functions/_site-data/session";
import { onRequest as proxySiteData } from "../../../../../functions/_site-data/[[path]]";
import { siteSessionCookie } from "../../../../../scripts/lib/site-session";
import { hashClientIp } from "@shared/lib/client-ip-hash";
import { recomputeVerifiedSelectorSnapshot } from "../../../../../functions/lib/selector-canonical-snapshot";

async function useRealApiKeyAuth() {
  apiKeyMocks.authenticateApiKey.mockImplementation((await vi.importActual<typeof import("../../../lib/api-key-auth")>("../../../lib/api-key-auth")).authenticateApiKey);
  apiKeyMocks.getCachedApiKeyByPrefix.mockImplementation((await vi.importActual<typeof import("../../../lib/api-key-core")>("../../../lib/api-key-core")).getCachedApiKeyByPrefix);
}

const validKey = {
  id: 7,
  keyPrefix: "pharos_test",
  name: "Test key",
  tier: "standard",
  plan: null,
  trafficClass: "external",
  rateLimitPerMinute: 60,
};

function parseWarnEvents(warn: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return warn.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

function makeEnv() {
  return createWorkerEnv({
    SITE_API_SHARED_SECRET: "site-secret",
    SITE_SESSION_SIGNING_KEY: "session-key",
    CF_ACCESS_OPS_API_AUD: "ops-aud",
    CF_ACCESS_TEAM_DOMAIN: "pharos-watch",
  });
}

describe("evaluateAccessGate", () => {
  beforeEach(() => {
    resetApiKeyStateForTests();
    endpointRequiredPlansMock.mockReturnValue(null);
    apiKeyMocks.isApiKeyRateLimitDependencyCircuitOpen.mockReturnValue(false);
    apiKeyMocks.recordApiKeyRateLimitDependencyFailure.mockReturnValue({
      consecutiveFailures: 1,
      openUntilMs: 0,
      opened: false,
    });
    apiKeyMocks.resolveIsolateFallbackApiKeyRateLimit.mockImplementation((limit: number) => Math.max(limit, 1));
    apiKeyMocks.checkApiKeyMonthlyRequestQuota.mockResolvedValue(null);
    apiKeyMocks.checkCachedApiKeyMonthlyRequestQuota.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetApiKeyStateForTests();
    verifyAccessJwt.mockReset();
    for (const mock of Object.values(apiKeyMocks)) {
      mock.mockReset();
    }
  });

  describe("site sessions", () => {
    let clock = 1_800_000;
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(clock += 120_000);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "info").mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());
    const requestFor = (token?: string, host = "site-api.pharos.watch", path = "/api/stablecoins") => new Request(`https://${host}${path}`, {
      headers: { "X-Pharos-Site-Proxy-Secret": "site-secret", "X-Pharos-Client-IP": "2001:db8:1:2::abcd",
        "CF-Connecting-IP": "192.0.2.1", ...(token ? { [SITE_SESSION_HEADER]: token } : {}) },
    });
    const mint = (input: Partial<Parameters<typeof mintSiteSessionToken>[0]> = {}) => mintSiteSessionToken({
      key: "session-key", kind: "browser", sid: "test-session", nowSec: Date.now() / 1000, ...input,
    });
    const sessionEnv = (mode: string | undefined) => ({ ...makeEnv(), SITE_SESSION_ENFORCEMENT: mode,
      SITE_SESSION_RATE_LIMIT: { limit: vi.fn().mockResolvedValue({ success: true }) },
      SITE_SOURCE_RATE_LIMIT: { limit: vi.fn().mockResolvedValue({ success: true }) } });

    it("admits real Pages-issued browser and script automation cookies through the proxy in enforce", async () => {
      const env = sessionEnv("enforce");
      const pagesEnv = { SITE_SESSION_SIGNING_KEY: "session-key", TURNSTILE_SECRET_KEY: "turnstile-key",
        SITE_API_ORIGIN: "https://site-api.pharos.watch", SITE_API_SHARED_SECRET: "site-secret" };
      resetSiteSessionRateLimitStateForTests();
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).hostname === "challenges.cloudflare.com") {
          return Response.json({ success: true, hostname: "pharos.watch", action: "site-data" });
        }
        return (await evaluateAccessGate(request, new URL(request.url), env)).response ?? Response.json({ admitted: true });
      }));
      try {
        const issued = await issueSession({ env: pagesEnv, request: new Request("https://pharos.watch/_site-data/session", {
          method: "POST", headers: { Origin: "https://pharos.watch", "CF-Connecting-IP": "192.0.2.1" },
          body: JSON.stringify({ token: "verified-challenge" }),
        }) });
        expect(issued.status).toBe(204);
        expect(await issued.text()).toBe("");
        const browser = readSiteSessionCookie(issued.headers.get("Set-Cookie"));
        expect(browser).toBeTruthy();
        const automation = await siteSessionCookie("https://pharos.watch", { SITE_SESSION_SIGNING_KEY: "session-key" }, Date.now() / 1000);
        for (const token of [browser, automation?.value, null]) {
          const response = await proxySiteData({ env: pagesEnv, params: { path: "stablecoins" },
            request: new Request("https://pharos.watch/_site-data/stablecoins", {
              headers: { Origin: "https://pharos.watch", "CF-Connecting-IP": "192.0.2.1",
                ...(token ? { Cookie: `${SITE_SESSION_COOKIE_NAME}=${token}` } : {}) },
            }) });
          expect(response.status).toBe(token ? 200 : 401);
          if (!token) expect(response.headers.get("X-Pharos-Session")).toBe("required");
        }
        await expect(recomputeVerifiedSelectorSnapshot({} as never,
          new Request("https://pharos.watch/selector-snapshot"), pagesEnv,
        )).rejects.toThrow("Canonical selector source contract failed");
        expect(env.SITE_SESSION_RATE_LIMIT.limit).toHaveBeenCalledOnce();
      } finally {
        vi.unstubAllGlobals();
        resetSiteSessionRateLimitStateForTests();
      }
    });

    it.each(["observe", "enforce"])("applies all token outcomes in %s on site and preview paths", async (mode) => {
      const env = sessionEnv(mode);
      for (const [outcome, token] of [
        ["valid", await mint()], ["missing", undefined], ["malformed", "bad.token"],
        ["bad-signature", await mint({ key: "wrong-key" })], ["expired", await mint({ nowSec: 1, ttlSec: 1 })],
        ["not-yet-valid", await mint({ nowSec: Date.now() / 1000 + 61 })],
      ] as const) {
        vi.spyOn(Math, "random").mockReturnValue(0);
        for (const host of ["site-api.pharos.watch", "preview.workers.dev"]) {
          const request = requestFor(token, host);
          const result = await evaluateAccessGate(request, new URL(request.url), env);
          expect(result.response?.status ?? 200).toBe(mode === "observe" || outcome === "valid" ? 200 : 401);
          if (result.response) {
            expect(result.response.headers.get("X-Pharos-Session")).toBe("required");
            expect(result.response.headers.get("Cache-Control")).toBe("no-store");
          }
          const events = outcome === "valid" ? console.info : console.warn;
          expect(JSON.parse(String(vi.mocked(events).mock.lastCall?.[0]))).toMatchObject({
            event: "site_session_gate", metadata: { mode, outcome, tokenKind: outcome === "valid" ? "browser" : null,
              pathGroup: "stablecoins", clientNetworkHash: await hashClientIp("2001:db8:1:2::/64", "session-key") },
          });
        }
      }
      expect(env.SITE_SESSION_RATE_LIMIT.limit).toHaveBeenCalledTimes(2);
      expect(apiKeyMocks.authenticateApiKey).not.toHaveBeenCalled();
    });

    it.each(["observe", "enforce"])("accepts automation and previous-key tokens in %s", async (mode) => {
      const env = sessionEnv(mode);
      env.SITE_SESSION_SIGNING_KEY_PREVIOUS = "old-key";
      const browser = requestFor(await mint({ key: "old-key" }));
      expect((await evaluateAccessGate(browser, new URL(browser.url), env)).response).toBeNull();
      expect(env.SITE_SESSION_RATE_LIMIT.limit).toHaveBeenCalledWith({ key: "test-session" });
      expect(env.SITE_SOURCE_RATE_LIMIT.limit).toHaveBeenCalledWith({ key: "2001:db8:1:2::/64" });
      env.SITE_SESSION_RATE_LIMIT.limit.mockRejectedValue(new Error("offline"));
      env.SITE_SOURCE_RATE_LIMIT.limit.mockResolvedValue({ success: false });
      const automation = requestFor(await mint({ kind: "automation", key: "old-key" }));
      expect((await evaluateAccessGate(automation, new URL(automation.url), env)).response).toBeNull();
      expect(env.SITE_SESSION_RATE_LIMIT.limit).toHaveBeenCalledOnce();
      expect(env.SITE_SOURCE_RATE_LIMIT.limit).toHaveBeenCalledOnce();
    });

    it.each([undefined, "observe", "ENFORCE", " enforce ", "unknown", "enforce"])("defaults mode %j and handles missing current key", async (mode) => {
      const env = { ...sessionEnv(mode), SITE_SESSION_SIGNING_KEY: undefined, SITE_SESSION_SIGNING_KEY_PREVIOUS: "old-key" };
      const request = requestFor(await mint({ key: "old-key" }));
      const response = (await evaluateAccessGate(request, new URL(request.url), env)).response;
      expect(response?.status ?? 200).toBe(mode === "enforce" ? 503 : 200);
      if (response) expect(response.headers.get("Retry-After")).toBe("60");
      expect(env.SITE_SESSION_RATE_LIMIT.limit).not.toHaveBeenCalled();
      expect(JSON.parse(String(vi.mocked(console.warn).mock.lastCall?.[0]))).toMatchObject({
        metadata: { mode: mode === "enforce" ? "enforce" : "observe", outcome: "key-missing", tokenKind: null },
      });
    });

    it("checks the proxy secret, path and method before sessions, including internal build reads", async () => {
      const env = sessionEnv("enforce");
      for (const [path, method, secret, status] of [
        ["/api/stablecoins", "GET", "wrong", 401], ["/api/feedback", "POST", "site-secret", 404],
        ["/api/stablecoins", "POST", "site-secret", 405],
      ] as const) {
        const request = new Request(`https://site-api.pharos.watch${path}`, { method, headers: { "X-Pharos-Site-Proxy-Secret": secret } });
        expect((await evaluateAccessGate(request, new URL(request.url), env)).response?.status).toBe(status);
      }
      expect(console.warn).not.toHaveBeenCalled();
      const path = "/api/stablecoin-detail-snapshot-inputs";
      const missing = requestFor(undefined, undefined, path);
      expect((await evaluateAccessGate(missing, new URL(missing.url), env)).response?.status).toBe(401);
      const valid = requestFor(await mint({ kind: "automation" }), undefined, path);
      expect((await evaluateAccessGate(valid, new URL(valid.url), env)).response).toBeNull();
    });

    it.each(["observe", "enforce"])("handles each browser budget failure in %s", async (mode) => {
      for (const binding of ["SITE_SESSION_RATE_LIMIT", "SITE_SOURCE_RATE_LIMIT"] as const) {
        for (const failure of ["exceeded", "throws", "missing"] as const) {
          const env = sessionEnv(mode);
          if (failure === "missing") env[binding] = undefined as never;
          else if (failure === "throws") env[binding].limit.mockRejectedValue(new Error("offline"));
          else env[binding].limit.mockResolvedValue({ success: false });
          const request = requestFor(await mint());
          const response = (await evaluateAccessGate(request, new URL(request.url), env)).response;
          expect(response?.status ?? 200).toBe(mode === "observe" ? 200 : failure === "exceeded" ? 429 : 503);
          if (response) expect(response.headers.get("Retry-After")).toBe("60");
          expect(JSON.parse(String(vi.mocked(console.warn).mock.lastCall?.[0]))).toMatchObject({
            metadata: { mode, outcome: failure === "exceeded" ? "budget-exceeded" : "budget-unavailable", tokenKind: "browser" },
          });
        }
      }
    });

    it("preserves the anonymous site throttle for valid sessions and isolates non-site lanes", async () => {
      const env = sessionEnv("enforce");
      env.SAFETY_GRADES_RATE_LIMIT = { limit: vi.fn().mockResolvedValue({ success: false }) };
      for (const kind of ["browser", "automation"] as const) {
        const request = requestFor(await mint({ kind }), undefined, "/api/dependency-scenarios/v1");
        expect((await evaluateAccessGate(request, new URL(request.url), env)).response?.status).toBe(429);
      }
      const noKeyEnv = { ...env, SITE_SESSION_SIGNING_KEY: undefined };
      apiKeyMocks.authenticateApiKey.mockResolvedValue({ kind: "valid", key: validKey });
      for (const path of ["/api/stablecoins", "/api/health"]) {
        const request = requestFor(undefined, "api.pharos.watch", path);
        expect((await evaluateAccessGate(request, new URL(request.url), noKeyEnv)).response).toBeNull();
      }
      expect(apiKeyMocks.authenticateApiKey).toHaveBeenCalledOnce();
      verifyAccessJwt.mockResolvedValueOnce(true);
      const admin = new Request("https://ops-api.pharos.watch/api/status", { headers: { "Cf-Access-Jwt-Assertion": "jwt" } });
      expect((await evaluateAccessGate(admin, new URL(admin.url), noKeyEnv)).isAdmin).toBe(true);
      expect(env.SITE_SESSION_RATE_LIMIT.limit).toHaveBeenCalledOnce();
    });

    it("caps all sampled details and summarizes exact outcomes per mode without exposing token or network", async () => {
      const env = sessionEnv("observe");
      const request = requestFor();
      for (let i = 0; i < 65; i++) await evaluateAccessGate(request, new URL(request.url), env);
      expect(console.warn).toHaveBeenCalledTimes(60);
      vi.mocked(console.info).mockClear();
      const minute = Math.floor(Date.now() / 60_000);
      vi.setSystemTime(Date.now() + 60_000);
      await evaluateAccessGate(request, new URL(request.url), env);
      expect(console.warn).toHaveBeenCalledTimes(61);
      expect(console.info).toHaveBeenCalledOnce();
      expect(JSON.parse(String(vi.mocked(console.info).mock.lastCall?.[0]))).toMatchObject({
        event: "site_session_gate_summary", metadata: { minute, outcomes: { observe: { missing: 65 }, enforce: {} } },
      });
      vi.mocked(console.info).mockClear();
      const token = await mint();
      const valid = requestFor(token);
      vi.spyOn(Math, "random").mockReturnValue(1 / 16);
      await evaluateAccessGate(valid, new URL(valid.url), env);
      expect(console.info).not.toHaveBeenCalled();
      vi.mocked(Math.random).mockReturnValue(0);
      await evaluateAccessGate(valid, new URL(valid.url), env);
      expect(console.info).toHaveBeenCalledOnce();
      for (let i = 0; i < 100; i++) await evaluateAccessGate(valid, new URL(valid.url), env);
      for (let i = 0; i < 3; i++) await evaluateAccessGate(request, new URL(request.url), sessionEnv("enforce"));
      expect(console.info).toHaveBeenCalledTimes(59);
      expect(console.warn).toHaveBeenCalledTimes(61);
      vi.setSystemTime(Date.now() + 60_000);
      await evaluateAccessGate(request, new URL(request.url), env);
      expect(console.info).toHaveBeenCalledTimes(60);
      expect(JSON.parse(String(vi.mocked(console.info).mock.lastCall?.[0]))).toMatchObject({
        event: "site_session_gate_summary", metadata: { minute: minute + 1,
          outcomes: { observe: { missing: 1, valid: 102 }, enforce: { missing: 3 } } },
      });
      const logs = JSON.stringify([vi.mocked(console.info).mock.calls, vi.mocked(console.warn).mock.calls]);
      for (const sensitive of [token, "test-session", "2001:db8", "192.0.2.1", "session-key", "site-secret"]) expect(logs).not.toContain(sensitive);
    });
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
    const throttled = (await evaluateAccessGate(request, new URL(request.url), env)).response;
    expect(throttled?.status).toBe(429);
    expect(throttled?.headers.get("Cache-Control")).toBe("no-store");
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

  it("returns the monthly quota 429 with the authenticated key before the per-minute limiter", async () => {
    apiKeyMocks.authenticateApiKey.mockResolvedValueOnce({ kind: "valid", key: validKey });
    const db = {} as D1Database;
    const quotaResponse = jsonResponse(
      { error: "Monthly request quota exceeded", reason: "monthly_quota_exceeded" },
      { status: 429, retryAfterSec: 900, noStore: true },
    );
    apiKeyMocks.checkApiKeyMonthlyRequestQuota.mockResolvedValueOnce(quotaResponse);
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: { "X-API-Key": "ph_live_0123456789abcdef_abcdefghijklmnopqrstuvwxyzABCDEF" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), {
      ...makeEnv(),
      DB: db,
      API_KEY_HASH_PEPPER: "pepper",
    } as never);

    expect(result.response).toBe(quotaResponse);
    expect(result.apiKey).toBe(validKey);
    expect(apiKeyMocks.checkApiKeyMonthlyRequestQuota).toHaveBeenCalledWith(db, validKey, undefined, false);
    expect(apiKeyMocks.checkApiKeyRateLimit).not.toHaveBeenCalled();
    expect(apiKeyMocks.recordApiKeyUsage).not.toHaveBeenCalled();
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
    expect(apiKeyMocks.checkIsolateLocalApiKeyRateLimit).toHaveBeenCalledWith(7, 60);
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
    expect(apiKeyMocks.checkIsolateLocalApiKeyRateLimit).toHaveBeenCalledWith(7, 60);
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

  it("honours a fresh over-quota monthly memo before the isolate-local limiter on cached public reads", () => {
    const quotaResponse = new Response("quota exceeded", { status: 429 });
    apiKeyMocks.checkCachedApiKeyMonthlyRequestQuota.mockReturnValueOnce(quotaResponse);

    expect(checkCachedPublicApiReadFastRateLimit(validKey as never)).toBe(quotaResponse);
    expect(apiKeyMocks.checkIsolateLocalApiKeyRateLimit).not.toHaveBeenCalled();
  });

  it("keeps the key's own quota for cached public reads while the API-key rate-limit circuit is open", () => {
    apiKeyMocks.isApiKeyRateLimitDependencyCircuitOpen.mockReturnValueOnce(true);
    apiKeyMocks.checkIsolateLocalApiKeyRateLimit.mockReturnValueOnce(null);

    expect(checkCachedPublicApiReadFastRateLimit({ ...validKey, rateLimitPerMinute: 180 } as never)).toBeNull();
    expect(apiKeyMocks.resolveIsolateFallbackApiKeyRateLimit).toHaveBeenCalledWith(180);
    expect(apiKeyMocks.checkIsolateLocalApiKeyRateLimit).toHaveBeenCalledWith(7, 180);
  });

  it.each(["exceeded", "throws", "missing"])("limits anonymous OG image reads per client network and never fails closed on %s", async (mode) => {
    const env = makeEnv();
    const limit = vi.fn().mockResolvedValue({ success: true });
    if (mode === "exceeded") limit.mockResolvedValueOnce({ success: false });
    if (mode === "throws") limit.mockRejectedValueOnce(new Error("unavailable"));
    if (mode !== "missing") env.OG_IMAGE_RATE_LIMIT = { limit };
    const request = new Request("https://api.pharos.watch/api/og/stablecoin/usdc-usd-coin", {
      headers: { "CF-Connecting-IP": "192.0.2.7" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), env);

    if (mode === "exceeded") {
      expect(result.response?.status).toBe(429);
      expect(result.response?.headers.get("Cache-Control")).toBe("no-store");
    } else {
      expect(result.response).toBeNull();
    }
    if (mode !== "missing") expect(limit).toHaveBeenCalledWith({ key: "192.0.2.7" });
    expect(apiKeyMocks.authenticateApiKey).not.toHaveBeenCalled();
  });

  it("does not apply the OG image limiter to other hosts or methods", async () => {
    const env = makeEnv();
    const limit = vi.fn().mockResolvedValue({ success: true });
    env.OG_IMAGE_RATE_LIMIT = { limit };
    for (const request of [
      new Request("https://api.pharos.watch/api/og/stablecoin/usdc-usd-coin", {
        method: "POST", headers: { "CF-Connecting-IP": "192.0.2.7" },
      }),
      new Request("https://site-api.pharos.watch/api/og/stablecoin/usdc-usd-coin", {
        headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" },
      }),
    ]) {
      await evaluateAccessGate(request, new URL(request.url), env);
    }
    expect(limit).not.toHaveBeenCalled();
  });

  describe("plan entitlement gating", () => {
    const PAID_PLANS = ["commercial", "institutional"] as const;

    it.each([
      ["NULL-plan standard key at 120/min", { tier: "standard", plan: null, rateLimitPerMinute: 120, trafficClass: "external" }, 403],
      ["NULL-plan standard key at 600/min", { tier: "standard", plan: null, rateLimitPerMinute: 600, trafficClass: "external" }, 403],
      ["free_partner key", { tier: "standard", plan: "free_partner", rateLimitPerMinute: 60, trafficClass: "external" }, 403],
      ["donor key", { tier: "donor", plan: null, rateLimitPerMinute: 10, trafficClass: "external" }, 403],
      ["self-serve key", { tier: "self-serve", plan: null, rateLimitPerMinute: 30, trafficClass: "external" }, 403],
      ["commercial key", { tier: "standard", plan: "commercial", rateLimitPerMinute: 120, trafficClass: "external" }, 200],
      ["institutional key", { tier: "standard", plan: "institutional", rateLimitPerMinute: 600, trafficClass: "external" }, 200],
      ["first-party site key with NULL plan", { tier: "standard", plan: null, rateLimitPerMinute: 60, trafficClass: "site" }, 200],
    ] as const)("evaluates paid endpoint entitlement for %s", async (_label, keyPatch, expectedStatus) => {
      endpointRequiredPlansMock.mockReturnValue(PAID_PLANS);
      const key = { ...validKey, ...keyPatch };
      apiKeyMocks.authenticateApiKey.mockResolvedValueOnce({ kind: "valid", key });
      apiKeyMocks.checkApiKeyRateLimit.mockResolvedValueOnce(null);
      apiKeyMocks.recordApiKeyUsage.mockResolvedValueOnce(undefined);
      const request = new Request("https://api.pharos.watch/api/stablecoins", {
        headers: { "X-API-Key": "pharos_test_valid" },
      });

      const result = await evaluateAccessGate(request, new URL(request.url), {
        ...makeEnv(),
        DB: {} as D1Database,
        API_KEY_HASH_PEPPER: "pepper",
      } as never);

      expect(apiKeyMocks.checkApiKeyRateLimit).toHaveBeenCalledOnce();
      expect(result.apiKey).toBe(key);
      if (expectedStatus === 403) {
        expect(result.response?.status).toBe(403);
        expect(result.response?.headers.get("Cache-Control")).toBe("no-store");
        await expect(result.response?.json()).resolves.toEqual({
          error: "This endpoint requires a commercial or institutional API key",
          reason: "plan_upgrade_required",
          requiredPlans: ["commercial", "institutional"],
          upgradeUrl: "https://pharos.watch/api/#partner-access",
        });
        expect(apiKeyMocks.recordApiKeyUsage).not.toHaveBeenCalled();
      } else {
        expect(result.response).toBeNull();
        expect(apiKeyMocks.recordApiKeyUsage).toHaveBeenCalledOnce();
      }
    });

    it("enforces the per-minute rate limiter before entitlement 403", async () => {
      endpointRequiredPlansMock.mockReturnValue(PAID_PLANS);
      const key = { ...validKey, plan: "free_partner" };
      const rateLimit429 = new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429 });
      apiKeyMocks.authenticateApiKey.mockResolvedValueOnce({ kind: "valid", key });
      apiKeyMocks.checkApiKeyRateLimit.mockResolvedValueOnce(rateLimit429);
      const request = new Request("https://api.pharos.watch/api/stablecoins", {
        headers: { "X-API-Key": "pharos_test_valid" },
      });

      const result = await evaluateAccessGate(request, new URL(request.url), {
        ...makeEnv(),
        DB: {} as D1Database,
        API_KEY_HASH_PEPPER: "pepper",
      } as never);

      expect(result.response).toBe(rateLimit429);
      expect(apiKeyMocks.recordApiKeyUsage).not.toHaveBeenCalled();
    });

    it("falls through to the slow path from the cache-hit fast gate when a key is not entitled", async () => {
      endpointRequiredPlansMock.mockReturnValue(PAID_PLANS);
      const request = new Request("https://api.pharos.watch/api/stablecoins", {
        headers: { "X-API-Key": "pharos_test_valid" },
      });
      const env = { ...makeEnv(), API_KEY_HASH_PEPPER: "pepper" } as never;

      for (const plan of [null, "free_partner"] as const) {
        apiKeyMocks.authenticateApiKeyFromFreshCache.mockResolvedValueOnce({
          kind: "valid",
          key: { ...validKey, plan, rateLimitPerMinute: 120 },
        });
        expect(await evaluateCachedPublicApiReadFastGate(request, new URL(request.url), env)).toBeNull();
      }

      const entitled = { ...validKey, plan: "commercial", rateLimitPerMinute: 120 };
      apiKeyMocks.authenticateApiKeyFromFreshCache.mockResolvedValueOnce({ kind: "valid", key: entitled });
      const fastResult = await evaluateCachedPublicApiReadFastGate(request, new URL(request.url), env);
      expect(fastResult?.apiKey).toBe(entitled);
      expect(fastResult?.response).toBeNull();
    });
  });
});
