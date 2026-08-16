import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";

// Stub external fetches before importing the handler
type FetchOutcome = Response | Error | Promise<Response>;
let fetchSpy: ReturnType<typeof mockFetch>;
let fetchOutcomes: FetchOutcome[] = [];
let fetchResponder: ((request: Request) => FetchOutcome) | null = null;

function queueFetch(...outcomes: FetchOutcome[]): void {
  fetchResponder = null;
  fetchOutcomes = outcomes;
}

function respondToFetch(responder: (request: Request) => FetchOutcome): void {
  fetchResponder = responder;
  fetchOutcomes = [];
}

function installFetchMock(): ReturnType<typeof mockFetch> {
  fetchOutcomes = [];
  fetchResponder = null;
  const respond = (request: Request): FetchOutcome =>
    fetchResponder?.(request) ?? fetchOutcomes.shift() ?? new Error("unexpected stablecoin detail request");
  return mockFetch([
    { match: "https://stablecoins.llama.fi/", respond },
    { match: "https://coins.llama.fi/", respond },
    { match: "https://api.llama.fi/", respond },
    { match: "https://api.coingecko.com/api/v3/", respond },
    { match: "https://pro-api.coingecko.com/api/v3/", respond },
  ], { requireMatch: true });
}

const fetchWithRetryMock = vi.fn(
  async (url: string, init?: RequestInit, _maxRetries?: number, options?: { passthrough404?: boolean }) => {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      if (res.status === 404 && options?.passthrough404) return res;
      await res.body?.cancel();
      return null;
    } catch {
      return null;
    }
  },
);
const fetchJsonWithRetryMock = vi.fn(
  async <T>(
    url: string,
    init?: RequestInit,
    maxRetries?: number,
    options?: { passthrough404?: boolean },
  ): Promise<{ response: Response; body: T } | null> => {
    const response = await fetchWithRetryMock(url, init, maxRetries, options);
    if (!response) return null;
    const cloned = response.clone();
    const body = (await cloned.json()) as T;
    return { response, body };
  },
);
const fetchTextWithRetryMock = vi.fn(
  async (
    url: string,
    init?: RequestInit,
    maxRetries?: number,
    options?: { passthrough404?: boolean },
  ): Promise<{ response: Response; body: string } | null> => {
    const response = await fetchWithRetryMock(url, init, maxRetries, options);
    if (!response) return null;
    return { response, body: await response.clone().text() };
  },
);

// Keep detail tests deterministic and fast: we validate handler behavior,
// not fetch-retry backoff timing.
vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: fetchWithRetryMock,
  fetchJsonWithRetry: fetchJsonWithRetryMock,
  fetchTextWithRetry: fetchTextWithRetryMock,
}));

const { handleStablecoinDetail, resetStablecoinDetailStateForTests } = await import("../stablecoin-detail");

type TestExecutionContext = ExecutionContext & {
  waitUntilPromises: Promise<unknown>[];
};

