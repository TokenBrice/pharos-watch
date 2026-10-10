import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { buildNativeSupplyBuckets, buildTokenRowsFromMarketCaps, createDetailResponseHelpers, findNearestPrice } from "../stablecoin-detail/shared";

const fetchWithRetryMock = vi.fn<(
  url: string,
  init?: RequestInit,
  retries?: number,
  options?: Record<string, unknown>
) => Promise<Response | null>>();

const fetchJsonWithRetryMock = vi.fn<(
  url: string,
  init?: RequestInit,
  retries?: number,
  options?: Record<string, unknown>
) => Promise<{ response: Response; body: Record<string, unknown> } | null>>();

vi.mock("../../lib/fetch-retry", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchWithRetry: fetchWithRetryMock,
    fetchJsonWithRetry: fetchJsonWithRetryMock,
    fetchJsonWithSchema: async (
      url: string,
      schema: {
        safeParse: (value: unknown) =>
          | { success: true; data: unknown }
          | { success: false; error: { message: string } };
      },
      init?: RequestInit,
      retries?: number,
      options?: Record<string, unknown>,
    ) => {
      const result = await fetchJsonWithRetryMock(url, init, retries, options);
      if (!result) return null;
      const parsed = schema.safeParse(result.body);
      return parsed.success
        ? { success: true, response: result.response, body: parsed.data }
        : {
            success: false,
            response: result.response,
            failure: { kind: "schema-validation", message: parsed.error.message },
          };
    },
  };
});

const { fetchCommodityTokens, handleCommodityDetail } = await import("../stablecoin-detail/commodity");
const config = { stablecoinId: "xaut-tether", geckoId: "tether-gold", protocolSlug: "tether-gold", pegType: "peggedGOLD" };
const pending: Promise<unknown>[] = [];
afterEach(async () => { await Promise.all(pending.splice(0)); });

describe("native supply conversion", () => {
  it.each([null, undefined, 0, -1, NaN, Infinity, Number.MIN_VALUE])(
    "omits unavailable native units for price %s without dropping USD history",
    (price) => {
      const timestamp = Date.UTC(2026, 0, 1);
      const prices = typeof price === "number" ? new Map([["2026-01-01", price]]) : new Map<string, number>();
      expect(buildTokenRowsFromMarketCaps([[timestamp, 100]], "peggedUSD", prices)).toEqual([{
        date: timestamp / 1000, totalCirculatingUSD: { peggedUSD: 100 }, totalCirculating: {},
      }]);
    },
  );

  it("preserves measured zero and priced positive native units", () => {
    expect(buildNativeSupplyBuckets("peggedUSD", 0, 2)).toEqual({ peggedUSD: 0 });
    expect(buildNativeSupplyBuckets("peggedUSD", 100, 2)).toEqual({ peggedUSD: 50 });
  });

  it.each([0, -1, NaN, Infinity])("does not use an unusable nearest quote %s", (price) => {
    expect(findNearestPrice([{ timestamp: 100, price }, { timestamp: 300, price: 2 }], 100)).toBeNull();
  });

  it("distinguishes empty price history from a usable nearest quote", () => {
    expect(findNearestPrice([], 100)).toBeNull();
    expect(findNearestPrice([{ timestamp: 100, price: 2 }], 100)).toBe(2);
  });
});

