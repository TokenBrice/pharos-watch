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
