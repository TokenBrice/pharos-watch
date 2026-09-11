import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createDetailResponseHelpers } from "../stablecoin-detail/shared";

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

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: fetchWithRetryMock,
  fetchJsonWithRetry: fetchJsonWithRetryMock,
}));

const { fetchCommodityTokens, handleCommodityDetail } = await import("../stablecoin-detail/commodity");
const config = { stablecoinId: "xaut-tether", geckoId: "tether-gold", protocolSlug: "tether-gold", pegType: "peggedGOLD" };
const pending: Promise<unknown>[] = [];
afterEach(async () => { await Promise.all(pending.splice(0)); });

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

  it("falls back to CoinGecko market_chart when DefiLlama TVL/price data is empty", async () => {
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

    const tokens = await fetchCommodityTokens({
      stablecoinId: "xaut-tether",
      geckoId: "tether-gold",
      protocolSlug: "tether-gold",
      pegType: "peggedGOLD",
    });

    expect(tokens).toEqual([
      {
        date: 1_700_000_000,
        totalCirculatingUSD: { peggedGOLD: 400 },
        totalCirculating: { peggedGOLD: 200 },
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

  it("uses zero units for a zero nearest price", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(Response.json({ coins: { "coingecko:tether-gold": { prices: [
        { timestamp: 100, price: 0 }, { timestamp: 300, price: 5 },
      ] } } }))
      .mockResolvedValueOnce(Response.json({ tvl: [{ date: 100, totalLiquidityUSD: 100 }] }));
    expect(await fetchCommodityTokens(config)).toEqual([
      { date: 100, totalCirculatingUSD: { peggedGOLD: 100 }, totalCirculating: { peggedGOLD: 0 } },
    ]);
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
      expect(await response.json()).toEqual({ tokens: [
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
