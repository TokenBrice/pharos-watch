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
    const env = {
      DB: mockD1(),
      CORS_ORIGIN: "https://pharos.watch",
      ADMIN_KEY: "secret",
    } as const;
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
    const env = {
      DB: mockD1(),
      CORS_ORIGIN: "https://pharos.watch,https://ops.pharos.watch",
      ADMIN_KEY: "secret",
    } as const;
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
    const env = {
      DB: mockD1(),
      CORS_ORIGIN: "https://pharos.watch",
      ADMIN_KEY: "secret",
    } as const;
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
    const env = {
      DB: mockD1(),
      CORS_ORIGIN: "https://pharos.watch",
      ADMIN_KEY: "secret",
    } as const;
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

    const env = {
      DB: mockD1(),
      CORS_ORIGIN: "https://pharos.watch",
      ADMIN_KEY: "secret",
    } as const;
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
    const env = {
      DB: mockD1(),
      CORS_ORIGIN: "https://pharos.watch",
      ADMIN_KEY: "secret",
    } as const;
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

  it("writes cache on cacheable GET misses", async () => {
    const now = Math.floor(Date.now() / 1000);
    const env = {
      DB: mockD1([
        {
          match: "cache",
          rows: [{ key: "stablecoins", value: JSON.stringify({ peggedAssets: [] }), updated_at: now }],
          first: { key: "stablecoins", value: JSON.stringify({ peggedAssets: [] }), updated_at: now },
        },
      ]),
      CORS_ORIGIN: "https://pharos.watch",
      ADMIN_KEY: "secret",
    } as const;
    const { ctx, waits } = makeCtx();

    const res = await worker.fetch(
      new Request("https://api.pharos.watch/api/stablecoins", { method: "GET" }),
      env as never,
      ctx,
    );
    await Promise.all(waits);

    expect(res.status).toBe(200);
    expect(cacheMatch).toHaveBeenCalledTimes(1);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(cachePut).toHaveBeenCalledTimes(1);
  });
});
