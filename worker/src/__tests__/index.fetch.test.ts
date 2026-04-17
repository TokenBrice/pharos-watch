import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { mockD1 } from "../api/__tests__/helpers/mock-d1";
import { hmacSha256Hex, makeExecutionContext } from "../api/__tests__/helpers/auth";
import { resetRateLimitStateForTests } from "../lib/rate-limit";
import { resetRequestAttributionStateForTests } from "../lib/request-source-attribution";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: mockD1(),
    CORS_ORIGIN: "https://pharos.watch",
    PUBLIC_API_RATE_LIMIT_SALT: "test-salt",
    SITE_API_SHARED_SECRET: "site-secret",
    ...overrides,
  } as const;
}

describe("worker.fetch", () => {
  const cacheMatch = vi.fn();
  const cachePut = vi.fn(async () => undefined);

  beforeEach(() => {
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

  it("rejects GET on mutating admin endpoints", async () => {
    const env = makeEnv();
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/backfill-depegs", { method: "GET" }),
      env as never,
      ctx,
    );

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://pharos.watch");
  });

  it("rejects POST on read-only endpoints", async () => {
    const env = makeEnv({ PUBLIC_API_AUTH_MODE: "off" });
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", { method: "POST" }),
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

    const env = makeEnv({ PUBLIC_API_AUTH_MODE: "off" });
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", { method: "GET" }),
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
      new Request("https://api.pharos.watch/api/health", { method: "GET" }),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(200);
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("applies the distributed public API rate limit before routing", async () => {
    const env = makeEnv({
      PUBLIC_API_AUTH_MODE: "off",
      DB: mockD1([
        {
          match: "public_api_rate_limit",
          rows: [],
          first: { count: 301 },
        },
      ]),
    });
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", { method: "GET" }),
      env as never,
      ctx,
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://pharos.watch");
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("records first-party request attribution telemetry for public API traffic", async () => {
    cacheMatch.mockResolvedValueOnce(new Response(JSON.stringify({ cached: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const env = makeEnv({
      PUBLIC_API_AUTH_MODE: "off",
      DB: mockD1([
        {
          match: "public_api_rate_limit",
          rows: [],
          first: { count: 1 },
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
        method: "GET",
        headers: {
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
      && entry.binds[4] === "site")).toBe(true);
  });

  it("enters a bounded emergency block after repeated distributed rate-limit failures", async () => {
    const env = makeEnv({
      PUBLIC_API_AUTH_MODE: "off",
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
    const { ctx } = makeExecutionContext();
    cacheMatch.mockResolvedValue(new Response(JSON.stringify({ cached: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const request = new Request("https://api.pharos.watch/api/stablecoins", { method: "GET" });

    const first = await worker.fetch(request, env as never, ctx);
    const second = await worker.fetch(request, env as never, ctx);
    const third = await worker.fetch(request, env as never, ctx);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(503);
    expect(third.headers.get("Retry-After")).toBe("60");
    await expect(third.json()).resolves.toEqual({ error: "Public API temporarily unavailable" });
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
      PUBLIC_API_AUTH_MODE: "off",
      DB: mockD1([
        {
          match: "cache",
          rows: [{ key: "stablecoins", value: JSON.stringify({ peggedAssets: [] }), updated_at: now }],
          first: { key: "stablecoins", value: JSON.stringify({ peggedAssets: [] }), updated_at: now },
        },
      ]),
    });
    const { ctx, waits } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", { method: "GET" }),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(200);
    expect(cacheMatch).toHaveBeenCalledTimes(1);
    // 1 for request-source attribution + 1 for cache write + 1 for flushPendingPrunes (rate-limit cleanup)
    expect(ctx.waitUntil).toHaveBeenCalledTimes(3);
    expect(cachePut).toHaveBeenCalledTimes(1);
  });

  it("returns 503 for public API requests when the rate-limit salt is missing", async () => {
    const env = makeEnv({
      PUBLIC_API_AUTH_MODE: "off",
      PUBLIC_API_RATE_LIMIT_SALT: undefined,
    });
    const { ctx } = makeExecutionContext();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", { method: "GET" }),
      env as never,
      ctx,
    );

    expect(res.status).toBe(503);
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
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

  it("enforces API keys on protected public routes when auth mode is enforce", async () => {
    const env = makeEnv({
      PUBLIC_API_AUTH_MODE: "enforce",
      API_KEY_HASH_PEPPER: "pepper",
      DB: mockD1([
        {
          match: "public_api_rate_limit",
          rows: [],
          first: { count: 1 },
        },
        {
          match: "DELETE FROM public_api_rate_limit",
          rows: [],
          runMeta: { changes: 0 },
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
        method: "GET",
        headers: { "X-API-Key": "invalid-key" },
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(401);
    expect(env.DB.getHistory().some((entry) => entry.sql.includes("public_api_rate_limit"))).toBe(true);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("enforces API keys on public-status-history and telegram-pulse when auth mode is enforce", async () => {
    const env = makeEnv({
      PUBLIC_API_AUTH_MODE: "enforce",
      API_KEY_HASH_PEPPER: "pepper",
      DB: mockD1([
        {
          match: "public_api_rate_limit",
          rows: [],
          first: { count: 1 },
        },
        {
          match: "DELETE FROM public_api_rate_limit",
          rows: [],
          runMeta: { changes: 0 },
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
    await Promise.all(waits);

    expect(historyRes.status).toBe(401);
    expect(pulseRes.status).toBe(401);
    expect(env.DB.getHistory().filter((entry) => entry.sql.includes("public_api_rate_limit")).length).toBeGreaterThanOrEqual(2);
  });

  it("allows public-status-history and telegram-pulse on the site-api lane with the shared secret", async () => {
    cacheMatch
      .mockResolvedValueOnce(new Response(JSON.stringify({ currentStatus: "healthy", transitions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ activeWatchers: 10, coinSubscriptions: 20, topCoins: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

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
    expect(await pulseRes.json()).toEqual({ activeWatchers: 10, coinSubscriptions: 20, topCoins: [] });
  });

  it("falls back to the public limiter for invalid protected-route keys in report-only mode", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    cacheMatch.mockResolvedValueOnce(new Response(JSON.stringify({ cached: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const env = makeEnv({
      PUBLIC_API_AUTH_MODE: "report-only",
      API_KEY_HASH_PEPPER: "pepper",
      DB: mockD1([
        {
          match: "public_api_rate_limit",
          rows: [],
          first: { count: 1 },
        },
        {
          match: "DELETE FROM public_api_rate_limit",
          rows: [],
          runMeta: { changes: 0 },
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
        method: "GET",
        headers: { "X-API-Key": "invalid-key" },
      }),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cached: true });
    expect(env.DB.getHistory().some((entry) => entry.sql.includes("public_api_rate_limit"))).toBe(true);
    expect(warn).toHaveBeenCalledWith("[public-api-auth] rejected invalid request on /api/stablecoins");
  });

  it("accepts a valid API key on protected routes even when auth mode is off", async () => {
    cacheMatch.mockResolvedValueOnce(new Response(JSON.stringify({ cached: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const pepper = "pepper";
    const secret = "abcdefghijklmnopqrstuvwxyzABCDEF";
    const secretHash = await hmacSha256Hex(pepper, secret);
    const env = makeEnv({
      PUBLIC_API_AUTH_MODE: "off",
      API_KEY_HASH_PEPPER: pepper,
      DB: mockD1([
        {
          match: "FROM api_keys",
          matchBinds: ["0123456789abcdef"],
          rows: [{
            id: 7,
            key_prefix: "0123456789abcdef",
            secret_hash: secretHash,
            name: "Smoke",
            owner_email: "ops@pharos.watch",
            tier: "ci",
            traffic_class: "external",
            rate_limit_per_minute: 180,
            is_active: 1,
            created_at: 1,
            updated_at: 1,
            last_used_at: null,
            last_used_route: null,
          }],
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
        method: "GET",
        headers: { "X-API-Key": "ph_live_0123456789abcdef_abcdefghijklmnopqrstuvwxyzABCDEF" },
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
});