/** Minimal ExecutionContext stub that captures waitUntil calls */
function makeCtx(): TestExecutionContext {
  const waitUntilPromises: Promise<unknown>[] = [];
  return {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      waitUntilPromises.push(Promise.resolve(promise));
    }),
    passThroughOnException: vi.fn(),
    waitUntilPromises,
  } as unknown as TestExecutionContext;
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
    resetStablecoinDetailStateForTests();
    fetchSpy = installFetchMock();
    fetchWithRetryMock.mockReset().mockImplementation(async (url, init, _maxRetries, options) => {
      try {
        const res = await fetch(url, init);
        if (res.ok) return res;
        if (res.status === 404 && options?.passthrough404) return res;
        await res.body?.cancel();
        return null;
      } catch {
        return null;
      }
    });
    fetchJsonWithRetryMock.mockReset().mockImplementation(async (url, init, maxRetries, options) => {
      const response = await fetchWithRetryMock(url, init, maxRetries, options);
      if (!response) return null;
      const cloned = response.clone();
      const body = (await cloned.json()) as unknown;
      return { response, body };
    });
    fetchTextWithRetryMock.mockReset().mockImplementation(async (url, init, maxRetries, options) => {
      const response = await fetchWithRetryMock(url, init, maxRetries, options);
      if (!response) return null;
      return { response, body: await response.clone().text() };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    "bfusd-binance",
    "benji-franklin-templeton",
    "usr-resolv",
    "hkdr-rd-technologies",
  ])(
    "does not refresh providers for inactive catalog record %s",
    async (stablecoinId) => {
      const db = mockD1([{ match: "cache", rows: [] }]);
      const ctx = makeCtx();

      const res = await handleStablecoinDetail(db, stablecoinId, ctx);

      expect(res.status).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(ctx.waitUntil).not.toHaveBeenCalled();
    },
  );

  it("serves an inactive record's retained cache without scheduling refresh", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([{
      match: "cache",
      rows: [],
      first: { value: makeDLDetailBody(), updated_at: now - 3_600 },
    }]);
    const ctx = makeCtx();

    const res = await handleStablecoinDetail(db, "bfusd-binance", ctx);

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("returns 200 with JSON from DefiLlama for a regular stablecoin", async () => {
    const dlBody = makeDLDetailBody();

    // No cache hit
    const db = mockD1([{ match: "cache", rows: [] }]);

    queueFetch(new Response(dlBody, { status: 200 }));

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "usdt-tether", ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toMatch(/s-maxage/);

    const body = (await res.json()) as { tokens: unknown[] };
    expect(body).toHaveProperty("tokens");
    expect(Array.isArray(body.tokens)).toBe(true);
  });

  it("uses curated metadata contracts for the detail address when DefiLlama is stale", async () => {
    const dlBody = JSON.stringify({
      address: "0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a",
      tokens: [
        {
          date: 1700000000,
          totalCirculatingUSD: { peggedUSD: 100_000_000 },
          totalCirculating: { peggedUSD: 100_000_000 },
        },
      ],
      price: 1.0,
    });

    const db = mockD1([{ match: "cache", rows: [] }]);
    queueFetch(new Response(dlBody, { status: 200 }));

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "reusd-resupply", ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { address?: string };
    expect(body.address).toBe("0x57ab1e0003f623289cd798b1824be09a793e4bec");
  });

  it("applies curated detail address overrides to fresh cache hits", async () => {
    const cachedValue = JSON.stringify({
      address: "0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a",
      tokens: [
        {
          date: 1700000000,
          totalCirculatingUSD: { peggedUSD: 100_000_000 },
          totalCirculating: { peggedUSD: 100_000_000 },
        },
      ],
      price: 1.0,
    });
    const now = Math.floor(Date.now() / 1000);

    const db = mockD1([
      {
        match: "cache",
        rows: [],
        first: { value: cachedValue, updated_at: now - 60 },
      },
    ]);

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "reusd-resupply", ctx);

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    const body = (await res.json()) as { address?: string };
    expect(body.address).toBe("0x57ab1e0003f623289cd798b1824be09a793e4bec");
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
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "FROM supply_history", rows: [] },
    ]);

    queueFetch(new Response("Not Found", { status: 404 }));

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "usdt-tether", ctx);

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body).toHaveProperty("error");
  });

  it("falls back to supply_history when DefiLlama fails and no detail cache exists", async () => {
    const db = mockD1([
      { match: "cache", rows: [] },
      {
        match: "supply_history",
        rows: [{ snapshot_date: 1700000000, circulating_usd: 123_000_000, price: 1.0 }],
      },
    ]);

    queueFetch(new Response("Server Error", { status: 500 }));

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "usdt-tether", ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: Array<{ totalCirculatingUSD?: Record<string, number> }> };
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]?.totalCirculatingUSD?.peggedUSD).toBe(123_000_000);
    expect(ctx.waitUntil).toHaveBeenCalled();
  });

  it("serves stale cache immediately and refreshes in the background", async () => {
    const staleCachedValue = makeDLDetailBody({ tokens: [
      { date: 1690000000, totalCirculatingUSD: { peggedUSD: 80_000_000 }, totalCirculating: { peggedUSD: 80_000_000 } },
    ] });
    const freshUpstreamBody = makeDLDetailBody({ tokens: [
      { date: 1700000000, totalCirculatingUSD: { peggedUSD: 120_000_000 }, totalCirculating: { peggedUSD: 120_000_000 } },
    ] });
    const now = Math.floor(Date.now() / 1000);

    const db = mockD1([
      {
        match: "cache",
        rows: [],
        first: { value: staleCachedValue, updated_at: now - 600 }, // stale cache (10 min old)
      },
    ]);

    queueFetch(new Response(freshUpstreamBody, { status: 200 }));

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "usdt-tether", ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Warning")).toContain("refresh scheduled");
    const body = (await res.json()) as { tokens: Array<{ totalCirculatingUSD?: Record<string, number> }> };
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]?.totalCirculatingUSD?.peggedUSD).toBe(80_000_000);
    expect(ctx.waitUntil).toHaveBeenCalled();
    await Promise.allSettled(ctx.waitUntilPromises);
    expect(fetchSpy).toHaveBeenCalled();
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

    queueFetch(new Response("Server Error", { status: 500 }));

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "usdt-tether", ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: unknown[] };
    expect(body.tokens).toHaveLength(1);
    await Promise.allSettled(ctx.waitUntilPromises);
  });

  it("does not serve detail cache older than the max stale window when refresh fails", async () => {
    const cachedValue = makeDLDetailBody({ tokens: [
      { date: 1600000000, totalCirculatingUSD: { peggedUSD: 70_000_000 }, totalCirculating: { peggedUSD: 70_000_000 } },
    ] });
    const now = Math.floor(Date.now() / 1000);

    const db = mockD1([
      {
        match: "cache",
        rows: [],
        first: { value: cachedValue, updated_at: now - 90_000 },
      },
      { match: "supply_history", rows: [] },
    ]);

    queueFetch(new Response("Server Error", { status: 500 }));

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "usdt-tether", ctx);

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: "Failed to fetch stablecoin usdt-tether" });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
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

    queueFetch(new Error("network timeout"));

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "usdt-tether", ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: unknown[] };
    expect(body.tokens).toHaveLength(1);
    await Promise.allSettled(ctx.waitUntilPromises);
  });

  it("deduplicates concurrent stale refreshes for the same coin", async () => {
    const cachedValue = makeDLDetailBody();
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "cache",
        rows: [],
        first: { value: cachedValue, updated_at: now - 900 },
      },
    ]);
    let resolveFetch!: (response: Response) => void;
    respondToFetch(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));

    const ctxA = makeCtx();
    const ctxB = makeCtx();
    const resA = await handleStablecoinDetail(db, "usdt-tether", ctxA);
    const resB = await handleStablecoinDetail(db, "usdt-tether", ctxB);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    resolveFetch(new Response(makeDLDetailBody({ price: 1 }), { status: 200 }));
    await Promise.allSettled([...ctxA.waitUntilPromises, ...ctxB.waitUntilPromises]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("starts fresh single-flight coordination after isolate-local state is reset", async () => {
    const cachedValue = makeDLDetailBody();
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([{
      match: "cache",
      rows: [],
      first: { value: cachedValue, updated_at: now - 900 },
    }]);
    const resolvers: Array<(response: Response) => void> = [];
    respondToFetch(() => new Promise<Response>((resolve) => {
      resolvers.push(resolve);
    }));

    const ctxA = makeCtx();
    const ctxB = makeCtx();
    await handleStablecoinDetail(db, "usdt-tether", ctxA);
    resetStablecoinDetailStateForTests();
    await handleStablecoinDetail(db, "usdt-tether", ctxB);

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    for (const resolve of resolvers) {
      resolve(new Response(makeDLDetailBody({ price: 1 }), { status: 200 }));
    }
    await Promise.allSettled([...ctxA.waitUntilPromises, ...ctxB.waitUntilPromises]);
  });

  it("lets synchronous callers read a refresh also awaited by stale background refresh", async () => {
    const staleCachedValue = makeDLDetailBody({ tokens: [
      { date: 1690000000, totalCirculatingUSD: { peggedUSD: 80_000_000 }, totalCirculating: { peggedUSD: 80_000_000 } },
    ] });
    const freshUpstreamBody = makeDLDetailBody({ tokens: [
      { date: 1700000000, totalCirculatingUSD: { peggedUSD: 120_000_000 }, totalCirculating: { peggedUSD: 120_000_000 } },
    ] });
    const now = Math.floor(Date.now() / 1000);
    const staleDb = mockD1([
      {
        match: "cache",
        rows: [],
        first: { value: staleCachedValue, updated_at: now - 900 },
      },
    ]);
    const coldDb = mockD1([{ match: "cache", rows: [] }]);
    let resolveFetch!: (response: Response) => void;
    respondToFetch(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));

    const backgroundCtx = makeCtx();
    const staleRes = await handleStablecoinDetail(staleDb, "usdt-tether", backgroundCtx);
    expect(staleRes.status).toBe(200);
    expect(staleRes.headers.get("Warning")).toContain("refresh scheduled");
    expect(backgroundCtx.waitUntil).toHaveBeenCalledTimes(1);

    const syncCtx = makeCtx();
    const syncResponse = handleStablecoinDetail(coldDb, "usdt-tether", syncCtx);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    resolveFetch(new Response(freshUpstreamBody, { status: 200 }));

    const res = await syncResponse;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toMatch(/s-maxage/);
    const body = (await res.json()) as { tokens: Array<{ totalCirculatingUSD?: Record<string, number> }> };
    expect(body.tokens[0]?.totalCirculatingUSD?.peggedUSD).toBe(120_000_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(syncCtx.waitUntil).not.toHaveBeenCalled();

    await Promise.allSettled(backgroundCtx.waitUntilPromises);
  });

  it("calls ctx.waitUntil to cache the response", async () => {
    const dlBody = makeDLDetailBody();
    const db = mockD1([
      { match: "RETURNING generation", rows: [], first: { generation: 1 } },
      { match: "cache", rows: [] },
    ]);

    queueFetch(new Response(dlBody, { status: 200 }));

    const ctx = makeCtx();
    await handleStablecoinDetail(db, "usdt-tether", ctx);

    expect(ctx.waitUntil).toHaveBeenCalled();
    await Promise.allSettled(ctx.waitUntilPromises);
    const detailWrite = db.getHistory().find((entry) =>
      entry.sql.includes("INSERT INTO cache") && entry.binds[0] === "detail:usdt-tether"
    );
    expect(detailWrite?.sql).toContain("ON CONFLICT(key) DO UPDATE");
    expect(detailWrite?.sql).toContain("detail_cache_write_generations");
    expect(detailWrite?.sql).toContain("generation = ?");
  });

  it("does not claim a detail cache generation before a fresh body is ready", async () => {
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "FROM supply_history", rows: [] },
    ]);

    queueFetch(new Response("upstream unavailable", { status: 503 }));

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "usdt-tether", ctx);

    expect(res.status).toBe(502);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(db.getHistory().some((entry) => entry.sql.includes("RETURNING generation"))).toBe(false);
  });

  it("passes the CoinGecko API key through the commodity detail path", async () => {
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "FROM supply_history", rows: [] },
    ]);

    respondToFetch(async (request) => {
      const value = request.url;
      if (value.includes("coins.llama.fi/chart/coingecko:tether-gold")) {
        return new Response(JSON.stringify({ coins: {} }), { status: 200 });
      }
      if (value.includes("api.llama.fi/protocol/tether-gold")) {
        return new Response(JSON.stringify({ tvl: [] }), { status: 200 });
      }
      if (value.includes("https://pro-api.coingecko.com/api/v3/coins/tether-gold/market_chart")) {
        return new Response(JSON.stringify({
          market_caps: [[1_700_000_000_000, 1_000]],
          prices: [[1_700_000_000_000, 2]],
        }), { status: 200 });
      }
      if (value.includes("https://pro-api.coingecko.com/api/v3/coins/tether-gold?market_data=true")) {
        return new Response(JSON.stringify({ market_data: { circulating_supply: 200 } }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "xaut-tether", ctx, "cg-pro-key");

    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("https://pro-api.coingecko.com/api/v3/coins/tether-gold/market_chart"))).toBe(true);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("https://pro-api.coingecko.com/api/v3/coins/tether-gold?market_data=true"))).toBe(true);
  });

  it("normalizes non-USD DefiLlama detail responses into explicit native and USD token fields", async () => {
    const db = mockD1([{ match: "cache", rows: [] }]);
    const dlBody = JSON.stringify({
      price: 1.25,
      tokens: [
        {
          date: 1700000000,
          circulating: { peggedEUR: 80 },
        },
      ],
    });

    queueFetch(new Response(dlBody, { status: 200 }));

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "eurc-circle", ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tokens: Array<{
        circulating?: Record<string, number>;
        totalCirculating?: Record<string, number>;
        totalCirculatingUSD?: Record<string, number>;
      }>;
    };
    expect(body.tokens[0]).toEqual({
      date: 1700000000,
      circulating: { peggedEUR: 80 },
      totalCirculating: { peggedEUR: 80 },
      totalCirculatingUSD: { peggedEUR: 100 },
    });
  });

  it("returns 502 for commodity branch upstream parse failure without stale cache", async () => {
    const db = mockD1([
      { match: "cache", rows: [] },
      { match: "FROM supply_history", rows: [] },
    ]);
    queueFetch(
      new Response("{", { status: 200 }), // DL coins chart invalid JSON
      new Response(JSON.stringify({ tvl: [] }), { status: 200 }),
    );

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "xaut-tether", ctx);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Failed to fetch commodity token data" });
  });

  it("logs parse failure context during stale background refresh", async () => {
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

    queueFetch(new Response("{invalid-json", { status: 200 }));

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, "usdt-tether", ctx);

    expect(res.status).toBe(200);
    await Promise.allSettled(ctx.waitUntilPromises);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("source=defillama-stablecoin-detail-parse"));
    errorSpy.mockRestore();
  });

  it("handles supply_history fallback for gecko-only tracked coins", async () => {
    const geckoOnlyId = Array.from(TRACKED_META_BY_ID.entries()).find(([, meta]) => {
      const entry = meta as { geckoId?: string | null; llamaId?: string | null };
      return Boolean(entry.geckoId) && !entry.llamaId;
    })?.[0];
    expect(typeof geckoOnlyId).toBe("string");
    expect((geckoOnlyId ?? "").length).toBeGreaterThan(0);

    // Gecko-only coin with no market chart data returns fallback from D1
    const db = mockD1([
      { match: "cache", rows: [] },
      {
        match: "supply_history",
        rows: [{ snapshot_date: 1700000000, circulating_usd: 50_000_000, price: 1.0 }],
      },
    ]);

    // CoinGecko returns empty market_caps
    queueFetch(new Response(JSON.stringify({ market_caps: [], prices: [] }), { status: 200 }));

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

  it("falls back to supply_history when gecko-only market chart history is stale", async () => {
    const geckoOnlyId = Array.from(TRACKED_META_BY_ID.entries()).find(([, meta]) => {
      const entry = meta as { geckoId?: string | null; llamaId?: string | null };
      return Boolean(entry.geckoId) && !entry.llamaId;
    })?.[0];
    expect(typeof geckoOnlyId).toBe("string");

    const staleTsMs = (Math.floor(Date.now() / 1000) - 40 * 86400) * 1000;
    const db = mockD1([
      { match: "cache", rows: [] },
      {
        match: "supply_history",
        rows: [{ snapshot_date: 1700000000, circulating_usd: 61_000_000, price: 1.0 }],
      },
    ]);

    queueFetch(new Response(JSON.stringify({
      market_caps: [[staleTsMs, 55_000_000]],
      prices: [[staleTsMs, 1.05]],
    }), { status: 200 }));

    const ctx = makeCtx();
    const res = await handleStablecoinDetail(db, geckoOnlyId!, ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tokens: Array<{ totalCirculatingUSD?: Record<string, number> }>;
    };
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]?.totalCirculatingUSD?.peggedUSD).toBe(61_000_000);
  });
});
