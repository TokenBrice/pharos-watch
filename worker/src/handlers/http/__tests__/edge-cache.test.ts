import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEdgeCacheContext, writeEdgeCache } from "../edge-cache";

function makeContext() {
  return {
    cacheKey: new Request("https://api.pharos.watch/api/stablecoins"),
    skipCache: false,
  };
}

function makeExecutionContext() {
  return {
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> };
}

describe("createEdgeCacheContext", () => {
  it("canonicalizes OG image cache keys by stripping arbitrary query strings", () => {
    const request = new Request("https://api.pharos.watch/api/og/chain/ethereum?bust=random");
    const context = createEdgeCacheContext(request, new URL(request.url));

    expect(context.skipCache).toBe(false);
    expect(context.cacheKey.url).toBe("https://api.pharos.watch/api/og/chain/ethereum");
  });

  it("coalesces tracking-query variants for routes declared query-free", () => {
    const bareRequest = new Request("https://api.pharos.watch/api/stablecoins");
    const trackedRequest = new Request("https://api.pharos.watch/api/stablecoins?utm_source=campaign");

    const bare = createEdgeCacheContext(bareRequest, new URL(bareRequest.url));
    const tracked = createEdgeCacheContext(trackedRequest, new URL(trackedRequest.url));

    expect(tracked.cacheKey.url).toBe(bare.cacheKey.url);
  });

  it("preserves meaningful query parameters for parameterized routes", () => {
    const usdtRequest = new Request("https://api.pharos.watch/api/depeg-events?stablecoin=usdt-tether");
    const usdcRequest = new Request("https://api.pharos.watch/api/depeg-events?stablecoin=usdc-circle");

    const usdt = createEdgeCacheContext(usdtRequest, new URL(usdtRequest.url));
    const usdc = createEdgeCacheContext(usdcRequest, new URL(usdcRequest.url));

    expect(usdt.cacheKey.url).not.toBe(usdc.cacheKey.url);
  });

  it("keeps the chains leaderboard and each chain detail on separate cache keys", () => {
    const urls = [
      "https://api.pharos.watch/api/chains",
      "https://api.pharos.watch/api/chains?chain=ethereum",
      "https://api.pharos.watch/api/chains?chain=tron",
    ];
    const keys = urls.map((url) => {
      const request = new Request(url);
      return createEdgeCacheContext(request, new URL(request.url)).cacheKey.url;
    });

    expect(new Set(keys).size).toBe(3);
  });
});

describe("writeEdgeCache", () => {
  const put = vi.fn<(request: Request, response: Response) => Promise<void>>(async () => undefined);

  beforeEach(() => {
    vi.restoreAllMocks();
    put.mockReset();
    vi.stubGlobal("caches", { default: { put } });
  });

  it("stores cacheable successful responses", async () => {
    const ctx = makeExecutionContext();
    const response = new Response("{}", {
      status: 200,
      headers: { "Cache-Control": "public, s-maxage=60, max-age=10" },
    });

    writeEdgeCache(makeContext(), response, ctx);
    await Promise.all(ctx.waitUntil.mock.calls.map(([promise]) => promise));

    expect(put).toHaveBeenCalledOnce();
  });

  it("stores cacheable responses without dropping Vary metadata", async () => {
    const ctx = makeExecutionContext();
    const response = new Response("{}", {
      status: 200,
      headers: {
        "Cache-Control": "public, s-maxage=60, max-age=10",
        Vary: "Authorization",
      },
    });

    writeEdgeCache(makeContext(), response, ctx);
    await Promise.all(ctx.waitUntil.mock.calls.map(([promise]) => promise));

    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0]?.[1]?.headers.get("Vary")).toBe("Authorization");
  });

  it("skips no-store, no-cache, and private responses", () => {
    for (const cacheControl of ["no-store", "public, no-cache", "private, max-age=60"]) {
      const ctx = makeExecutionContext();
      const response = new Response("{}", {
        status: 200,
        headers: { "Cache-Control": cacheControl },
      });

      writeEdgeCache(makeContext(), response, ctx);
      expect(ctx.waitUntil).not.toHaveBeenCalled();
    }
    expect(put).not.toHaveBeenCalled();
  });

  it("contains cache put failures inside waitUntil", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    put.mockRejectedValueOnce(new Error("cache unavailable"));
    const ctx = makeExecutionContext();

    writeEdgeCache(makeContext(), new Response("{}", { status: 200 }), ctx);
    await Promise.all(ctx.waitUntil.mock.calls.map(([promise]) => promise));

    const [payload] = warn.mock.calls[warn.mock.calls.length - 1] ?? [];
    expect(JSON.parse(String(payload))).toMatchObject({
      scope: "http",
      level: "warn",
      event: "edge_cache_write_failed",
      route: "/api/stablecoins",
      errorName: "Error",
      errorMessage: "cache unavailable",
    });
  });
});
