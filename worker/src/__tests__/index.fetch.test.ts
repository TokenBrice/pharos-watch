import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { mockD1, type MockTableConfig } from "../test-helpers/__shared/mock-d1";
import { hmacSha256Hex, makeExecutionContext } from "../test-helpers/__shared/auth";
import { API_KEY_AUTH_CACHE_TTL_MS, resetApiKeyStateForTests } from "../lib/api-keys";
import { resetRateLimitStateForTests } from "../lib/rate-limit";
import { resetRequestAttributionStateForTests } from "../lib/request-source-attribution";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import {
  matchesHttpResponseObservation,
  observeHttpResponse,
  type HttpResponseObservation,
} from "../../../scripts/test-utils/http-response-contract";

const VALID_KEY_PEPPER = "test-pepper";
const VALID_KEY_PREFIX = "0123456789abcdef";
const VALID_KEY_SECRET = "abcdefghijklmnopqrstuvwxyzABCDEF";
const VALID_API_KEY = `ph_live_${VALID_KEY_PREFIX}_${VALID_KEY_SECRET}`;

async function validKeyRow(): Promise<Record<string, unknown>> {
  const secretHash = await hmacSha256Hex(VALID_KEY_PEPPER, VALID_KEY_SECRET);
  return {
    id: 7,
    key_prefix: VALID_KEY_PREFIX,
    secret_hash: secretHash,
    name: "Test",
    owner_email: null,
    tier: "standard",
    traffic_class: "external",
    rate_limit_per_minute: 120,
    is_active: 1,
    expires_at: null,
    created_at: 1,
    updated_at: 1,
    last_used_at: null,
    last_used_route: null,
  };
}

async function validKeyDbTables(
  extra: MockTableConfig[] = [],
): Promise<MockTableConfig[]> {
  const row = await validKeyRow();
  return [
    { match: "FROM api_keys", matchBinds: [VALID_KEY_PREFIX], rows: [row] },
    { match: "INSERT INTO api_key_rate_limit", rows: [], first: { count: 1 } },
    { match: "UPDATE api_keys SET last_used_at", rows: [], runMeta: { changes: 1 } },
    { match: "DELETE FROM api_key_rate_limit", rows: [], runMeta: { changes: 0 } },
    { match: "INSERT INTO api_request_consumer_stats", rows: [], runMeta: { changes: 1 } },
    { match: "INSERT INTO api_key_request_stats", rows: [], runMeta: { changes: 1 } },
    { match: "DELETE FROM api_request_consumer_stats", rows: [], runMeta: { changes: 0 } },
    { match: "DELETE FROM api_key_request_stats", rows: [], runMeta: { changes: 0 } },
    ...extra,
  ];
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: mockD1(),
    CORS_ORIGIN: "https://pharos.watch",
    SITE_API_SHARED_SECRET: "site-secret",
    API_KEY_HASH_PEPPER: VALID_KEY_PEPPER,
    ...overrides,
  } as const;
}

