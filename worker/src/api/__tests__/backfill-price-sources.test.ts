import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import { mockFetchRetry } from "../../test-helpers/cron";

const fetchWithRetryMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/fetch-retry", () => mockFetchRetry({ fetchWithRetry: fetchWithRetryMock }));

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
  afterEach(() => vi.useRealTimers());

  it("falls back from empty USD CoinGecko history to DefiLlama", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(makeJsonResponse({ prices: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ coins: { "coingecko:tether": { prices: [
        { timestamp: 1_700_000_000, price: 0.99 },
      ] } } }));
    const result = await fetchMarketBackfillPriceSeries(makeMeta({ id: "usdt-tether" }), "tether", {
      granularity: "daily", range: { startSec: 1_700_000_000, endSec: 1_700_086_400 },
    });
    expect(result.prices).toEqual([{ timestamp: 1_700_000_000, price: 0.99 }]);
    expect(result.diagnostics).toMatchObject({
      quoteMode: "usd", quoteCurrency: "usd", sourcesUsed: ["defillama"],
      mergeReasons: ["coingecko-empty"], finalPointCount: 1,
      perSourceStats: [
        { source: "coingecko", points: 0, startTimestamp: null, endTimestamp: null },
        { source: "defillama", points: 1, startTimestamp: 1_700_000_000, endTimestamp: 1_700_000_000 },
      ],
    });
  });

  it("merges stale sparse USD history with DefiLlama precedence and sorted unique timestamps", async () => {
    vi.useFakeTimers();
    const now = 1_800_000_000;
    const old = now - 50 * 86_400;
    const recent = now - 15 * 86_400;
    vi.setSystemTime(now * 1000);
    fetchWithRetryMock
      .mockResolvedValueOnce(makeJsonResponse({ prices: [[recent * 1000, 0.97], [old * 1000, 0.99]] }))
      .mockResolvedValueOnce(makeJsonResponse({ coins: { "coingecko:tether": { prices: [
        { timestamp: now, price: 1 }, { timestamp: recent, price: 0.98 },
        { timestamp: now, price: 1.001 },
      ] } } }));
    const result = await fetchMarketBackfillPriceSeries(makeMeta({ id: "usdt-tether" }), "tether", {
      granularity: "daily", range: { startSec: old, endSec: now },
    });
    expect(result.prices).toEqual([
      { timestamp: old, price: 0.99 }, { timestamp: recent, price: 0.98 }, { timestamp: now, price: 1.001 },
    ]);
    expect(result.diagnostics).toMatchObject({
      sourcesUsed: ["defillama", "coingecko"],
      mergeReasons: ["coingecko-tail-stale", "coingecko-recent-sparse", "coingecko-span-sparse"],
      finalPointCount: 3,
      perSourceStats: [
        { source: "coingecko", points: 2, startTimestamp: old, endTimestamp: recent },
        { source: "defillama", points: 2, startTimestamp: recent, endTimestamp: now },
      ],
    });
  });

  it("excludes above-limit prices at both inclusive policy endpoints but retains the exact maximum", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_534_000_001_000);
    fetchWithRetryMock.mockResolvedValue(makeJsonResponse({ coins: {} }));
    const result = await fetchMarketBackfillPriceSeries(makeMeta({ id: "usdt-tether" }), "tether", {
      granularity: "daily", range: { startSec: 1_530_999_999, endSec: 1_534_000_001 },
      seedCoinGeckoPrices: [
        { timestamp: 1_530_999_999, price: 1.021 },
        { timestamp: 1_531_000_000, price: 1.021 },
        { timestamp: 1_531_000_001, price: 1.02 },
        { timestamp: 1_533_999_999, price: 1.019 },
        { timestamp: 1_534_000_000, price: 1.021 },
        { timestamp: 1_534_000_001, price: 1.021 },
      ],
    });
    expect(result.prices).toEqual([
      { timestamp: 1_530_999_999, price: 1.021 },
      { timestamp: 1_531_000_001, price: 1.02 },
      { timestamp: 1_533_999_999, price: 1.019 },
      { timestamp: 1_534_000_001, price: 1.021 },
    ]);
    expect(result.diagnostics.policyAdjustments).toEqual([
      { source: "coingecko", adjustment: "above-peg-clamp", removedPoints: 2 },
    ]);
  });

  it("rejects cancellation during hourly pacing without returning empty history or calling a provider", async () => {
    const controller = new AbortController();
    const pending = fetchMarketBackfillPriceSeries(makeMeta(), "euro-coin", {
      granularity: "hourly", range: { startSec: 1_700_000_000, endSec: 1_700_000_720 },
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
  });

  it("prefers CoinGecko native-peg history for supported non-USD fiat assets", async () => {
    vi.useFakeTimers();
    fetchWithRetryMock.mockResolvedValueOnce(makeJsonResponse({
      prices: [
        [1_700_000_000_000, 1.001],
        [1_700_000_360_000, 0.999],
      ],
    }));

    const pending = fetchMarketBackfillPriceSeries(
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
    await vi.runAllTimersAsync();
    const result = await pending;

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
    vi.useFakeTimers();
    fetchWithRetryMock.mockResolvedValueOnce(makeJsonResponse({ prices: [] }));

    const pending = fetchMarketBackfillPriceSeries(
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
    await vi.runAllTimersAsync();
    const result = await pending;

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
