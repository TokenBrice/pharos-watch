import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCgPriceHistoryHourly, fetchMarketBackfillPriceSeries, screenDailyPriceOutliers } from "../historical-market-prices";
import { RATE_LIMITS } from "../rate-limit";
import { USER_AGENT } from "../constants";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), log: vi.fn() }));
vi.mock("../fetch-retry", () => ({ fetchJsonWithRetry: mocks.fetch }));
vi.mock("../structured-log", () => ({ logWorkerEventArgs: mocks.log }));

const DAY = 86_400;
const EPOCH = 1_517_270_400; // 2018-01-30T00:00:00Z
const NOW = EPOCH + 180 * DAY;
const BASE = "https://api.coingecko.com/api/v3/coins/test-coin/market_chart";
const chart = (prices: number[][]) => ({ body: { prices } });
const rangeUrl = (from: number, to: number, currency = "usd") =>
  `${BASE}/range?vs_currency=${currency}&from=${from}&to=${to}&precision=full`;
const daily = (range?: { startSec?: number; endSec?: number }, signal?: AbortSignal) =>
  fetchMarketBackfillPriceSeries({ id: "test-coin", flags: { pegCurrency: "EUR" } }, "test-coin", {
    granularity: "daily", range, quote: { useNativePegQuote: true }, signal,
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  mocks.fetch.mockReset();
  mocks.log.mockReset();
});
afterEach(() => vi.useRealTimers());

async function finish<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

describe("screenDailyPriceOutliers", () => {
  const day = (offset: number, price: number) => ({ timestamp: NOW + offset * DAY, price });

  it("withholds a one-day 10^-6 scaling defect instead of publishing it", () => {
    const prices = [day(-2, 0.787), day(-1, 0.787), day(0, 8.302818387614223e-7), day(1, 0.789), day(2, 0.789)];
    expect(screenDailyPriceOutliers(prices)).toEqual({
      prices: [prices[0], prices[1], prices[3], prices[4]],
      removed: [prices[2]],
    });
  });

  it("withholds a two-day thin-venue excursion that the surrounding week does not corroborate", () => {
    const prices = [
      day(-3, 0.169), day(-2, 0.169), day(-1, 0.1692),
      day(0, 0.0795), day(1, 0.077), day(2, 0.1727), day(3, 0.173), day(4, 0.1727),
    ];
    const result = screenDailyPriceOutliers(prices);
    expect(result.removed).toEqual([prices[3], prices[4]]);
    expect(result.prices).toEqual([prices[0], prices[1], prices[2], prices[5], prices[6], prices[7]]);
  });

  it("keeps gradual moves, short series, and points with fewer than two neighbours", () => {
    const gradual = [day(0, 0.9), day(1, 1.0), day(2, 1.1), day(3, 1.2)];
    expect(screenDailyPriceOutliers(gradual)).toEqual({ prices: gradual, removed: [] });
    const short = [day(0, 1), day(1, 5)];
    expect(screenDailyPriceOutliers(short)).toEqual({ prices: short, removed: [] });
  });
});