describe("worker.fetch", () => {
  const cacheMatch = vi.fn();
  const cachePut = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.useRealTimers();
    resetApiKeyStateForTests();
    resetRateLimitStateForTests();
    resetRequestAttributionStateForTests();
    vi.restoreAllMocks();
    cacheMatch.mockReset();
    cachePut.mockReset();
    vi.stubGlobal("caches", {
      default: {
        match: cacheMatch,
        put: cachePut,
      },
    });
  });

  async function fetchStablecoinsWithApiKey(method = "GET", database?: D1Database): Promise<Response> {
    const { ctx, waits } = makeExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        method,
        headers: { "X-API-Key": VALID_API_KEY },
      }),
      makeEnv({ DB: database ?? mockD1(await validKeyDbTables(), { requireMatch: true }) }) as never,
      ctx,
    );
    await Promise.all(waits);
    return response;
  }

  const workerResponseContractCases: Array<{
    name: string;
    run: () => Promise<Response>;
    expected: HttpResponseObservation;
  }> = [
    {
      name: "fresh cacheable read",
      run: async () => {
        cacheMatch.mockResolvedValueOnce(Response.json({ z: "last", a: "first" }));
        return fetchStablecoinsWithApiKey();
      },
      expected: {
        status: 200,
        headers: { "access-control-allow-origin": "https://pharos.watch", "content-type": "application/json" },
        bodyKind: "json",
        canonicalBody: { a: "first", z: "last" },
      },
    },
    {
      name: "degraded no-store response",
      run: async () => {
        cacheMatch.mockResolvedValueOnce(
          new Response(JSON.stringify({ degraded: true }), {
            headers: {
              "Cache-Control": "no-store",
              "Content-Type": "application/json",
              Warning: '110 - "Response is stale"',
            },
          }),
        );
        return fetchStablecoinsWithApiKey();
      },
      expected: {
        status: 200,
        headers: {
          "access-control-allow-origin": "https://pharos.watch",
          "cache-control": "no-store",
          "content-type": "application/json",
          warning: '110 - "Response is stale"',
        },
        bodyKind: "json",
        canonicalBody: { degraded: true },
      },
    },
    {
      name: "malformed dynamic path validation",
      run: () =>
        worker.fetch(
          new Request("https://api.pharos.watch/api/og/stablecoin/%E0%A4%A"),
          makeEnv() as never,
          makeExecutionContext().ctx,
        ),
      expected: {
        status: 400,
        headers: { "access-control-allow-origin": "https://pharos.watch", "content-type": "text/plain" },
        bodyKind: "text",
        canonicalBody: "Malformed URI",
      },
    },
    {
      name: "missing API key authentication",
      run: () =>
        worker.fetch(
          new Request("https://api.pharos.watch/api/stablecoins"),
          makeEnv() as never,
          makeExecutionContext().ctx,
        ),
      expected: {
        status: 401,
        headers: { "access-control-allow-origin": "https://pharos.watch", "content-type": "application/json" },
        bodyKind: "json",
        canonicalBody: {
          error: "Unauthorized: valid X-API-Key required. Request self-serve access at https://pharos.watch/api/.",
        },
      },
    },
    {
      name: "read-only method enforcement",
      run: () => fetchStablecoinsWithApiKey("POST"),
      expected: {
        status: 405,
        headers: {
          "access-control-allow-origin": "https://pharos.watch",
          allow: "GET",
          "content-type": "application/json",
        },
        bodyKind: "json",
        canonicalBody: { error: "Method not allowed" },
      },
    },
    {
      name: "API key dependency outage",
      run: () =>
        fetchStablecoinsWithApiKey(
          "GET",
          mockD1(
            [
              {
                match: "FROM api_keys",
                matchBinds: [VALID_KEY_PREFIX],
                rows: [],
                throwError: new Error("api key lookup unavailable"),
              },
              { match: "INSERT INTO api_request_consumer_stats", rows: [], runMeta: { changes: 1 } },
              { match: "DELETE FROM api_request_consumer_stats", rows: [], runMeta: { changes: 0 } },
              { match: "DELETE FROM api_key_request_stats", rows: [], runMeta: { changes: 0 } },
            ],
            { requireMatch: true },
          ),
        ),
      expected: {
        status: 503,
        headers: {
          "access-control-allow-origin": "https://pharos.watch",
          "content-type": "application/json",
          "retry-after": "60",
        },
        bodyKind: "json",
        canonicalBody: { error: "Public API temporarily unavailable" },
      },
    },
  ];

  it.each(workerResponseContractCases)("keeps the response contract for $name", async ({ run, expected }) => {
    const observed = await observeHttpResponse(await run(), [
      "Access-Control-Allow-Origin",
      "Allow",
      "Cache-Control",
      "Content-Type",
      "Retry-After",
      "Warning",
    ]);

    expect(observed).toEqual(expected);
    expect(matchesHttpResponseObservation(observed, expected)).toBe(true);
  });

  it("returns 204 for CORS preflight", async () => {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", { method: "OPTIONS" }),
      env as never,
      ctx,
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://pharos.watch");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-API-Key");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Pharos-Admin");
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("returns CORS preflight headers for the public self-serve request endpoint", async () => {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/api-key-requests", {
        method: "OPTIONS",
        headers: {
          Origin: "https://pharos.watch",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      }),
      env as never,
      ctx,
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://pharos.watch");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("echoes an allowed operator origin from the CORS allowlist", async () => {
    const env = makeEnv({
      CORS_ORIGIN: "https://pharos.watch,https://ops.pharos.watch",
    });
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        method: "OPTIONS",
        headers: { Origin: "https://ops.pharos.watch" },
      }),
      env as never,
      ctx,
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://ops.pharos.watch");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("hides mutating admin endpoints on the public API host", async () => {
    const env = makeEnv({ DB: mockD1(await validKeyDbTables(), { requireMatch: true }) });
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/backfill-depegs", {
        method: "GET",
        headers: { "X-API-Key": VALID_API_KEY },
      }),
      env as never,
      ctx,
    );

    expect(res.status).toBe(404);
    expect(res.headers.get("Allow")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://pharos.watch");
    expect(env.DB.getHistory()).toEqual([]);
  });

  it("rejects POST on read-only endpoints", async () => {
    const env = makeEnv({ DB: mockD1(await validKeyDbTables(), { requireMatch: true }) });
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        method: "POST",
        headers: { "X-API-Key": VALID_API_KEY },
      }),
      env as never,
      ctx,
    );

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });

  it("serves edge-cache hits for cacheable GET paths", async () => {
    cacheMatch.mockResolvedValueOnce(new Response(JSON.stringify({ cached: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const env = makeEnv({ DB: mockD1(await validKeyDbTables(), { requireMatch: true }) });
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        method: "GET",
        headers: { "X-API-Key": VALID_API_KEY },
      }),
      env as never,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cached: true });
    expect(cacheMatch).toHaveBeenCalledTimes(1);
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("skips edge cache for cache-bypass endpoints", async () => {
    const env = makeEnv();
    const { ctx, waits } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/status", {
        method: "GET",
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(404);
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("records keyed /api/* traffic under the public-api lane with the key's consumer class", async () => {
    cacheMatch.mockResolvedValueOnce(new Response(JSON.stringify({ cached: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const env = makeEnv({ DB: mockD1(await validKeyDbTables(), { requireMatch: true }) });
    const { ctx, waits } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        method: "GET",
        headers: {
          "X-API-Key": VALID_API_KEY,
          Origin: "https://pharos.watch",
          Accept: `application/json, ${PHAROS_WEB_ACCEPT_MARKER}`,
          "Sec-Fetch-Site": "same-site",
        },
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(200);
    const history = env.DB.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO api_request_consumer_stats")
      && entry.binds[1] === "stablecoins"
      && entry.binds[2] === "/api/stablecoins"
      && entry.binds[3] === "public-api"
      && entry.binds[4] === "external")).toBe(true);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO api_key_request_stats")
      && entry.binds[0] === 7)).toBe(true);
  });

  it("returns a maintenance response before routing or cache lookup", async () => {
    const env = makeEnv({
      MAINTENANCE_MODE: "true",
    });
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", { method: "GET" }),
      env as never,
      ctx,
    );

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("300");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://pharos.watch");
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("writes cache on cacheable GET misses", async () => {
    const now = Math.floor(Date.now() / 1000);
    const env = makeEnv({
      DB: mockD1(await validKeyDbTables([
        {
          match: "cache",
          rows: [{ key: "stablecoins", value: JSON.stringify({ peggedAssets: [] }), updated_at: now }],
          first: { key: "stablecoins", value: JSON.stringify({ peggedAssets: [] }), updated_at: now },
        },
      ])),
    });
    const { ctx, waits } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        method: "GET",
        headers: { "X-API-Key": VALID_API_KEY },
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(200);
    expect(cacheMatch).toHaveBeenCalledTimes(1);
    expect(cachePut).toHaveBeenCalledTimes(1);
  });

  it("rejects site-api requests without the shared site-proxy secret", async () => {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://site-api.pharos.watch/api/stablecoins", { method: "GET" }),
      env as never,
      ctx,
    );

    expect(res.status).toBe(401);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("records authenticated site-api requests as site worker-lane load", async () => {
    cacheMatch.mockResolvedValueOnce(new Response(JSON.stringify({ cached: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const env = makeEnv({
      DB: mockD1([
        {
          match: "INSERT INTO api_request_consumer_stats",
          rows: [],
          runMeta: { changes: 1 },
        },
        {
          match: "DELETE FROM api_request_consumer_stats",
          rows: [],
          runMeta: { changes: 0 },
        },
        {
          match: "DELETE FROM api_key_request_stats",
          rows: [],
          runMeta: { changes: 0 },
        },
      ], { requireMatch: true }),
    });
    const { ctx, waits } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://site-api.pharos.watch/api/stablecoins", {
        method: "GET",
        headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" },
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(200);
    const history = env.DB.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO api_request_consumer_stats")
      && entry.binds[1] === "stablecoins"
      && entry.binds[2] === "/api/stablecoins"
      && entry.binds[3] === "site-api"
      && entry.binds[4] === "site")).toBe(true);
  });

  it("denies site-api admin paths even when the site-proxy secret is valid", async () => {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://site-api.pharos.watch/api/api-key-requests-admin?limit=1", {
        method: "GET",
        headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" },
      }),
      env as never,
      ctx,
    );

    expect(res.status).toBe(404);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("rejects an invalid API key with 401 on any /api/* route", async () => {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        method: "GET",
        headers: { "X-API-Key": "invalid-key" },
      }),
      env as never,
      ctx,
    );

    expect(res.status).toBe(401);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("hides admin endpoints on the public API host before API-key auth", async () => {
    const env = makeEnv({
      DB: mockD1(await validKeyDbTables(), { requireMatch: true }),
    });
    const { ctx } = makeExecutionContext();

    const listRes = await worker.fetch(
      new Request("https://api.pharos.watch/api/api-key-requests-admin", { method: "GET" }),
      env as never,
      ctx,
    );
    const rejectRes = await worker.fetch(
      new Request("https://api.pharos.watch/api/api-key-requests-admin/akr_abc12345/reject", {
        method: "POST",
      }),
      env as never,
      ctx,
    );
    const releaseRes = await worker.fetch(
      new Request("https://api.pharos.watch/api/api-key-requests-admin/akr_abc12345/release-claim", {
        method: "POST",
      }),
      env as never,
      ctx,
    );

    expect(listRes.status).toBe(404);
    expect(rejectRes.status).toBe(404);
    expect(releaseRes.status).toBe(404);
    expect(env.DB.getHistory()).toEqual([]);
  });

  it("hides malformed admin-like public paths without probing API-key auth", async () => {
    const env = makeEnv({
      DB: mockD1(await validKeyDbTables(), { requireMatch: true }),
    });
    const { ctx } = makeExecutionContext();

    const badRequestIdRes = await worker.fetch(
      new Request("https://api.pharos.watch/api/api-key-requests-admin/bad!/reject", { method: "POST" }),
      env as never,
      ctx,
    );
    const badApiKeyIdRes = await worker.fetch(
      new Request("https://api.pharos.watch/api/api-keys/0/rotate", {
        method: "POST",
        headers: { "X-API-Key": VALID_API_KEY },
      }),
      env as never,
      ctx,
    );

    expect(badRequestIdRes.status).toBe(404);
    expect(badApiKeyIdRes.status).toBe(404);
    expect(env.DB.getHistory()).toEqual([]);
  });

  it("does not let a valid public API key reach admin routes on the public host", async () => {
    const env = makeEnv({
      DB: mockD1(await validKeyDbTables(), { requireMatch: true }),
    });
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/status", {
        method: "GET",
        headers: { "X-API-Key": VALID_API_KEY },
      }),
      env as never,
      ctx,
    );

    expect(res.status).toBe(404);
    expect(env.DB.getHistory()).toEqual([]);
  });

  it("preserves ops-api admin auth failures for requests without Access", async () => {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://ops-api.pharos.watch/api/status", { method: "GET" }),
      env as never,
      ctx,
    );

    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated public-status-history and telegram-pulse with 401", async () => {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();

    const historyRes = await worker.fetch(
      new Request("https://api.pharos.watch/api/public-status-history", { method: "GET" }),
      env as never,
      ctx,
    );
    const pulseRes = await worker.fetch(
      new Request("https://api.pharos.watch/api/telegram-pulse", { method: "GET" }),
      env as never,
      ctx,
    );

    expect(historyRes.status).toBe(401);
    expect(pulseRes.status).toBe(401);
  });

  it("allows public-status-history and telegram-pulse on the site-api lane with the shared secret", async () => {
    cacheMatch
      .mockResolvedValueOnce(new Response(JSON.stringify({ currentStatus: "healthy", transitions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            activeWatchers: 10,
            coinSubscriptions: 20,
            pendingDeliveries: 0,
            updatedAt: 1771856400,
            updatedEverySeconds: 300,
            topCoins: [],
            watcherHistory: [],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    const env = makeEnv();
    const { ctx } = makeExecutionContext();

    const historyRes = await worker.fetch(
      new Request("https://site-api.pharos.watch/api/public-status-history", {
        method: "GET",
        headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" },
      }),
      env as never,
      ctx,
    );
    const pulseRes = await worker.fetch(
      new Request("https://site-api.pharos.watch/api/telegram-pulse", {
        method: "GET",
        headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" },
      }),
      env as never,
      ctx,
    );

    expect(historyRes.status).toBe(200);
    expect(await historyRes.json()).toEqual({ currentStatus: "healthy", transitions: [] });
    expect(pulseRes.status).toBe(200);
    expect(await pulseRes.json()).toEqual({
      activeWatchers: 10,
      coinSubscriptions: 20,
      pendingDeliveries: 0,
      updatedAt: 1771856400,
      updatedEverySeconds: 300,
      topCoins: [],
      watcherHistory: [],
    });
  });

  it("accepts a valid API key on /api/* routes", async () => {
    cacheMatch.mockResolvedValueOnce(new Response(JSON.stringify({ cached: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const env = makeEnv({
      DB: mockD1(await validKeyDbTables(), { requireMatch: true }),
    });
    const { ctx, waits } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        method: "GET",
        headers: { "X-API-Key": VALID_API_KEY },
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(200);
    const history = env.DB.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO api_key_rate_limit"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO api_key_request_stats") && entry.binds[0] === 7)).toBe(true);
    expect(history.some((entry) => entry.sql.includes("public_api_rate_limit"))).toBe(false);
  });

  it("serves hot protected edge-cache reads from the verified-key cache without D1 auth or limiter writes", async () => {
    cacheMatch
      .mockResolvedValueOnce(new Response(JSON.stringify({ cached: true, warm: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ cached: true, warm: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    const warmEnv = makeEnv({
      DB: mockD1(await validKeyDbTables(), { requireMatch: true }),
      REQUEST_SOURCE_ATTRIBUTION_DISABLED: "true",
      API_KEY_REQUEST_ATTRIBUTION_DISABLED: "true",
    });
    const { ctx: warmCtx, waits: warmWaits } = makeExecutionContext();
    const warmRes = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        headers: { "X-API-Key": VALID_API_KEY },
      }),
      warmEnv as never,
      warmCtx,
    );
    await Promise.all(warmWaits);

    expect(warmRes.status).toBe(200);
    await expect(warmRes.json()).resolves.toEqual({ cached: true, warm: 1 });

    const hotEnv = makeEnv({
      DB: mockD1([], { requireMatch: true }),
      REQUEST_SOURCE_ATTRIBUTION_DISABLED: "true",
      API_KEY_REQUEST_ATTRIBUTION_DISABLED: "true",
    });
    const { ctx, waits } = makeExecutionContext();
    const hotRes = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        headers: { "X-API-Key": VALID_API_KEY },
      }),
      hotEnv as never,
      ctx,
    );
    await Promise.all(waits);

    expect(hotRes.status).toBe(200);
    await expect(hotRes.json()).resolves.toEqual({ cached: true, warm: 2 });
    expect(hotEnv.DB.getHistory()).toHaveLength(0);
  });

  it("returns 503 when API key lookup storage fails", async () => {
    const env = makeEnv({
      DB: mockD1([
        {
          match: "FROM api_keys",
          matchBinds: [VALID_KEY_PREFIX],
          rows: [],
          throwError: new Error("api key lookup unavailable"),
        },
        {
          match: "INSERT INTO api_request_consumer_stats",
          rows: [],
          runMeta: { changes: 1 },
        },
        {
          match: "DELETE FROM api_request_consumer_stats",
          rows: [],
          runMeta: { changes: 0 },
        },
        {
          match: "DELETE FROM api_key_request_stats",
          rows: [],
          runMeta: { changes: 0 },
        },
      ], { requireMatch: true }),
    });
    const { ctx, waits } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        headers: { "X-API-Key": VALID_API_KEY },
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    await expect(res.json()).resolves.toEqual({ error: "Public API temporarily unavailable" });
  });

  it("serves protected cacheable reads from the fresh API key cache after a recent verification", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T10:00:00.000Z"));

    cacheMatch
      .mockResolvedValueOnce(new Response(JSON.stringify({ cached: true, warm: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ cached: true, warm: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    const warmEnv = makeEnv({
      DB: mockD1(await validKeyDbTables(), { requireMatch: true }),
      REQUEST_SOURCE_ATTRIBUTION_DISABLED: "true",
      API_KEY_REQUEST_ATTRIBUTION_DISABLED: "true",
    });
    const { ctx: warmCtx, waits: warmWaits } = makeExecutionContext();

    const warmRes = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        headers: { "X-API-Key": VALID_API_KEY },
      }),
      warmEnv as never,
      warmCtx,
    );
    await Promise.all(warmWaits);

    expect(warmRes.status).toBe(200);
    await expect(warmRes.json()).resolves.toEqual({ cached: true, warm: 1 });

    vi.advanceTimersByTime(API_KEY_AUTH_CACHE_TTL_MS - 1);

    const degradedEnv = makeEnv({
      REQUEST_SOURCE_ATTRIBUTION_DISABLED: "true",
      API_KEY_REQUEST_ATTRIBUTION_DISABLED: "true",
      DB: mockD1([
        {
          match: "FROM api_keys",
          matchBinds: [VALID_KEY_PREFIX],
          rows: [],
          throwError: new Error("api key lookup unavailable"),
        },
        { match: "INSERT INTO api_key_rate_limit", rows: [], first: { count: 1 } },
        { match: "UPDATE api_keys SET last_used_at", rows: [], runMeta: { changes: 1 } },
        { match: "DELETE FROM api_key_rate_limit", rows: [], runMeta: { changes: 0 } },
        { match: "INSERT INTO api_request_consumer_stats", rows: [], runMeta: { changes: 1 } },
        { match: "INSERT INTO api_key_request_stats", rows: [], runMeta: { changes: 1 } },
        { match: "DELETE FROM api_request_consumer_stats", rows: [], runMeta: { changes: 0 } },
        { match: "DELETE FROM api_key_request_stats", rows: [], runMeta: { changes: 0 } },
      ], { requireMatch: true }),
    });
    const { ctx, waits } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        headers: { "X-API-Key": VALID_API_KEY },
      }),
      degradedEnv as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ cached: true, warm: 2 });
    expect(
      degradedEnv.DB.getHistory().filter((entry) => entry.sql.includes("FROM api_keys") && entry.binds[0] === VALID_KEY_PREFIX),
    ).toHaveLength(0);
  });

  it("serves protected cacheable reads when API key rate-limit storage fails", async () => {
    const row = await validKeyRow();
    cacheMatch.mockResolvedValueOnce(new Response(JSON.stringify({ cached: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const env = makeEnv({
      DB: mockD1([
        { match: "FROM api_keys", matchBinds: [VALID_KEY_PREFIX], rows: [row] },
        {
          match: "INSERT INTO api_key_rate_limit",
          rows: [],
          throwError: new Error("api key limiter unavailable"),
        },
        {
          match: "INSERT INTO api_request_consumer_stats",
          rows: [],
          runMeta: { changes: 1 },
        },
        {
          match: "INSERT INTO api_key_request_stats",
          rows: [],
          runMeta: { changes: 1 },
        },
        {
          match: "UPDATE api_keys SET last_used_at = ?, last_used_route = ? WHERE id = ?",
          rows: [],
          runMeta: { changes: 1 },
        },
        {
          match: "DELETE FROM api_request_consumer_stats",
          rows: [],
          runMeta: { changes: 0 },
        },
        {
          match: "DELETE FROM api_key_request_stats",
          rows: [],
          runMeta: { changes: 0 },
        },
      ], { requireMatch: true }),
    });
    const { ctx, waits } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        headers: { "X-API-Key": VALID_API_KEY },
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ cached: true });
  });

  it("rate-limits repeated cacheable reads with the isolate-local fallback when limiter storage fails", async () => {
    cacheMatch
      .mockResolvedValueOnce(new Response(JSON.stringify({ cached: true, hit: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ cached: true, hit: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    const row = {
      ...(await validKeyRow()),
      rate_limit_per_minute: 1,
    };
    const env = makeEnv({
      DB: mockD1([
        { match: "FROM api_keys", matchBinds: [VALID_KEY_PREFIX], rows: [row] },
        {
          match: "INSERT INTO api_key_rate_limit",
          rows: [],
          throwError: new Error("api key limiter unavailable"),
        },
        {
          match: "UPDATE api_keys SET last_used_at = ?, last_used_route = ? WHERE id = ?",
          rows: [],
          runMeta: { changes: 1 },
        },
        {
          match: "INSERT INTO api_request_consumer_stats",
          rows: [],
          runMeta: { changes: 1 },
        },
        {
          match: "INSERT INTO api_key_request_stats",
          rows: [],
          runMeta: { changes: 1 },
        },
        {
          match: "DELETE FROM api_request_consumer_stats",
          rows: [],
          runMeta: { changes: 0 },
        },
        {
          match: "DELETE FROM api_key_request_stats",
          rows: [],
          runMeta: { changes: 0 },
        },
      ], { requireMatch: true }),
    });
    const { ctx: firstCtx, waits: firstWaits } = makeExecutionContext();
    const firstRes = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        headers: { "X-API-Key": VALID_API_KEY },
      }),
      env as never,
      firstCtx,
    );
    await Promise.all(firstWaits);

    expect(firstRes.status).toBe(200);
    await expect(firstRes.json()).resolves.toEqual({ cached: true, hit: 1 });

    const { ctx: secondCtx, waits: secondWaits } = makeExecutionContext();
    const secondRes = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        headers: { "X-API-Key": VALID_API_KEY },
      }),
      env as never,
      secondCtx,
    );
    await Promise.all(secondWaits);

    expect(secondRes.status).toBe(429);
    await expect(secondRes.json()).resolves.toEqual({ error: "Rate limit exceeded" });
  });

  it("serves requests when previous-pepper migration storage fails after auth succeeds", async () => {
    const oldPepper = "old-pepper";
    const newPepper = "new-pepper";
    const oldSecretHash = await hmacSha256Hex(oldPepper, VALID_KEY_SECRET);
    cacheMatch.mockResolvedValueOnce(new Response(JSON.stringify({ cached: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const env = makeEnv({
      API_KEY_HASH_PEPPER: newPepper,
      API_KEY_HASH_PEPPER_PREVIOUS: oldPepper,
      DB: mockD1([
        {
          match: "FROM api_keys",
          matchBinds: [VALID_KEY_PREFIX],
          rows: [{
            id: 7,
            key_prefix: VALID_KEY_PREFIX,
            secret_hash: oldSecretHash,
            name: "Legacy",
            owner_email: null,
            tier: "standard",
            traffic_class: "external",
            rate_limit_per_minute: 120,
            is_active: 1,
            expires_at: null,
            created_at: 1,
            updated_at: 1,
            last_used_at: null,
            last_used_route: null,
          }],
        },
        {
          match: "UPDATE api_keys SET secret_hash",
          rows: [],
          throwError: new Error("pepper migration failed"),
        },
        {
          match: "INSERT INTO api_key_rate_limit",
          rows: [],
          first: { count: 1 },
        },
        {
          match: "UPDATE api_keys SET last_used_at = ?, last_used_route = ? WHERE id = ?",
          rows: [],
          runMeta: { changes: 1 },
        },
        {
          match: "DELETE FROM api_key_rate_limit",
          rows: [],
          runMeta: { changes: 0 },
        },
        {
          match: "INSERT INTO api_request_consumer_stats",
          rows: [],
          runMeta: { changes: 1 },
        },
        {
          match: "INSERT INTO api_key_request_stats",
          rows: [],
          runMeta: { changes: 1 },
        },
        {
          match: "DELETE FROM api_request_consumer_stats",
          rows: [],
          runMeta: { changes: 0 },
        },
        {
          match: "DELETE FROM api_key_request_stats",
          rows: [],
          runMeta: { changes: 0 },
        },
      ], { requireMatch: true }),
    });
    const { ctx, waits } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        headers: { "X-API-Key": VALID_API_KEY },
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ cached: true });
  });

  it("serves protected reads when last-used metadata storage fails", async () => {
    cacheMatch.mockResolvedValueOnce(new Response(JSON.stringify({ cached: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const row = await validKeyRow();
    const env = makeEnv({
      DB: mockD1([
        { match: "FROM api_keys", matchBinds: [VALID_KEY_PREFIX], rows: [row] },
        {
          match: "INSERT INTO api_key_rate_limit",
          rows: [],
          first: { count: 1 },
        },
        {
          match: "UPDATE api_keys SET last_used_at = ?, last_used_route = ? WHERE id = ?",
          rows: [],
          throwError: new Error("usage write failed"),
        },
        {
          match: "DELETE FROM api_key_rate_limit",
          rows: [],
          runMeta: { changes: 0 },
        },
        {
          match: "INSERT INTO api_request_consumer_stats",
          rows: [],
          runMeta: { changes: 1 },
        },
        {
          match: "INSERT INTO api_key_request_stats",
          rows: [],
          runMeta: { changes: 1 },
        },
        {
          match: "DELETE FROM api_request_consumer_stats",
          rows: [],
          runMeta: { changes: 0 },
        },
        {
          match: "DELETE FROM api_key_request_stats",
          rows: [],
          runMeta: { changes: 0 },
        },
      ], { requireMatch: true }),
    });
    const { ctx, waits } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", {
        headers: { "X-API-Key": VALID_API_KEY },
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ cached: true });
  });

  it("rejects /api/* without X-API-Key with 401", async () => {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/peg-summary"),
      env as never,
      ctx,
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: "Unauthorized: valid X-API-Key required. Request self-serve access at https://pharos.watch/api/.",
    });
  });

  it("does not require a key on exempt public routes (health)", async () => {
    const env = makeEnv();
    const { ctx, waits } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/health"),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(200);
  });

  it("does not require a key on exempt OG image routes", async () => {
    // GET /api/og/* is dynamic and exempt; it may return 404 for unknown IDs
    // but must not return 401.
    const env = makeEnv();
    const { ctx, waits } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/og/stablecoin/usdc-usd-coin"),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).not.toBe(401);
  });

  it("does not require a key on exempt feedback submissions", async () => {
    const env = makeEnv();
    const { ctx, waits } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/feedback", {
        method: "POST",
        body: "not-json",
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  it("does not require a key on self-serve API key request submissions", async () => {
    const env = makeEnv();
    const { ctx, waits } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/api-key-requests", {
        method: "POST",
        body: "not-json",
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  it("does not require a key on self-serve API key verification", async () => {
    const env = makeEnv();
    const { ctx, waits } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/api-key-requests/verify", {
        method: "POST",
        body: "not-json",
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  it("rejects /api/* with a malformed X-API-Key with 401", async () => {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/peg-summary", {
        headers: { "X-API-Key": "not-a-valid-key-format" },
      }),
      env as never,
      ctx,
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: "Unauthorized: valid X-API-Key required. Request self-serve access at https://pharos.watch/api/.",
    });
  });
});
