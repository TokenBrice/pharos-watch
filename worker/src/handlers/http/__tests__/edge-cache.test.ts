import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEdgeCacheContext, readEdgeCache, writeEdgeCache } from "../edge-cache";
import { addFreshnessHeaders } from "../../../lib/api-freshness-headers";

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
  it("strips conditional and range headers before asking Cache API for a full representation", () => {
    const request = new Request("https://api.pharos.watch/api/yield-rankings?projection=summary", {
      headers: { "If-None-Match": '"generation"', "If-Modified-Since": new Date().toUTCString(),
        Range: "bytes=0-100", "If-Range": '"generation"' },
    });
    const context = createEdgeCacheContext(request, new URL(request.url));
    expect(context.cacheKey.url).toBe(request.url);
    expect(Array.from(context.cacheKey.headers.keys())).toEqual([]);
  });

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

  it("keeps only declared query parameters in a public-status-history cache key", () => {
    const canonical = (url: string) => {
      const request = new Request(url);
      return createEdgeCacheContext(request, new URL(request.url)).cacheKey.url;
    };

    const baseline = canonical("https://api.pharos.watch/api/public-status-history?window=7d&limit=200");
    expect(canonical("https://api.pharos.watch/api/public-status-history?window=7d&limit=200&bust=random"))
      .toBe(baseline);
    expect(canonical("https://api.pharos.watch/api/public-status-history?limit=200&window=7d"))
      .toBe(baseline);
    expect(canonical("https://api.pharos.watch/api/public-status-history?window=24h&limit=200"))
      .not.toBe(baseline);
    expect(canonical("https://api.pharos.watch/api/public-status-history?window=7d&window=24h&limit=200"))
      .toBe(baseline);
  });

  it("coalesces tracking-query variants for dynamic routes declared query-free", () => {
    const bare = createEdgeCacheContext(
      new Request("https://api.pharos.watch/api/stablecoin/usdt-tether"),
      new URL("https://api.pharos.watch/api/stablecoin/usdt-tether"),
    );
    const tracked = createEdgeCacheContext(
      new Request("https://api.pharos.watch/api/stablecoin/usdt-tether?cb=random"),
      new URL("https://api.pharos.watch/api/stablecoin/usdt-tether?cb=random"),
    );
    const liveSummary = createEdgeCacheContext(
      new Request("https://api.pharos.watch/api/stablecoin-live-summary/usdt-tether?cb=random"),
      new URL("https://api.pharos.watch/api/stablecoin-live-summary/usdt-tether?cb=random"),
    );

    expect(tracked.cacheKey.url).toBe(bare.cacheKey.url);
    expect(liveSummary.cacheKey.url).toBe("https://api.pharos.watch/api/stablecoin-live-summary/usdt-tether");
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
  const match = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    put.mockReset();
    match.mockReset();
    vi.stubGlobal("caches", { default: { put, match } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not read or write excluded requests", async () => {
    const context = { ...makeContext(), skipCache: true };
    const ctx = makeExecutionContext();
    await expect(readEdgeCache(context)).resolves.toBeNull();
    writeEdgeCache(context, new Response("ok"), ctx);
    expect(match).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("normalizes a miss and returns the matching stored response on a hit", async () => {
    const context = makeContext();
    match.mockResolvedValueOnce(undefined);
    await expect(readEdgeCache(context)).resolves.toBeNull();
    const cached = new Response("cached", { headers: {
      "Cache-Control": "public, max-age=60", Date: new Date().toUTCString(),
    } });
    match.mockImplementationOnce(async (key: Request) => key.url === context.cacheKey.url ? cached : undefined);
    await expect(readEdgeCache(context)).resolves.toBe(cached);
  });

  it("misses across the bounded freshness transition while preserving hit Age and Date", async () => {
    const assessedAt = 1_800_000_000;
    const headers = addFreshnessHeaders({
      "Cache-Control": "public, s-maxage=300, max-age=60, stale-while-revalidate=300",
      Age: "0",
    }, assessedAt - 4_790, 600, { assessedAt });
    const cached = new Response('{"_meta":{"status":"fresh"}}', { headers });
    match.mockResolvedValue(cached);
    const clock = vi.spyOn(Date, "now").mockReturnValue((assessedAt + 9) * 1_000);
    const hit = await readEdgeCache(makeContext());
    expect(hit?.headers.get("Date")).toBe(headers.Date);
    expect(hit?.headers.get("Age")).toBe("0");
    expect(await hit?.json()).toEqual({ _meta: { status: "fresh" } });
    clock.mockReturnValue((assessedAt + 10) * 1_000);
    await expect(readEdgeCache(makeContext())).resolves.toBeNull();
  });

  it("honors accumulated Age even when Date is younger than the bounded TTL", async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    match.mockResolvedValue(new Response("cached", {
      headers: { "Cache-Control": "public, s-maxage=10, max-age=60", Date: new Date(now).toUTCString(), Age: "10" },
    }));
    await expect(readEdgeCache(makeContext())).resolves.toBeNull();
  });

  it.each([
    { Date: "invalid", Age: "0" },
    { Date: new Date().toUTCString(), Age: "-1" },
    { Date: new Date().toUTCString(), Age: "unknown" },
  ])("rejects unreadable lifetime bounds %j", async (bounds) => {
    match.mockResolvedValue(new Response("cached", { headers: { "Cache-Control": "public, max-age=60", ...bounds } }));
    await expect(readEdgeCache(makeContext())).resolves.toBeNull();
  });

  it.each([206, 304])("rejects unexpected Cache API status %s before reuse", async (status) => {
    match.mockResolvedValue(new Response(status === 304 ? null : "partial", { status }));
    await expect(readEdgeCache(makeContext())).resolves.toBeNull();
  });

  it("never stores error responses even with public cache control", () => {
    const ctx = makeExecutionContext();
    writeEdgeCache(makeContext(), new Response("unavailable", {
      status: 503, headers: { "Cache-Control": "public, max-age=60" },
    }), ctx);
    expect(put).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
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
    await expect(put.mock.calls[0]![1].text()).resolves.toBe("{}");
    await expect(response.text()).resolves.toBe("{}");
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

});
