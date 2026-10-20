import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCgPriceHistoryHourly, fetchMarketBackfillPriceSeries } from "../historical-market-prices";
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