describe("historical CoinGecko prices-only transport parity", () => {
  it.each([undefined, { startSec: EPOCH, endSec: NOW }])("retains the daily URL and unpaced positive-price decoding (%j)", async (range) => {
    mocks.fetch.mockResolvedValue(chart([[NOW * 1000 + 999, 1], [NOW * 1000, 2], [NOW * 1000, 0], [NOW * 1000, -1]]));
    expect((await daily(range)).prices).toEqual([{ timestamp: NOW, price: 2 }]);
    expect(mocks.fetch.mock.calls).toEqual([[
      range ? rangeUrl(EPOCH, NOW, "eur") : `${BASE}?vs_currency=eur&days=max`,
      { headers: { "User-Agent": USER_AGENT }, signal: undefined }, 2, { timeoutMs: 30_000 },
    ]]);
    expect(Date.now()).toBe(NOW * 1000);
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it("preserves the pre-epoch request, 89-day chunks, pacing, key and last-write overlap replacement", async () => {
    const times: number[] = [];
    const responses = [chart([[(EPOCH - 1) * 1000, 1], [EPOCH * 1000, 1]]),
      chart([[EPOCH * 1000, 2], [(EPOCH + 89 * DAY) * 1000, 3]]),
      chart([[(EPOCH + 89 * DAY) * 1000, 4], [(EPOCH + 89 * DAY + 1) * 1000, 5]])];
    mocks.fetch.mockImplementation(() => { times.push(Date.now()); return Promise.resolve(responses.shift()); });
    const signal = new AbortController().signal;
    expect(await finish(fetchCgPriceHistoryHourly("test-coin", {
      startSec: EPOCH - DAY, endSec: EPOCH + 89 * DAY + 1,
    }, "eur", "test-key", signal))).toEqual([
      { timestamp: EPOCH - 1, price: 1 }, { timestamp: EPOCH, price: 2 },
      { timestamp: EPOCH + 89 * DAY, price: 4 }, { timestamp: EPOCH + 89 * DAY + 1, price: 5 },
    ]);
    expect(mocks.fetch.mock.calls).toEqual([
      [EPOCH - DAY, EPOCH], [EPOCH, EPOCH + 89 * DAY], [EPOCH + 89 * DAY, EPOCH + 89 * DAY + 1],
    ].map(([from, to]) => [rangeUrl(from, to, "eur").replace("api.coingecko", "pro-api.coingecko"),
      { headers: { "User-Agent": USER_AGENT, "x-cg-pro-api-key": "test-key" }, signal }, 2, { timeoutMs: 30_000 }]));
    expect(times).toEqual([1, 2, 3].map((n) => NOW * 1000 + n * RATE_LIMITS.COINGECKO_BACKFILL_MS));
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it("keeps later chunks after transport and parse failures without daily fallback", async () => {
    const error = new Error("transport");
    mocks.fetch.mockRejectedValueOnce(error).mockResolvedValueOnce({ body: { prices: "invalid" } })
      .mockResolvedValueOnce(chart([[NOW * 1000, 0.9]]));
    expect(await finish(fetchCgPriceHistoryHourly("test-coin", { startSec: EPOCH, endSec: NOW })))
      .toEqual([{ timestamp: NOW, price: 0.9 }]);
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual([
      rangeUrl(EPOCH, EPOCH + 89 * DAY), rangeUrl(EPOCH + 89 * DAY, EPOCH + 178 * DAY),
      rangeUrl(EPOCH + 178 * DAY, NOW),
    ]);
    expect(mocks.log.mock.calls).toEqual([["api", "error",
      `[backfill-pricing] CG hourly chunk failed for test-coin/usd (${EPOCH}-${EPOCH + 89 * DAY}):`, error]]);
  });

  it("withholds a non-positive hourly range without querying CoinGecko", async () => {
    expect(await fetchCgPriceHistoryHourly("test-coin", { startSec: NOW, endSec: NOW })).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("keeps the hourly chunk pass after a failed pre-epoch phase-one request", async () => {
    const error = new Error("phase one unavailable");
    mocks.fetch.mockRejectedValueOnce(error).mockResolvedValueOnce(chart([[EPOCH * 1000, 2]]));
    expect(await finish(fetchCgPriceHistoryHourly("test-coin", {
      startSec: EPOCH - DAY, endSec: EPOCH + 1,
    }))).toEqual([{ timestamp: EPOCH, price: 2 }]);
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual([
      rangeUrl(EPOCH - DAY, EPOCH), rangeUrl(EPOCH, EPOCH + 1),
    ]);
    expect(mocks.log.mock.calls).toEqual([["api", "error",
      "[backfill-pricing] CG hourly phase-1 failed for test-coin:", error]]);
  });

  it("falls back to an unpaced daily request only when every hourly point is absent", async () => {
    const times: number[] = [];
    const responses = [null, chart([]), chart([[NOW * 1000, 1]])];
    mocks.fetch.mockImplementation(() => { times.push(Date.now()); return Promise.resolve(responses.shift()); });
    const end = EPOCH + 90 * DAY;
    expect(await finish(fetchCgPriceHistoryHourly("test-coin", { startSec: EPOCH, endSec: end })))
      .toEqual([{ timestamp: NOW, price: 1 }]);
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual([
      rangeUrl(EPOCH, EPOCH + 89 * DAY), rangeUrl(EPOCH + 89 * DAY, end), rangeUrl(EPOCH, end),
    ]);
    expect(times).toEqual([1, 2, 2].map((n) => NOW * 1000 + n * RATE_LIMITS.COINGECKO_BACKFILL_MS));
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it.each(["absent", "parse", "transport"])("retains the daily %s failure log distinction", async (kind) => {
    const error = new Error("transport");
    if (kind === "transport") mocks.fetch.mockRejectedValue(error);
    else mocks.fetch.mockResolvedValue(kind === "parse" ? { body: { prices: "invalid" } } : null);
    expect((await daily()).prices).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.log.mock.calls).toEqual(kind === "absent" ? [] : [["api", kind === "parse" ? "warn" : "error",
      kind === "parse" ? "[backfill-pricing] CG market chart validation failed:"
        : "[backfill-pricing] Failed to fetch CG daily price history for test-coin/eur:",
      kind === "parse" ? expect.any(String) : error]]);
  });

  it("reports DefiLlama fallback exhaustion after an empty CoinGecko series", async () => {
    const error = new Error("defillama unavailable");
    mocks.fetch.mockResolvedValueOnce(chart([])).mockRejectedValue(error);
    const result = await fetchMarketBackfillPriceSeries(
      { id: "test-coin", flags: { pegCurrency: "USD" } },
      "test-coin",
      { granularity: "daily" },
    );
    expect(result.prices).toBeNull();
    expect(result.diagnostics).toMatchObject({
      sourcesUsed: [],
      mergeReasons: ["coingecko-empty"],
      perSourceStats: [
        { source: "coingecko", points: 0 },
        { source: "defillama", points: 0 },
      ],
      finalPointCount: 0,
    });
    expect(mocks.log.mock.calls).toEqual([
      ["api", "error", "[backfill-pricing] DL fallback failed for coingecko:test-coin:", error],
      ["api", "error", "[backfill-pricing] DL fallback failed for coingecko:test-coin:", error],
    ]);
  });

  it("merges DefiLlama fallback history into an empty CoinGecko series", async () => {
    const dlPrices = [{ timestamp: NOW - DAY, price: 1.0001 }, { timestamp: NOW, price: 0.9999 }];
    mocks.fetch.mockResolvedValueOnce(chart([])).mockResolvedValue({
      response: { ok: true },
      body: { coins: { "coingecko:test-coin": { prices: dlPrices } } },
    });
    const result = await fetchMarketBackfillPriceSeries(
      { id: "test-coin", flags: { pegCurrency: "USD" } },
      "test-coin",
      { granularity: "daily" },
    );
    expect(result.prices).toEqual(dlPrices);
    expect(result.diagnostics).toMatchObject({
      sourcesUsed: ["defillama"],
      mergeReasons: ["coingecko-empty"],
      perSourceStats: [
        { source: "coingecko", points: 0 },
        { source: "defillama", points: 2, startTimestamp: NOW - DAY, endTimestamp: NOW },
      ],
      finalPointCount: 2,
    });
  });

  it.each(["sleep", "request"])("propagates cancellation during %s without logs or fallback", async (phase) => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    if (phase === "request") mocks.fetch.mockImplementation(() => { controller.abort(reason); throw reason; });
    const promise = fetchCgPriceHistoryHourly("test-coin", { startSec: EPOCH, endSec: EPOCH + DAY }, "usd", null, controller.signal);
    const assertion = expect(promise).rejects.toBe(reason);
    if (phase === "sleep") controller.abort(reason);
    await vi.runAllTimersAsync();
    await assertion;
    expect(mocks.fetch).toHaveBeenCalledTimes(phase === "sleep" ? 0 : 1);
    expect(mocks.log).not.toHaveBeenCalled();
  });
});

const jsonResult = (body: unknown) => ({ response: { ok: true }, body });
const makeMeta = (overrides: Partial<Parameters<typeof fetchMarketBackfillPriceSeries>[0]> = {}) =>
  ({ id: "eurc-circle", flags: { pegCurrency: "EUR" as const }, ...overrides });

describe("fetchMarketBackfillPriceSeries", () => {
  const fetchWithRetryMock = mocks.fetch;
  beforeEach(() => vi.useRealTimers());

  it("falls back from empty USD CoinGecko history to DefiLlama", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(jsonResult({ prices: [] }))
      .mockResolvedValueOnce(jsonResult({ coins: { "coingecko:tether": { prices: [
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
      .mockResolvedValueOnce(jsonResult({ prices: [[recent * 1000, 0.97], [old * 1000, 0.99]] }))
      .mockResolvedValueOnce(jsonResult({ coins: { "coingecko:tether": { prices: [
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
    fetchWithRetryMock.mockResolvedValue(jsonResult({ coins: {} }));
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

  it("applies the above-peg policy to merged DefiLlama history inside a bounded replay window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_534_000_001_000);
    fetchWithRetryMock.mockResolvedValue(jsonResult({ coins: { "coingecko:tether": { prices: [
      { timestamp: 1_531_517_487, price: 1.0732 },
      { timestamp: 1_533_999_999, price: 1.01 },
    ] } } }));
    const result = await fetchMarketBackfillPriceSeries(makeMeta({ id: "usdt-tether" }), "tether", {
      granularity: "daily", range: { startSec: 1_530_999_999, endSec: 1_534_000_001 },
      seedCoinGeckoPrices: [
        { timestamp: 1_531_000_000, price: 1.021 },
        { timestamp: 1_532_000_000, price: 1.002 },
      ],
    });
    expect(result.prices).toEqual([
      { timestamp: 1_532_000_000, price: 1.002 },
      { timestamp: 1_533_999_999, price: 1.01 },
    ]);
    expect(result.diagnostics.policyAdjustments).toEqual([
      { source: "coingecko", adjustment: "above-peg-clamp", removedPoints: 1 },
      { source: "defillama", adjustment: "above-peg-clamp", removedPoints: 1 },
    ]);
    expect(result.diagnostics.perSourceStats).toEqual([
      { source: "coingecko", points: 1, startTimestamp: 1_532_000_000, endTimestamp: 1_532_000_000 },
      { source: "defillama", points: 1, startTimestamp: 1_533_999_999, endTimestamp: 1_533_999_999 },
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
    fetchWithRetryMock.mockResolvedValueOnce(jsonResult({
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
    fetchWithRetryMock.mockResolvedValueOnce(jsonResult({ prices: [] }));

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
      .mockResolvedValueOnce(jsonResult({ prices: [] }))
      .mockResolvedValueOnce(jsonResult({
        prices: [
          [1_700_000_000_000, 1.004],
        ],
      }));

    const result = await fetchMarketBackfillPriceSeries(
      makeMeta({
        id: "axcnh-anchorx",
        flags: {
          pegCurrency: "CNH",
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
    fetchWithRetryMock.mockResolvedValueOnce(jsonResult({
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