describe("fetchCommodityTokens", () => {
  beforeEach(() => {
    fetchWithRetryMock.mockReset();
    fetchJsonWithRetryMock.mockReset().mockImplementation(async (url, init, retries, options) => {
      const response = await fetchWithRetryMock(url, init, retries, options);
      if (!response) return null;
      const cloned = response.clone();
      const body = (await cloned.json()) as Record<string, unknown>;
      return { response, body };
    });
  });

  it("preserves day-specific CoinGecko caps despite substantial current supply growth", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ coins: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tvl: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            market_caps: [[1_700_000_000_000, 100], [1_700_086_400_000, 300]],
            prices: [[1_700_000_000_000, 2], [1_700_086_400_000, 3]],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ market_data: { circulating_supply: 1_000 } }), { status: 200 }),
      );

    const tokens = await fetchCommodityTokens({
      stablecoinId: "xaut-tether",
      geckoId: "tether-gold",
      protocolSlug: "tether-gold",
      pegType: "peggedGOLD",
    });

    expect(tokens).toEqual([
      {
        date: 1_700_000_000,
        totalCirculatingUSD: { peggedGOLD: 100 },
        totalCirculating: { peggedGOLD: 50 },
      },
      {
        date: 1_700_086_400,
        totalCirculatingUSD: { peggedGOLD: 300 },
        totalCirculating: { peggedGOLD: 100 },
      },
    ]);
  });

  it("passes the CoinGecko API key through the commodity fallback path", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ coins: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tvl: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            market_caps: [[1_700_000_000_000, 1_000]],
            prices: [[1_700_000_000_000, 2]],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ market_data: { circulating_supply: 200 } }), { status: 200 }),
      );

    await fetchCommodityTokens({
      stablecoinId: "xaut-tether",
      geckoId: "tether-gold",
      protocolSlug: "tether-gold",
      pegType: "peggedGOLD",
      coingeckoApiKey: "cg-pro-key",
    });

    const marketChartCall = fetchWithRetryMock.mock.calls[2]?.[0];
    const detailCall = fetchWithRetryMock.mock.calls[3]?.[0];

    expect(marketChartCall).toContain("https://pro-api.coingecko.com/api/v3/");
    expect(detailCall).toContain("https://pro-api.coingecko.com/api/v3/");
  });

  it("returns an empty array when CoinGecko market chart fails in fallback", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ coins: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tvl: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "bad gateway" }), { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ market_data: {} }), { status: 200 }));

    const tokens = await fetchCommodityTokens({
      stablecoinId: "xaut-tether",
      geckoId: "tether-gold",
      protocolSlug: "tether-gold",
      pegType: "peggedGOLD",
    });

    expect(tokens).toEqual([]);
  });

  it("merges primary TVL with unsorted nearest prices without CoinGecko fallback", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(Response.json({ coins: { "coingecko:tether-gold": { prices: [
        { timestamp: 300, price: 5 }, { timestamp: 100, price: 2 }, { timestamp: 200, price: 4 },
      ] } } }))
      .mockResolvedValueOnce(Response.json({ tvl: [
        { date: 110, totalLiquidityUSD: 100 }, { date: 290, totalLiquidityUSD: 200 },
      ] }));
    expect(await fetchCommodityTokens(config)).toEqual([
      { date: 110, totalCirculatingUSD: { peggedGOLD: 100 }, totalCirculating: { peggedGOLD: 50 } },
      { date: 290, totalCirculatingUSD: { peggedGOLD: 200 }, totalCirculating: { peggedGOLD: 40 } },
    ]);
    expect(fetchWithRetryMock.mock.calls.map(([url]) => new URL(url).hostname)).toEqual([
      "coins.llama.fi", "api.llama.fi",
    ]);
  });

  it.each([0, -1, null])("preserves TVL without native units for unusable nearest price %s", async (price) => {
    fetchWithRetryMock
      .mockResolvedValueOnce(Response.json({ coins: { "coingecko:tether-gold": { prices:
        price === null ? [] : [{ timestamp: 100, price }, { timestamp: 300, price: 5 }],
      } } }))
      .mockResolvedValueOnce(Response.json({ tvl: [{ date: 100, totalLiquidityUSD: 100 }] }));
    expect(await fetchCommodityTokens(config)).toEqual([
      { date: 100, totalCirculatingUSD: { peggedGOLD: 100 }, totalCirculating: {} },
    ]);
  });

  it.each([null, 0, -1, Infinity])("retains D1 USD history when price %s cannot supply native units", async (price) => {
    const detail = createDetailResponseHelpers({
      db: mockD1([
        { match: "FROM supply_history", rows: [{ snapshot_date: 100, circulating_usd: 100, price }] },
        { match: "", rows: [], allowUnused: true },
      ]),
      stablecoinId: config.stablecoinId, pegType: config.pegType, cached: null,
      execCtx: { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext,
    });
    const response = await detail.trySupplyHistoryFallback("commodity-history-empty");
    expect(await response!.json()).toMatchObject({ tokens: [
      { date: 100, totalCirculatingUSD: { peggedGOLD: 100 }, totalCirculating: {} },
    ] });
  });

  it.each(["supply", "stale", "error"] as const)("serves %s after thrown upstream work", async (mode) => {
    fetchWithRetryMock.mockRejectedValue(new Error("upstream unavailable"));
    const db = mockD1([
      { match: "FROM supply_history", rows: mode === "supply" ? [{ snapshot_date: 100, circulating_usd: 200, price: 4 }] : [] },
      { match: "", rows: [], allowUnused: true },
    ]);
    const detail = createDetailResponseHelpers({
      db, stablecoinId: config.stablecoinId, pegType: config.pegType,
      cached: mode === "stale" ? { value: JSON.stringify({ tokens: [{ date: 50 }] }), updatedAt: 50 } : null,
      execCtx: { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext,
    });
    const response = await handleCommodityDetail(config, detail);
    expect(response.status).toBe(mode === "error" ? 502 : 200);
    if (mode === "supply") {
      expect(await response.json()).toMatchObject({ tokens: [
        { date: 100, totalCirculatingUSD: { peggedGOLD: 200 }, totalCirculating: { peggedGOLD: 50 } },
      ] });
    } else if (mode === "stale") {
      expect(await response.json()).toEqual({ tokens: [{ date: 50 }] });
      expect(response.headers.get("Warning")).toContain("stale");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    } else {
      expect(await response.json()).toEqual({ error: "Failed to fetch commodity token data" });
    }
  });
});
