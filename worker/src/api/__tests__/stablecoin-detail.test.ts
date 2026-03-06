import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";

// Stub external fetches before importing the handler
const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchSpy);

// Keep detail tests deterministic and fast: we validate handler behavior,
// not fetch-retry backoff timing.
vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async (
    url: string,
    init?: RequestInit,
    _maxRetries?: number,
    options?: { passthrough404?: boolean },
  ) => {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      if (res.status === 404 && options?.passthrough404) return res;
      await res.body?.cancel();
      return null;
    } catch {
      return null;
    }
  }),
}));

const { handleStablecoinDetail } = await import("../stablecoin-detail");

/** Minimal ExecutionContext stub that captures waitUntil calls */
function makeCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

/** Helper to build a DefiLlama-style detail response body */
function makeDLDetailBody(overrides: Partial<{ tokens: unknown[]; price: number }> = {}) {
  return JSON.stringify({
    tokens: overrides.tokens ?? [
      {
        date: 1700000000,
        totalCirculatingUSD: { peggedUSD: 100_000_000 },
        totalCirculating: { peggedUSD: 100_000_000 },
      },
    ],
    price: overrides.price ?? 1.0,
  });
}

describe("handleStablecoinDetail", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
  });

  it("returns 200 with JSON from DefiLlama for a regular stablecoin", async () => {
    const dlBody = makeDLDetailBody();

    // No cache hit
    const db = mockD1([
      { match: "cache", rows: [] },
    ]);

    fetchSpy.mockResolvedValueOnce(new Response(dlBody, { status: 200 }));

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "usdt-tether", ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toMatch(/s-maxage/);

    const body = (await res.json()) as { tokens: unknown[] };
    expect(body).toHaveProperty("tokens");
    expect(Array.isArray(body.tokens)).toBe(true);
  });

  it("returns cached response when cache is fresh", async () => {
    const cachedValue = makeDLDetailBody();
    const now = Math.floor(Date.now() / 1000);

    const db = mockD1([
      {
        match: "cache",
        rows: [],
        first: { value: cachedValue, updated_at: now - 60 }, // 60s ago — well within 5min TTL
      },
    ]);

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "usdt-tether", ctx);

    expect(res.status).toBe(200);
    // Should NOT call fetch when cache is fresh
    expect(fetchSpy).not.toHaveBeenCalled();

    const body = (await res.json()) as { tokens: unknown[] };
    expect(body.tokens).toHaveLength(1);
  });

  it("returns 502 when upstream fails and no cache exists", async () => {
    const db = mockD1([{ match: "cache", rows: [] }]);

    fetchSpy.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "usdt-tether", ctx);

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body).toHaveProperty("error");
  });

  it("returns stale cache when upstream fails but cache exists", async () => {
    const cachedValue = makeDLDetailBody();
    const now = Math.floor(Date.now() / 1000);

    const db = mockD1([
      {
        match: "cache",
        rows: [],
        first: { value: cachedValue, updated_at: now - 600 }, // stale cache (10 min old)
      },
    ]);

    fetchSpy.mockResolvedValueOnce(new Response("Server Error", { status: 500 }));

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "usdt-tether", ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: unknown[] };
    expect(body.tokens).toHaveLength(1);
  });

  it("returns stale cache on upstream timeout when cache exists", async () => {
    const cachedValue = makeDLDetailBody();
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "cache",
        rows: [],
        first: { value: cachedValue, updated_at: now - 800 },
      },
    ]);

    fetchSpy.mockRejectedValue(new Error("network timeout"));

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "usdt-tether", ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: unknown[] };
    expect(body.tokens).toHaveLength(1);
  });

  it("calls ctx.waitUntil to cache the response", async () => {
    const dlBody = makeDLDetailBody();
    const db = mockD1([{ match: "cache", rows: [] }]);

    fetchSpy.mockResolvedValueOnce(new Response(dlBody, { status: 200 }));

    const ctx = makeCtx();
    await handleStablecoinDetail(db, "usdt-tether", ctx);

    expect(ctx.waitUntil).toHaveBeenCalled();
  });

  it("returns 502 for commodity branch upstream parse failure without stale cache", async () => {
    const db = mockD1([{ match: "cache", rows: [] }]);
    fetchSpy
      .mockResolvedValueOnce(new Response("{", { status: 200 })) // DL coins chart invalid JSON
      .mockResolvedValueOnce(new Response(JSON.stringify({ tvl: [] }), { status: 200 }));

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "xaut-tether", ctx);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Invalid upstream data for stablecoin xaut-tether" });
  });

  it("logs parse failure context and returns stale cache when detail JSON is invalid", async () => {
    const cachedValue = makeDLDetailBody();
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "cache",
        rows: [],
        first: { value: cachedValue, updated_at: now - 1200 },
      },
    ]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    fetchSpy.mockResolvedValueOnce(new Response("{invalid-json", { status: 200 }));

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "usdt-tether", ctx);

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("source=defillama-stablecoin-detail-parse"),
    );
    errorSpy.mockRestore();
  });

  it("handles supply_history fallback for gecko-only tracked coins", async () => {
    const geckoOnlyId = Array.from(TRACKED_META_BY_ID.entries()).find(([, meta]) => {
      const entry = meta as { geckoId?: string | null; llamaId?: string | null };
      return Boolean(entry.geckoId) && !entry.llamaId;
    })?.[0];
    expect(geckoOnlyId).toBeTruthy();

    // Gecko-only coin with no market chart data returns fallback from D1
    const db = mockD1([
      { match: "cache", rows: [] },
      {
        match: "supply_history",
        rows: [
          { snapshot_date: 1700000000, circulating_usd: 50_000_000, price: 1.0 },
        ],
      },
    ]);

    // CoinGecko returns empty market_caps
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ market_caps: [], prices: [] }), { status: 200 })
    );

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, geckoOnlyId!, ctx);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/market_chart?vs_currency=usd&days=max"),
      expect.anything(),
    );

    const body = (await res.json()) as { tokens: unknown[] };
    expect(body.tokens).toHaveLength(1);
  });
});
