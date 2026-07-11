import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";

const fetchWithRetryMock = vi.fn();

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  fetchJsonWithRetry: async (...args: unknown[]) => {
    const response = await fetchWithRetryMock(...args) as Response | null;
    return response ? { response, body: await response.json() } : null;
  },
}));

import { fetchMarketBackfillPriceSeries } from "../backfill-price-sources";

function makeJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeMeta(overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return {
    id: "eurc-circle",
    name: "EURC",
    symbol: "EURC",
    flags: {
      pegCurrency: "EUR",
      navToken: false,
      backing: "rwa-backed",
      governance: "centralized",
      yieldBearing: false,
      rwa: false,
      ...overrides.flags,
    },
    ...overrides,
  } as StablecoinMeta;
}

describe("fetchMarketBackfillPriceSeries", () => {
  beforeEach(() => {
    fetchWithRetryMock.mockReset();
  });

  it("prefers CoinGecko native-peg history for supported non-USD fiat assets", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(makeJsonResponse({
      prices: [
        [1_700_000_000_000, 1.001],
        [1_700_000_360_000, 0.999],
      ],
    }));

    const result = await fetchMarketBackfillPriceSeries(
      makeMeta(),
      "euro-coin",
      {
        granularity: "hourly",
        range: {
          startSec: 1_700_000_000,
          endSec: 1_700_000_720,
        },
        quote: {
          pegCurrency: "EUR",
          useNativePegQuote: true,
        },
      },
    );

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    expect(fetchWithRetryMock.mock.calls[0]?.[0]).toContain("vs_currency=eur");
    expect(result.prices).toEqual([
      { timestamp: 1_700_000_000, price: 1.001 },
      { timestamp: 1_700_000_360, price: 0.999 },
    ]);
    expect(result.diagnostics).toMatchObject({
      quoteMode: "native-peg",
      quoteCurrency: "eur",
      sourcesUsed: ["coingecko-native"],
      finalPointCount: 2,
    });
    expect(result.diagnostics.perSourceStats[0]?.source).toBe("coingecko-native");
  });

  it("does not merge DefiLlama USD history into native-peg replay mode", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(makeJsonResponse({ prices: [] }));

    const result = await fetchMarketBackfillPriceSeries(
      makeMeta(),
      "euro-coin",
      {
        granularity: "hourly",
        range: {
          startSec: 1_700_000_000,
          endSec: 1_700_000_720,
        },
        quote: {
          pegCurrency: "EUR",
          useNativePegQuote: true,
        },
      },
    );

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
    expect(fetchWithRetryMock.mock.calls[0]?.[0]).toContain("vs_currency=eur");
    expect(result.prices).toBeNull();
    expect(result.diagnostics).toMatchObject({
      quoteMode: "native-peg",
      quoteCurrency: "eur",
      sourcesUsed: [],
      mergeReasons: [],
      finalPointCount: 0,
    });
    expect(result.diagnostics.perSourceStats[0]?.source).toBe("coingecko-native");
    expect(result.diagnostics.perSourceStats).toHaveLength(1);
  });

  it("falls through alternate native quote currencies when the preferred CoinGecko fiat code is empty", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(makeJsonResponse({ prices: [] }))
      .mockResolvedValueOnce(makeJsonResponse({
        prices: [
          [1_700_000_000_000, 1.004],
        ],
      }));

    const result = await fetchMarketBackfillPriceSeries(
      makeMeta({
        id: "axcnh-anchorx",
        symbol: "AXCNH",
        flags: {
          pegCurrency: "CNH",
          navToken: false,
          backing: "rwa-backed",
          governance: "centralized",
          yieldBearing: false,
          rwa: false,
        },
      }),
      "anchorx",
      {
        granularity: "daily",
        range: {
          startSec: 1_700_000_000,
          endSec: 1_700_000_720,
        },
        quote: {
          pegCurrency: "CNH",
          useNativePegQuote: true,
        },
      },
    );

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
    expect(fetchWithRetryMock.mock.calls[0]?.[0]).toContain("vs_currency=cny");
    expect(fetchWithRetryMock.mock.calls[1]?.[0]).toContain("vs_currency=cnh");
    expect(result.diagnostics.quoteCurrency).toBe("cnh");
    expect(result.prices).toEqual([
      { timestamp: 1_700_000_000, price: 1.004 },
    ]);
  });

  it("uses the configured CoinGecko API key for historical market-chart fetches", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(makeJsonResponse({
      prices: [
        [1_700_000_000_000, 1.001],
      ],
    }));

    await fetchMarketBackfillPriceSeries(
      makeMeta(),
      "euro-coin",
      {
        granularity: "daily",
        range: {
          startSec: 1_700_000_000,
          endSec: 1_700_000_720,
        },
        quote: {
          pegCurrency: "EUR",
          useNativePegQuote: true,
        },
        coingeckoApiKey: "cg-pro-key",
      },
    );

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    expect(fetchWithRetryMock.mock.calls[0]?.[0]).toContain("https://pro-api.coingecko.com/api/v3/");
    expect(fetchWithRetryMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        "x-cg-pro-api-key": "cg-pro-key",
      }),
    });
  });
});
