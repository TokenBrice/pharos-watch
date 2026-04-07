import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithRetryMock = vi.fn<(
  url: string,
  init?: RequestInit,
  retries?: number,
  options?: Record<string, unknown>
) => Promise<Response | null>>();

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: fetchWithRetryMock,
}));

const { fetchCommodityTokens } = await import("../stablecoin-detail/commodity");

describe("fetchCommodityTokens", () => {
  beforeEach(() => {
    fetchWithRetryMock.mockReset();
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
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ market_data: {} }), { status: 200 }));

    const tokens = await fetchCommodityTokens({
      stablecoinId: "xaut-tether",
      geckoId: "tether-gold",
      protocolSlug: "tether-gold",
      pegType: "peggedGOLD",
    });

    expect(tokens).toEqual([]);
  });
});
