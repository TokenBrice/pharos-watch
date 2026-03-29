import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { mockD1 } from "../api/__tests__/helpers/mock-d1";

function makeCtx() {
  const waits: Promise<unknown>[] = [];
  return {
    waits,
    ctx: {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        waits.push(promise);
      }),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext,
  };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: mockD1(),
    CORS_ORIGIN: "https://pharos.watch",
    PUBLIC_API_RATE_LIMIT_SALT: "test-salt",
    ...overrides,
  } as const;
}

describe("worker.fetch", () => {
  const cacheMatch = vi.fn();
  const cachePut = vi.fn(async () => undefined);

  beforeEach(() => {
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
    const { ctx } = makeCtx();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", { method: "OPTIONS" }),
      env as never,
      ctx,
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://pharos.watch");
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("echoes an allowed operator origin from the CORS allowlist", async () => {
    const env = makeEnv({
      CORS_ORIGIN: "https://pharos.watch,https://ops.pharos.watch",
    });
    const { ctx } = makeCtx();

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
    const { ctx } = makeCtx();

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
    const env = makeEnv();
    const { ctx } = makeCtx();

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

    const env = makeEnv();
    const { ctx } = makeCtx();

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
    const { ctx, waits } = makeCtx();

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
      DB: mockD1([
        {
          match: "public_api_rate_limit",
          rows: [],
          first: { count: 301 },
        },
      ]),
    });
    const { ctx } = makeCtx();

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

  it("returns a maintenance response before routing or cache lookup", async () => {
    const env = makeEnv({
      MAINTENANCE_MODE: "true",
    });
    const { ctx } = makeCtx();

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
      DB: mockD1([
        {
          match: "cache",
          rows: [{ key: "stablecoins", value: JSON.stringify({ peggedAssets: [] }), updated_at: now }],
          first: { key: "stablecoins", value: JSON.stringify({ peggedAssets: [] }), updated_at: now },
        },
      ]),
    });
    const { ctx, waits } = makeCtx();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", { method: "GET" }),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(200);
    expect(cacheMatch).toHaveBeenCalledTimes(1);
    // 1 for cache write + 1 for flushPendingPrunes (rate-limit cleanup)
    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
    expect(cachePut).toHaveBeenCalledTimes(1);
  });

  it("returns 503 for public API requests when the rate-limit salt is missing", async () => {
    const env = makeEnv({
      PUBLIC_API_RATE_LIMIT_SALT: undefined,
    });
    const { ctx } = makeCtx();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", { method: "GET" }),
      env as never,
      ctx,
    );

    expect(res.status).toBe(503);
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });
});
