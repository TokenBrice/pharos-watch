import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { makeNoopD1 } from "../../test-helpers/noop-d1";

const { sleepWithSignalMock } = vi.hoisted(() => ({
  sleepWithSignalMock: vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined),
}));

vi.mock("../abort", async () => {
  const actual = await vi.importActual<typeof import("../abort")>("../abort");
  return { ...actual, sleepWithSignal: sleepWithSignalMock };
});

import {
  BINANCE_KNOWN_SYMBOLS,
  BITSTAMP_KNOWN_SYMBOLS,
  COINBASE_KNOWN_SYMBOLS,
  KRAKEN_KNOWN_SYMBOLS,
  fetchBinancePricesDetailed,
  fetchBinancePricesForRun,
  createBinanceFetchSession,
  fetchBitstampPrices,
  fetchCoinbasePrices,
  fetchKrakenPrices,
} from "../cex-tickers";
import { ACTIVE_STABLECOINS, TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { KRAKEN_MARKETS } from "@shared/lib/pricing-provider-config";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { createDeferredPromise } from "./deferred.test-support";

beforeEach(() => sleepWithSignalMock.mockClear());
afterEach(() => vi.unstubAllGlobals());

describe("fetchBinancePricesDetailed", () => {
  it("returns stablecoin/USD prices from ticker endpoint", async () => {
    mockFetch([{
      match: () => true,
      body: [
            { symbol: "USDTUSD", price: "0.9999" },
            { symbol: "USDCUSD", price: "1.0001" },
            { symbol: "BTCUSD", price: "65000" },
      ],
    }]);
    const results = (await fetchBinancePricesDetailed()).value.prices;
    expect(results.get("USDT")).toBeCloseTo(0.9999, 4);
    expect(results.get("USDC")).toBeCloseTo(1.0001, 4);
    expect(results.has("BTC")).toBe(false);
  });

  it("ignores unconfigured Binance markets", async () => {
    mockFetch([{
      match: () => true,
      body: [
            { symbol: "USDTUSD", price: "0.9999" },
            { symbol: "USDCUSD", price: "1.0001" },
            { symbol: "BFUSDUSDT", price: "0.9995" },
            { symbol: "BFUSDUSDC", price: "0.9993" },
            { symbol: "BUSDUSD", price: "0.95" },
            { symbol: "BUSDUSDT", price: "0.95" },
      ],
    }]);

    const results = (await fetchBinancePricesDetailed()).value.prices;
    expect(results.has("BFUSD")).toBe(false);
    expect(results.has("BUSD")).toBe(false);
  });

  it("returns empty map on failure", async () => {
    const fetchMock = mockFetch([{ match: () => true, body: "upstream unavailable", status: 503 }]);
    const results = (await fetchBinancePricesDetailed()).value.prices;
    expect(results.size).toBe(0);
    // One fetch per host (2 hosts). 5xx short-circuits to the next host
    // instead of retrying the same host.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });


  it("reports Binance response and match counts for diagnostics", async () => {
    mockFetch([{
      match: () => true,
      body: [
            { symbol: "BTCUSD", price: "65000" },
            { symbol: "ETHUSDT", price: "3500" },
      ],
    }]);

    const outcome = await fetchBinancePricesDetailed();
    const { value: { prices, diagnostics } } = outcome;
    expect(outcome.kind).toBe("no-data");

    expect(prices.size).toBe(0);
    expect(diagnostics[0]).toMatchObject({
      source: "binance",
      stage: "primary",
      status: 200,
      ok: true,
      success: false,
      responseRowCount: 2,
      matchedCount: 0,
    });
  });

  it("falls back to the main Binance API host when data-api is blocked", async () => {
    mockFetch([{
      match: () => true,
      respond: (request) => request.url.includes("data-api.binance.vision")
        ? new Response("blocked", { status: 403 })
        : new Response(JSON.stringify([
          { symbol: "USDTUSD", price: "1.0002" },
          { symbol: "USDCUSD", price: "0.9999" },
        ]), { status: 200, headers: { "Content-Type": "application/json" } }),
    }]);

    const {
      value: { prices, diagnostics },
    } = await fetchBinancePricesDetailed();

    expect(prices.get("USDT")).toBeCloseTo(1.0002, 4);
    expect(prices.get("USDC")).toBeCloseTo(0.9999, 4);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({ status: 403, success: false });
    expect(diagnostics[1]).toMatchObject({
      endpoint: "api.binance.com/api/v3/ticker/price",
      status: 200,
      success: true,
      matchedCount: 2,
    });
  });

  it("returns blocked outcome when every Binance host returns 403/451", async () => {
    mockFetch([{ match: () => true, body: "blocked", status: 451 }]);
    const outcome = await fetchBinancePricesDetailed();
    expect(outcome.kind).toBe("blocked");
    expect(outcome.value.prices.size).toBe(0);
    expect(outcome.value.diagnostics.every((d) => d.status === 451)).toBe(true);
  });

  it("returns upstream-error outcome when every Binance host throws", async () => {
    mockFetch([{ match: () => true, outcomes: [new Error("network down")] }]);
    const outcome = await fetchBinancePricesDetailed();
    expect(outcome.kind).toBe("upstream-error");
  });

  it("returns ok outcome when any host returns tracked prices", async () => {
    mockFetch([{ match: () => true, body: [{ symbol: "USDTUSD", price: "1.0001" }] }]);
    const outcome = await fetchBinancePricesDetailed();
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.get("USDT")).toBeCloseTo(1.0001, 4);
  });


  it("jumps to the next host on 5xx without sleeping or retrying the same host", async () => {
    const fetchMock = mockFetch([{
      match: () => true,
      respond: (request) => request.url.includes("data-api.binance.vision")
        ? new Response("upstream down", { status: 503, headers: { "Retry-After": "30" } })
        : new Response(JSON.stringify([{ symbol: "USDTUSD", price: "1.0003" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    }]);

    const {
      value: { prices, diagnostics },
    } = await fetchBinancePricesDetailed();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("data-api.binance.vision");
    expect(fetchMock.mock.calls[1][0]).toContain("api.binance.com");
    expect(sleepWithSignalMock).not.toHaveBeenCalled();
    expect(prices.get("USDT")).toBeCloseTo(1.0003, 4);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({ status: 503, success: false });
    expect(diagnostics[1]).toMatchObject({ status: 200, success: true });
  });
});

describe("fetchBinancePricesForRun", () => {
  function makeAvailabilityDb(row: Record<string, unknown> | null) {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const first = vi.fn(async () => row);
    return {
      db: makeNoopD1({
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({ first, run })),
        })),
      }),
      run,
    };
  }

  it("reuses one Binance result across primary and confirmation consumers", async () => {
    const fetchMock = mockFetch([{
      match: () => true,
      body: [{ symbol: "USDTUSD", price: "1.0001" }],
    }]);
    const { db } = makeAvailabilityDb(null);
    const session = createBinanceFetchSession();

    const [primary, confirmation] = await Promise.all([
      fetchBinancePricesForRun(db, session, undefined, 1_000),
      fetchBinancePricesForRun(db, session, undefined, 1_000),
    ]);

    expect(primary).toBe(confirmation);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses a zero-request synthetic outcome during the environment block TTL", async () => {
    const fetchMock = mockFetch([], { requireMatch: true });
    const { db } = makeAvailabilityDb({
      availability: "blocked",
      blocked_status: 451,
      next_probe_at: 2_000,
    });

    const outcome = await fetchBinancePricesForRun(db, createBinanceFetchSession(), undefined, 1_000);
    expect(outcome.kind).toBe("blocked");
    expect(outcome.value.diagnostics[0]).toMatchObject({
      endpoint: "binance:environment-ttl",
      status: 451,
      errorClass: "environment-blocked",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("limits an expired environment block to one probe host", async () => {
    const fetchMock = mockFetch([{ match: () => true, body: "blocked", status: 451 }]);
    const { db, run } = makeAvailabilityDb({
      availability: "blocked",
      blocked_status: 451,
      next_probe_at: 1_000,
    });

    const outcome = await fetchBinancePricesForRun(db, createBinanceFetchSession(), undefined, 1_000);
    expect(outcome.kind).toBe("blocked");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("fetchCoinbasePrices", () => {
  const tradeTime = "2026-11-01T17:11:27.444Z";
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(tradeTime) + 1_000);
  });
  afterEach(() => vi.useRealTimers());

  it("returns ok outcome with prices for listed stablecoin products", async () => {
    mockFetch([
      { match: "/products/USDT-USD/ticker", body: { price: "0.9998", time: tradeTime } },
      { match: "/products/USDS-USD/ticker", body: { price: "1.0000", time: tradeTime } },
      { match: () => true, body: {}, status: 404 },
    ], { requireMatch: true });
    const outcome = await fetchCoinbasePrices(["USDT", "USDS", "XYZFAKE"]);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.get("USDT")).toBeCloseTo(0.9998, 4);
    expect(outcome.value.prices.get("USDS")).toBeCloseTo(1.0, 4);
    expect(outcome.value.prices.has("XYZFAKE")).toBe(false);
  });

  it("does not price Berachain Bera USD from Coinbase's unrelated Hivemapper or Binance USD symbols", async () => {
    const fetchMock = mockFetch([{
      match: () => true,
      body: { price: "0.01" },
    }]);

    const outcome = await fetchCoinbasePrices(["HONEY", "BUSD"]);

    expect(outcome.kind).toBe("no-data");
    expect([...outcome.value.prices.entries()]).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exposes per-pair upstream observed-at derived from Coinbase `time` ISO string", async () => {
    mockFetch([
      {
        match: "/products/USDT-USD/ticker",
        body: {
          bid: "0.9997",
          ask: "0.9999",
          price: "0.9998",
          time: tradeTime,
        },
      },
      { match: () => true, body: {}, status: 404 },
    ], { requireMatch: true });
    const outcome = await fetchCoinbasePrices(["USDT"]);
    expect(outcome.kind).toBe("ok");
    const expectedSec = Math.floor(Date.parse(tradeTime) / 1000);
    expect(outcome.value.observedAtBySymbol.get("USDT")).toBe(expectedSec);
    expect(outcome.value.clockBySymbol.get("USDT")).toBe("trade");
  });
  it.each([
    ["AUDD", "0.7075", "0.7036", "0.7036", "2026-09-26T22:28:40.333586513Z", 0.70555],
    ["XSGD", "0.7831", "0.7821", "0.783", "2026-10-30T21:18:48.841299403Z", 0.7826],
    ["EURC", "1.0944", "1.0942", "1.0945", "2026-11-23T12:59:08.922863079Z", 1.0943],
    ["TGBP", "1.3083", "1.308", "1.3078", "2026-11-23T12:59:03.987405502Z", 1.30815],
  ] as const)("prices the %s-USDC FX-stablecoin product from its bid/ask midpoint", async (symbol, ask, bid, price, time, expected) => {
    const bookAt = Date.parse(time) + 600_000;
    vi.setSystemTime(bookAt + 1_000);
    const fetchSpy = mockFetch([
      { match: `/products/${symbol}-USDC/book`, body: { asks: [[ask, "100", 1]], bids: [[bid, "100", 1]], time: new Date(bookAt).toISOString() } },
      { match: `/products/${symbol}-USDC/ticker`, body: { ask, bid, price, time } },
      { match: () => true, body: {}, status: 404 },
    ], { requireMatch: true });
    const outcome = await fetchCoinbasePrices([symbol]);
    expect(COINBASE_KNOWN_SYMBOLS).toContain(symbol);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.get(symbol)).toBeCloseTo(expected, 6);
    expect(outcome.value.observedAtBySymbol.get(symbol)).toBe(Math.floor(bookAt / 1000));
    expect(outcome.value.quoteAssetBySymbol.get(symbol)).toBe("USDC");
    expect(outcome.value.clockBySymbol.get(symbol)).toBe("book");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("admits AUDD-USDC /book?level=1 with 1s forward skew, rejects >5s skew with diagnostic, and keeps wide-book refusal", async () => {
    const nowSec = Math.floor(Date.parse("2026-11-22T12:01:31Z") / 1000);
    vi.setSystemTime(nowSec * 1_000);
    const staleTrade = new Date((nowSec - 7_200) * 1_000).toISOString();
    const skewedFetch = mockFetch([
      { match: "/products/AUDD-USDC/book", body: { bids: [["0.6582", "100", 1]], asks: [["0.6606", "100", 1]], time: new Date((nowSec + 1) * 1_000 + 200).toISOString() } },
      { match: "/products/AUDD-USDC/ticker", body: { price: "0.6584", time: staleTrade } },
    ], { requireMatch: true });
    const admitted = await fetchCoinbasePrices(["AUDD"]);
    expect(admitted.kind).toBe("ok");
    expect(admitted.value.prices.get("AUDD")).toBeCloseTo(0.6594, 6);
    expect(admitted.value.clockBySymbol.get("AUDD")).toBe("book");
    expect(admitted.value.observedAtBySymbol.get("AUDD")).toBe(nowSec + 1);
    expect(skewedFetch).toHaveBeenCalledOnce();

    mockFetch([
      { match: "/products/AUDD-USDC/book", body: { bids: [["0.6582", "100", 1]], asks: [["0.6606", "100", 1]], time: new Date((nowSec + 6) * 1_000).toISOString() } },
      { match: "/products/AUDD-USDC/ticker", body: { price: "0.6584", time: staleTrade } },
    ], { requireMatch: true });
    const rejected = await fetchCoinbasePrices(["AUDD"]);
    expect(rejected.kind).toBe("no-data");
    expect(rejected.value.diagnostics).toContainEqual(expect.objectContaining({
      source: "coinbase",
      endpoint: "api.exchange.coinbase.com/products/AUDD-USDC/book",
      ok: true,
      success: false,
      errorClass: "future_observed_at",
    }));

    const wideFetch = mockFetch([
      { match: "/products/AUDD-USDC/book", body: { bids: [["0.6400", "100", 1]], asks: [["0.6800", "100", 1]], time: new Date((nowSec + 1) * 1_000).toISOString() } },
      { match: "/products/AUDD-USDC/ticker", body: { price: "0.6584", time: new Date(nowSec * 1_000).toISOString() } },
    ], { requireMatch: true });
    const wide = await fetchCoinbasePrices(["AUDD"]);
    expect(wide.kind).toBe("no-data");
    expect(wideFetch).toHaveBeenCalledOnce();
  });

  it.each([null, tradeTime])("does not date an eligible midpoint with the trade clock when book time is %s", async (time) => {
    vi.setSystemTime(Date.parse(tradeTime) + 601_000);
    mockFetch([
      { match: "/book", body: { bids: [["0.9997", "100", 1]], asks: [["0.9999", "100", 1]], time } },
      { match: "/ticker", body: { bid: "0.9997", ask: "0.9999", price: "0.9998", time: tradeTime } },
    ]);
    expect((await fetchCoinbasePrices(["USDT"])).kind).toBe("no-data");
  });

  it("rejects a wide product book without falling back to its last trade", async () => {
    mockFetch([
      {
        match: "/products/USDT-USD/ticker",
        body: {
          bid: "0.9600",
          ask: "1.0400",
          price: "0.9998",
          time: "2026-11-01T17:11:27.444478317Z",
        },
      },
      { match: () => true, body: {}, status: 404 },
    ], { requireMatch: true });

    const outcome = await fetchCoinbasePrices(["USDT"]);

    expect(outcome.kind).toBe("no-data");
    expect(outcome.value.prices.has("USDT")).toBe(false);
    expect(outcome.value.diagnostics).toEqual([
      {
        source: "coinbase",
        stage: "primary",
        endpoint: "api.exchange.coinbase.com/products/USDT-USD/book",
        status: 404,
        ok: false,
        success: false,
        candidateCount: 1,
        resolvedCount: 0,
        rejectionReasonCounts: { "non-ok": 1 },
        errorClass: "http_error",
      },
      {
        source: "coinbase",
        stage: "primary",
        endpoint: "api.exchange.coinbase.com/products/{product}/ticker",
        status: null,
        ok: true,
        success: false,
        rejectionReasonCounts: { "wide-spread": 1 },
      },
    ]);
  });


  it("returns upstream-error outcome when every product request throws", async () => {
    mockFetch([{ match: () => true, outcomes: [new Error("network down")] }]);
    const outcome = await fetchCoinbasePrices(["USDT"]);
    expect(outcome.kind).toBe("upstream-error");
    expect(outcome.value.prices.size).toBe(0);
  });

  it("returns ok outcome when some products fail and others succeed", async () => {
    mockFetch([
      { match: "/products/USDT-USD/ticker", body: { price: "0.9998", time: tradeTime } },
      { match: () => true, outcomes: [new Error("network down")] },
    ], { requireMatch: true });
    const outcome = await fetchCoinbasePrices(["USDT", "DAI"]);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.get("USDT")).toBeCloseTo(0.9998, 4);
    expect(outcome.value.prices.has("DAI")).toBe(false);
  });

  it("records every failed Coinbase product in diagnostics for a partial fan-out", async () => {
    mockFetch([
      { match: "/products/USDT-USD/ticker", body: { price: "0.9998", time: tradeTime } },
      { match: "/products/PAXG-USD/ticker", body: {}, status: 404 },
      { match: "/products/AUDD-USDC/ticker", body: {}, status: 404 },
      { match: "/book", body: {}, status: 404 },
    ], { requireMatch: true });
    const outcome = await fetchCoinbasePrices(["USDT", "PAXG", "AUDD"]);

    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.get("USDT")).toBeCloseTo(0.9998, 4);
    expect(outcome.value.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "coinbase",
        endpoint: "api.exchange.coinbase.com/products/AUDD-USDC/book",
        status: 404,
        ok: false,
        success: false,
        errorClass: "http_error",
      }),
      {
        source: "coinbase",
        stage: "primary",
        endpoint: "api.exchange.coinbase.com/products/{product}/ticker",
        status: 404,
        ok: false,
        success: false,
      },
    ]));
    expect(outcome.value.diagnostics.filter((d) => d.endpoint.endsWith("/ticker"))).toHaveLength(2);
    expect(outcome.value.diagnostics.filter((d) => d.endpoint.endsWith("/book"))).toHaveLength(3);
  });

  it.each([
    ["trailing non-numeric text", "0.9997 USD", "0.9999 USD", "0.9998 USD"],
    ["non-decimal JavaScript numeric literals", "0x10", "0b10", "0o10"],
    ["leading signs", "+1", "-1", "+1"],
  ])("rejects ticker prices containing %s", async (_case, bid, ask, price) => {
    mockFetch([
      { match: "/products/USDT-USD/ticker", body: { bid, ask, price } },
      { match: () => true, body: {}, status: 404 },
    ], { requireMatch: true });
    const outcome = await fetchCoinbasePrices(["USDT"]);
    expect(outcome.kind).toBe("no-data");
    expect(outcome.value.prices.has("USDT")).toBe(false);
  });

  it("keeps Coinbase product fetches serial inside the primary-provider budget", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const gate = createDeferredPromise();
    const started = createDeferredPromise();
    const fetchMock = mockFetch([{
      match: () => true,
      respond: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      started.resolve();
      await gate.promise;
      inFlight--;
      return new Response(JSON.stringify({ bids: [["1.0000", "100", 1]], asks: [["1.0000", "100", 1]], time: tradeTime }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      },
    }]);

    const run = fetchCoinbasePrices(["USDT", "PAXG", "USDS", "USD1", "AUDD"]);
    await started.promise;
    const initialInFlight = inFlight;
    gate.resolve();
    const outcome = await run;
    expect(initialInFlight).toBe(1);

    expect(outcome.kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(maxInFlight).toBe(1);
    expect(sleepWithSignalMock).toHaveBeenCalledTimes(4);
    expect(sleepWithSignalMock.mock.calls.every(([ms]) => ms === 1_000)).toBe(true);
  });

  it("retries /book once after Retry-After/cooldown on 429 and recovers book-clocked quote without hitting /ticker", async () => {
    const fetchMock = mockFetch([
      {
        match: "/products/USDT-USD/book",
        body: { bids: [["0.9999", "100", 1]], asks: [["1.0001", "100", 1]], time: tradeTime },
      },
      {
        match: "/products/AUDD-USDC/book",
        outcomes: [
          { body: { message: "Public rate limit exceeded" }, status: 429, headers: { "Retry-After": "3" } },
          { body: { message: "Public rate limit exceeded" }, status: 429, headers: { "Retry-After": "4" } },
          { body: { bids: [["0.6600", "100", 1]], asks: [["0.6604", "100", 1]], time: tradeTime }, status: 200 },
        ],
      },
      {
        match: "/products/XSGD-USDC/book",
        body: { bids: [["0.7820", "100", 1]], asks: [["0.7824", "100", 1]], time: tradeTime },
      },
    ], { requireMatch: true });

    const outcome = await fetchCoinbasePrices(["USDT", "AUDD", "XSGD"]);
    expect(outcome.kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(outcome.value.prices.get("USDT")).toBeCloseTo(1, 6);
    expect(outcome.value.prices.get("AUDD")).toBeCloseTo(0.6602, 6);
    expect(outcome.value.prices.get("XSGD")).toBeCloseTo(0.7822, 6);
    expect(outcome.value.clockBySymbol.get("AUDD")).toBe("book");
    expect(outcome.value.diagnostics).toEqual([]);
    // USDT->AUDD spacing (1000), AUDD /book retry #1 (Retry-After: 3 -> 3000),
    // AUDD /book post-cooldown retry #2 (Retry-After: 4 -> 4000), AUDD->XSGD spacing (1000).
    expect(sleepWithSignalMock.mock.calls.map(([ms]) => ms)).toEqual([1000, 3000, 4000, 1000]);
  });

  it("skips /ticker fallback after repeated /book 429s, cools down before the next product, and returns upstream-error when all products 429", async () => {
    const partialFetch = mockFetch([
      {
        match: "/products/AUDD-USDC/book",
        outcomes: [
          { body: { message: "Public rate limit exceeded" }, status: 429 },
          { body: { message: "Public rate limit exceeded" }, status: 429 },
          { body: { message: "Public rate limit exceeded" }, status: 429 },
        ],
      },
      {
        match: "/products/XSGD-USDC/book",
        body: { bids: [["0.7820", "100", 1]], asks: [["0.7824", "100", 1]], time: tradeTime },
      },
    ], { requireMatch: true });

    const partial = await fetchCoinbasePrices(["AUDD", "XSGD"]);
    expect(partial.kind).toBe("ok");
    expect(partialFetch).toHaveBeenCalledTimes(4);
    expect(partial.value.prices.has("AUDD")).toBe(false);
    expect(partial.value.prices.get("XSGD")).toBeCloseTo(0.7822, 6);
    expect(partial.value.diagnostics).toEqual([
      expect.objectContaining({
        source: "coinbase",
        endpoint: "api.exchange.coinbase.com/products/AUDD-USDC/book",
        status: 429,
        ok: false,
        success: false,
        errorClass: "http_error",
      }),
    ]);
    // AUDD /book retry #1 (5000 fallback), post-429 cooldown before retry #2 (3000),
    // post-429 cooldown before XSGD (3000). No /ticker request fired.
    expect(sleepWithSignalMock.mock.calls.map(([ms]) => ms)).toEqual([5000, 3000, 3000]);

    sleepWithSignalMock.mockClear();
    const allFailedFetch = mockFetch([
      {
        match: "/products/AUDD-USDC/book",
        outcomes: [
          { body: { message: "Public rate limit exceeded" }, status: 429, headers: { "Retry-After": "4" } },
          { body: { message: "Public rate limit exceeded" }, status: 429, headers: { "Retry-After": "4" } },
          { body: { message: "Public rate limit exceeded" }, status: 429, headers: { "Retry-After": "6" } },
        ],
      },
    ], { requireMatch: true });

    const allFailed = await fetchCoinbasePrices(["AUDD"]);
    expect(allFailed.kind).toBe("upstream-error");
    expect(allFailedFetch).toHaveBeenCalledTimes(3);
    expect(allFailed.value.diagnostics).toEqual([
      expect.objectContaining({
        source: "coinbase",
        endpoint: "api.exchange.coinbase.com/products/AUDD-USDC/book",
        status: 429,
        retryAfterSec: 6,
        ok: false,
        success: false,
        errorClass: "http_error",
      }),
    ]);
    expect(sleepWithSignalMock.mock.calls.map(([ms]) => ms)).toEqual([4000, 4000]);
  });

  it("still falls back to /ticker when the post-429 /book retry returns a non-429 error", async () => {
    const fetchMock = mockFetch([
      {
        match: "/products/AUDD-USDC/book",
        outcomes: [
          { body: { message: "rate limited" }, status: 429 },
          { body: { message: "rate limited" }, status: 429 },
          { body: {}, status: 404 },
        ],
      },
      {
        match: "/products/AUDD-USDC/ticker",
        body: { bid: "0.6600", ask: "0.6604", price: "0.6602", time: tradeTime },
      },
    ], { requireMatch: true });

    const outcome = await fetchCoinbasePrices(["AUDD"]);
    expect(outcome.kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(outcome.value.prices.get("AUDD")).toBeCloseTo(0.6602, 6);
    expect(outcome.value.clockBySymbol.get("AUDD")).toBe("trade");
    // /book retry #1 (5000), post-429 cooldown before /book retry #2 (3000),
    // normal pacing before /ticker fallback after 404 (1000).
    expect(sleepWithSignalMock.mock.calls.map(([ms]) => ms)).toEqual([5000, 3000, 1000]);
  });

});

describe("fetchKrakenPrices", () => {
  const depthPairs = ["AUDX", "BRL1", "EURC", "EURCV", "EUROP", "MXNB", "OUSD", "PAXG", "QCAD", "TGBP", "XAUT", "ZCHF"] as const;

  it("reads the twelve clocked Kraken markets from /0/public/Depth?count=1 using the older top-of-book timestamp and keeps other markets on batched /0/public/Ticker", async () => {
    const nowSec = 1_800_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(nowSec * 1_000);
    try {
      const requestedUrls: string[] = [];
      mockFetch([{
        match: (request) => {
          requestedUrls.push(request.url);
          return true;
        },
        respond: (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/0/public/Ticker") {
            return Response.json({
              error: [],
              result: {
                USDTZUSD: { c: ["1.0002"] },
                USDCUSD: { c: ["0.9998"] },
                USDDUSD: { a: ["1.0000"], b: ["0.9960"], c: ["0.9960"] },
                DAIUSD: { c: ["1.0000"] },
                // Must be ignored by Ticker even if returned, because EURC is depth-owned.
                EURCUSD: { a: ["1.1000"], b: ["1.1000"], c: ["1.1000"] },
                BTCUSD: { c: ["65000"] },
              },
            });
          }
          const pair = url.searchParams.get("pair")!;
          expect(url.pathname).toBe("/0/public/Depth");
          expect(url.searchParams.get("count")).toBe("1");
          if (pair === "MXNBUSD") {
            // Live-style stale bid (764s old) beside fresh ask (71s old): must reject as stale, never re-clock.
            return Response.json({
              error: [],
              result: { MXNBUSD: { bids: [["0.05224", "573269", nowSec - 764]], asks: [["0.05230", "62972", nowSec - 71]] } },
            });
          }
          if (pair === "TGBPUSD") {
            // Ask timestamp is older than bid timestamp; older timestamp governs observedAt.
            return Response.json({
              error: [],
              result: { TGBPUSD: { bids: [["1.3018", "350", nowSec - 5]], asks: [["1.3022", "768", nowSec - 45]] } },
            });
          }
          if (pair === "EURCUSD") {
            // 2s forward skew within CEX_UPSTREAM_MAX_FUTURE_SKEW_SEC (5s) is admitted without mutating clock.
            return Response.json({
              error: [],
              result: { EURCUSD: { bids: [["1.0900", "100", nowSec + 2]], asks: [["1.0902", "100", nowSec + 3]] } },
            });
          }
          return Response.json({
            error: [],
            result: { [pair]: { bids: [["1.0000", "100", nowSec - 20]], asks: [["1.0002", "100", nowSec - 10]] } },
          });
        },
      }], { requireMatch: true });

      const outcome = await fetchKrakenPrices([...depthPairs, "USDT", "USDC", "USDD", "DAI"]);
      expect(outcome.kind).toBe("ok");
      expect(requestedUrls).toEqual([
        "https://api.kraken.com/0/public/Ticker?pair=DAIUSD,USDCUSD,USDDUSD,USDTUSD",
        ...depthPairs.map((symbol) => `https://api.kraken.com/0/public/Depth?pair=${symbol}USD&count=1`),
      ]);
      // 11 inter-request pacing sleeps across 12 serial Depth calls.
      expect(sleepWithSignalMock).toHaveBeenCalledTimes(11);
      expect(sleepWithSignalMock.mock.calls.every(([ms]) => ms === 250)).toBe(true);

      // Batched Ticker markets remain undated / local_fetch.
      expect(outcome.value.prices.get("USDT")).toBeCloseTo(1.0002, 4);
      expect(outcome.value.prices.get("USDC")).toBeCloseTo(0.9998, 4);
      expect(outcome.value.prices.get("USDD")).toBeCloseTo(0.998, 4);
      expect(outcome.value.prices.get("DAI")).toBeCloseTo(1.0, 4);
      expect(outcome.value.quoteBasisBySymbol?.get("USDC")).toBe("last-trade");
      expect(outcome.value.quoteBasisBySymbol?.get("USDD")).toBe("bid-ask-midpoint");
      expect(outcome.value.observedAtBySymbol.has("USDC")).toBe(false);
      expect(outcome.value.observedAtBySymbol.has("USDD")).toBe(false);
      expect(outcome.value.prices.has("BTC")).toBe(false);

      // Clocked Depth markets carry upstream older-of-(bid, ask) timestamps.
      expect(outcome.value.prices.get("TGBP")).toBeCloseTo(1.302, 6);
      expect(outcome.value.observedAtBySymbol.get("TGBP")).toBe(nowSec - 45);
      expect(outcome.value.quoteBasisBySymbol?.get("TGBP")).toBe("bid-ask-midpoint");
      expect(outcome.value.prices.get("EURC")).toBeCloseTo(1.0901, 6);
      expect(outcome.value.observedAtBySymbol.get("EURC")).toBe(nowSec + 2);
      expect(outcome.value.observedAtBySymbol.get("EURCV")).toBe(nowSec - 20);
      expect(outcome.value.observedAtBySymbol.get("OUSD")).toBe(nowSec - 20);
      // Stale MXNB book stays withheld and is never re-clocked to fetch time.
      expect(outcome.value.prices.has("MXNB")).toBe(false);
      expect(outcome.value.observedAtBySymbol.has("MXNB")).toBe(false);
      expect(outcome.value.diagnostics).toContainEqual({
        source: "kraken",
        stage: "primary",
        endpoint: "api.kraken.com/0/public/Depth",
        status: 200,
        ok: true,
        success: true,
        candidateCount: 12,
        resolvedCount: 11,
        rejectionReasonCounts: { stale: 1 },
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("enforces spread, crossed-book, skew, shape, and freshness guards on Kraken Depth without falling back to Ticker", async () => {
    const nowSec = 1_800_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(nowSec * 1_000);
    try {
      const fetchSpy = mockFetch([{
        match: "/0/public/Depth",
        respond: (request) => {
          const pair = new URL(request.url).searchParams.get("pair")!;
          const payloads: Record<string, unknown> = {
            // Wide spread (> 100 bps)
            AUDXUSD: { error: [], result: { AUDXUSD: { bids: [["0.6500", "10", nowSec - 10]], asks: [["0.6700", "10", nowSec - 10]] } } },
            // Crossed book (ask < bid)
            BRL1USD: { error: [], result: { BRL1USD: { bids: [["0.1700", "10", nowSec - 10]], asks: [["0.1690", "10", nowSec - 10]] } } },
            // Future skew > 5s on ask even though bid is current
            EURCUSD: { error: [], result: { EURCUSD: { bids: [["1.0900", "10", nowSec - 5]], asks: [["1.0902", "10", nowSec + 6]] } } },
            // Stale older level (> 600s)
            EUROPUSD: { error: [], result: { EUROPUSD: { bids: [["1.0900", "10", nowSec - 601]], asks: [["1.0902", "10", nowSec - 5]] } } },
            // Missing ask side
            MXNBUSD: { error: [], result: { MXNBUSD: { bids: [["0.0520", "10", nowSec - 5]], asks: [] } } },
            // Non-integer timestamp
            PAXGUSD: { error: [], result: { PAXGUSD: { bids: [["3600", "1", nowSec - 5]], asks: [["3601", "1", "bad-ts"]] } } },
            // Wrong pair response key
            QCADUSD: { error: [], result: { WRONGKEY: { bids: [["0.7000", "10", nowSec - 5]], asks: [["0.7002", "10", nowSec - 5]] } } },
          };
          return Response.json(payloads[pair]);
        },
      }], { requireMatch: true });

      const outcome = await fetchKrakenPrices(["AUDX", "BRL1", "EURC", "EUROP", "MXNB", "PAXG", "QCAD"]);
      expect(outcome.kind).toBe("no-data");
      expect(outcome.value.prices.size).toBe(0);
      expect(outcome.value.observedAtBySymbol.size).toBe(0);
      expect(fetchSpy).toHaveBeenCalledTimes(7);
      expect(outcome.value.diagnostics).toEqual([{
        source: "kraken",
        stage: "primary",
        endpoint: "api.kraken.com/0/public/Depth",
        status: 200,
        ok: true,
        success: false,
        candidateCount: 7,
        resolvedCount: 0,
        rejectionReasonCounts: {
          "wide-spread": 2,
          "invalid-shape": 2,
          stale: 1,
          "missing-quote": 2,
        },
      }]);
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps healthy Kraken Depth quotes when one pair returns an API error and fails upstream-error when all fail", async () => {
    const nowSec = 1_800_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(nowSec * 1_000);
    try {
      mockFetch([{
        match: "/0/public/Depth",
        respond: (request) => {
          const pair = new URL(request.url).searchParams.get("pair")!;
          if (pair === "AUDXUSD") return Response.json({ error: ["EGeneral:Temporary lockout"], result: {} });
          return Response.json({
            error: [],
            result: { QCADUSD: { bids: [["0.6960", "10", nowSec - 30]], asks: [["0.6964", "10", nowSec - 20]] } },
          });
        },
      }], { requireMatch: true });

      const partial = await fetchKrakenPrices(["AUDX", "QCAD"]);
      expect(partial.kind).toBe("ok");
      expect(partial.value.prices.has("AUDX")).toBe(false);
      expect(partial.value.prices.get("QCAD")).toBeCloseTo(0.6962, 6);
      expect(partial.value.observedAtBySymbol.get("QCAD")).toBe(nowSec - 30);
      expect(partial.value.diagnostics).toEqual([{
        source: "kraken",
        stage: "primary",
        endpoint: "api.kraken.com/0/public/Depth",
        status: 200,
        ok: false,
        success: true,
        candidateCount: 2,
        resolvedCount: 1,
        rejectionReasonCounts: { "upstream-error": 1 },
        errorClass: "api_error",
      }]);

      mockFetch([{
        match: "/0/public/Depth",
        body: { error: ["EGeneral:Temporary lockout"], result: {} },
      }], { requireMatch: true });
      const allFailed = await fetchKrakenPrices(["AUDX"]);
      expect(allFailed.kind).toBe("upstream-error");
      expect(allFailed).toMatchObject({ reason: "EGeneral:Temporary lockout" });
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects a wide two-sided book without falling back to its last trade", async () => {
    mockFetch([{
      match: () => true,
      body: {
        error: [],
        result: {
          // Production 2026-11-01: USD1's thin Kraken book quoted a ~4.5% spread.
          USD1USD: { a: ["0.99950000"], b: ["0.95600000"], c: ["0.99950000"] },
          USDCUSD: { a: ["0.99970000"], b: ["0.99960000"], c: ["0.99970000"] },
        },
      },
    }]);

    const outcome = await fetchKrakenPrices(["USD1", "USDC"]);

    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.has("USD1")).toBe(false);
    expect(outcome.value.prices.get("USDC")).toBeCloseTo(0.99965, 8);
    expect(outcome.value.diagnostics).toEqual([
      {
        source: "kraken",
        stage: "primary",
        endpoint: "api.kraken.com/0/public/Ticker",
        status: 200,
        ok: true,
        success: true,
        rejectionReasonCounts: { "wide-spread": 1 },
      },
    ]);
  });

  it("rejects a crossed book (ask below bid) like a wide one", async () => {
    mockFetch([{
      match: () => true,
      body: { error: [], result: { USDCUSD: { a: ["0.99000000"], b: ["1.01000000"], c: ["1.00000000"] } } },
    }]);

    const outcome = await fetchKrakenPrices(["USDC"]);

    expect(outcome.value.prices.has("USDC")).toBe(false);
    expect(outcome.value.diagnostics[0]?.rejectionReasonCounts).toEqual({ "wide-spread": 1 });
  });

  it("keeps the last-trade fallback when only one book side is present", async () => {
    mockFetch([{
      match: () => true,
      body: {
        error: [],
        result: {
          USDCUSD: { a: ["1.00010000"], c: ["0.99990000"] },
          USDTUSD: { b: ["0.99970000"], c: ["0.99980000"] },
        },
      },
    }]);

    const outcome = await fetchKrakenPrices(["USDC", "USDT"]);

    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.get("USDC")).toBeCloseTo(0.9999, 8);
    expect(outcome.value.prices.get("USDT")).toBeCloseTo(0.9998, 8);
    expect(outcome.value.diagnostics).toEqual([]);
  });

  it("requests the 2026-10-30 reviewed Kraken books on Ticker (USD) and Depth (clocked FX)", async () => {
    const nowSec = 1_800_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(nowSec * 1_000);
    try {
      const requestedUrls: string[] = [];
      mockFetch([{
        match: (request) => { requestedUrls.push(request.url); return true; },
        respond: (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/0/public/Ticker") {
            return Response.json({
              error: [],
              result: {
                CASHUSD: { a: ["1.00000000", "101"], b: ["0.99970000", "101"], c: ["1.00070000", "1900.92179"] },
                USDGOUSD: { a: ["1.00001000", "41158"], b: ["0.99993000", "15239"], c: ["0.99993000", "344.90729"] },
                USDPTUSD: { a: ["1.00044000", "100000"], b: ["0.99955000", "100000"], c: ["1.00044000", "247.41593"] },
                USDSMUSD: { a: ["1.00050000", "24985"], b: ["0.99950000", "23177"], c: ["0.99950000", "6.03650"] },
                USDSUIUSD: { a: ["1.00039000", "9974"], b: ["1.00020000", "12813"], c: ["1.00014000", "9973.75794"] },
              },
            });
          }
          const pair = url.searchParams.get("pair")!;
          const depthByPair: Record<string, { bids: [string, string, number][]; asks: [string, string, number][] }> = {
            AUDXUSD: { asks: [["0.70372000", "107413", nowSec - 15]], bids: [["0.70318000", "15000", nowSec - 25]] },
            BRL1USD: { asks: [["0.18285000", "8656", nowSec - 20]], bids: [["0.18241000", "2787", nowSec - 10]] },
            EUROPUSD: { asks: [["1.11580000", "13974", nowSec - 30]], bids: [["1.11450000", "1000", nowSec - 30]] },
            QCADUSD: { asks: [["0.71510000", "69954", nowSec - 40]], bids: [["0.71440000", "69964", nowSec - 50]] },
            ZCHFUSD: { asks: [["1.21152000", "4116", nowSec - 5]], bids: [["1.20987000", "417", nowSec - 60]] },
          };
          return Response.json({ error: [], result: { [pair]: depthByPair[pair] } });
        },
      }], { requireMatch: true });

      const symbols = ["CASH", "USDGO", "ZCHF", "USDSM", "USDSUI", "USDPT", "EUROP", "QCAD", "AUDX", "BRL1"];
      const outcome = await fetchKrakenPrices(symbols);
      for (const symbol of symbols) expect(KRAKEN_KNOWN_SYMBOLS).toContain(symbol);
      expect(requestedUrls).toEqual([
        "https://api.kraken.com/0/public/Ticker?pair=CASHUSD,USDGOUSD,USDPTUSD,USDSMUSD,USDSUIUSD",
        ...["AUDX", "BRL1", "EUROP", "QCAD", "ZCHF"].map((s) => `https://api.kraken.com/0/public/Depth?pair=${s}USD&count=1`),
      ]);
      expect(outcome.kind).toBe("ok");
      for (const [s, p, ts] of [
        ["CASH", 0.99985, undefined], ["USDGO", 0.99997, undefined], ["USDPT", 0.999995, undefined],
        ["USDSM", 1.0, undefined], ["USDSUI", 1.000295, undefined],
        ["AUDX", 0.70345, nowSec - 25], ["BRL1", 0.18263, nowSec - 20], ["EUROP", 1.11515, nowSec - 30],
        ["QCAD", 0.71475, nowSec - 50], ["ZCHF", 1.210695, nowSec - 60],
      ] as const) {
        expect(outcome.value.prices.get(s)).toBeCloseTo(p, 8);
        expect(outcome.value.observedAtBySymbol.get(s)).toBe(ts);
      }
      expect(outcome.value.prices.size).toBe(10);
    } finally {
      clock.mockRestore();
    }
  });

  it("returns upstream-error outcome when Kraken returns an API error", async () => {
    mockFetch([{ match: () => true, body: { error: ["EGeneral:Temporary lockout"], result: {} } }]);

    const outcome = await fetchKrakenPrices(["USDT"]);
    expect(outcome.kind).toBe("upstream-error");
    expect(outcome.value.prices.size).toBe(0);
    expect(outcome).toMatchObject({ reason: "EGeneral:Temporary lockout" });
  });


  it("returns upstream-error when the fetch throws", async () => {
    mockFetch([{ match: () => true, outcomes: [new Error("network down")] }]);
    const outcome = await fetchKrakenPrices(["USDT"]);
    expect(outcome.kind).toBe("upstream-error");
  });
});

describe("fetchBitstampPrices", () => {
  it("returns ok outcome parsing tracked stablecoin/USD pairs", async () => {
    mockFetch([{
      match: () => true,
      body: [
            { pair: "USDT/USD", market: "USDT/USD", last: "1.0001" },
            { pair: "USDC/USD", market: "USDC/USD", last: "0.9999" },
            { pair: "BTC/USD", market: "BTC/USD", last: "65000" },
            { pair: "DAI/USD", market: "DAI/USD", last: "1" },
      ],
    }]);

    const outcome = await fetchBitstampPrices();
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.get("USDT")).toBeCloseTo(1.0001, 4);
    expect(outcome.value.prices.get("USDC")).toBeCloseTo(0.9999, 4);
    expect(outcome.value.prices.has("BTC")).toBe(false);
    expect(outcome.value.prices.has("DAI")).toBe(false);
  });

  it("exposes per-pair upstream observed-at derived from Bitstamp `timestamp` field", async () => {
    mockFetch([{
      match: () => true,
      body: [
            { pair: "USDT/USD", market: "USDT/USD", last: "1.0001", timestamp: "1776439395" },
            { pair: "USDC/USD", market: "USDC/USD", last: "0.9999", timestamp: "1776439400" },
      ],
    }]);

    const outcome = await fetchBitstampPrices();
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.observedAtBySymbol.get("USDT")).toBe(1776439395);
    expect(outcome.value.observedAtBySymbol.get("USDC")).toBe(1776439400);
  });

  it("does not turn an untraded placeholder book into a fresh quote", async () => {
    // Live 2026-10-30 payload: the pair is still listed but has not traded, and
    // the placeholder book's 1.1552 midpoint must not become a fresh upstream
    // observation (docs/process/pricing-pipeline-appendix.md: quiet books never
    // receive fresh fetch-time provenance).
    mockFetch([{
      match: () => true,
      body: [
        {
          pair: "PYUSD/USD", market: "PYUSD/USD", last: "0.9500",
          volume: "0.00", open_24: "0.0000", bid: "0.8010", ask: "1.5094",
          timestamp: "1793373945",
        },
        {
          pair: "USDC/USD", market: "USDC/USD", last: "0.99968",
          volume: "1481982.12", open_24: "0.99970", bid: "0.99965", ask: "0.99971",
          timestamp: "1793373945",
        },
      ],
    }]);

    const outcome = await fetchBitstampPrices();
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.has("PYUSD")).toBe(false);
    expect(outcome.value.prices.get("USDC")).toBeCloseTo(0.99968, 5);
  });

  it("rejects a wide two-sided book without falling back to its last trade", async () => {
    mockFetch([{
      match: () => true,
      body: [
        {
          pair: "USDT/USD", market: "USDT/USD", bid: "0.9600", ask: "1.0400",
          last: "1.0001", timestamp: "1776439395",
        },
        {
          pair: "USDC/USD", market: "USDC/USD", bid: "0.99965", ask: "0.99971",
          last: "0.99968", timestamp: "1776439400",
        },
      ],
    }]);

    const outcome = await fetchBitstampPrices();

    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.has("USDT")).toBe(false);
    expect(outcome.value.observedAtBySymbol.has("USDT")).toBe(false);
    expect(outcome.value.prices.get("USDC")).toBeCloseTo(0.99968, 5);
    expect(outcome.value.diagnostics).toEqual([
      {
        source: "bitstamp",
        stage: "primary",
        endpoint: "www.bitstamp.net/api/v2/ticker/",
        status: 200,
        ok: true,
        success: true,
        rejectionReasonCounts: { "wide-spread": 1 },
      },
    ]);
  });


  it("returns no-data outcome when response has no tracked pairs", async () => {
    mockFetch([{ match: () => true, body: [{ pair: "BTC/USD", market: "BTC/USD", last: "65000" }] }]);
    const outcome = await fetchBitstampPrices();
    expect(outcome.kind).toBe("no-data");
  });
});


describe("provider HTTP failures", () => {
  it.each([
    ["Coinbase", () => fetchCoinbasePrices(["USDT"]), 404, 2],
    ["Kraken", () => fetchKrakenPrices(["USDT"]), 503, 2],
    ["Bitstamp", () => fetchBitstampPrices(), 500, 2],
  ] as const)("%s cancels failed responses and returns upstream-error", async (_venue, read, status, attempts) => {
    const cancel = vi.fn(async () => undefined);
    mockFetch([{
      match: () => true,
      outcomes: Array.from({ length: attempts }, () => ({
        response: new Response(new ReadableStream({ cancel }), { status }),
      })),
    }]);
    const outcome = await read();
    expect(outcome.kind).toBe("upstream-error");
    expect(outcome.value.prices.size).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(attempts);
  });
});

describe("exchange symbol allowlists", () => {
  const trackedSymbols = new Set(ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.symbol.toUpperCase()));
  const allKnownSymbols = [
    ...new Set([
      ...BINANCE_KNOWN_SYMBOLS,
      ...KRAKEN_KNOWN_SYMBOLS,
      ...BITSTAMP_KNOWN_SYMBOLS,
      ...COINBASE_KNOWN_SYMBOLS,
    ]),
  ].sort();

  it.each([
    ["Binance", BINANCE_KNOWN_SYMBOLS],
    ["Kraken", KRAKEN_KNOWN_SYMBOLS],
    ["Bitstamp", BITSTAMP_KNOWN_SYMBOLS],
    ["Coinbase", COINBASE_KNOWN_SYMBOLS],
  ] as const)("keeps %s symbols uppercase, unique, and active", (_venue, symbols) => {
    expect(new Set(symbols).size).toBe(symbols.length);
    for (const symbol of symbols) {
      expect(symbol).toBe(symbol.toUpperCase());
      expect(trackedSymbols.has(symbol)).toBe(true);
    }
  });

  it("maps every curated CEX symbol to one tracked owner or an explicit active stablecoinId", () => {
    const scopedKrakenBySymbol = new Map(
      KRAKEN_MARKETS.filter((market) => market.stablecoinId != null).map((market) => [market.symbol, market.stablecoinId!]),
    );
    const nonKrakenSymbols = new Set([...BINANCE_KNOWN_SYMBOLS, ...BITSTAMP_KNOWN_SYMBOLS, ...COINBASE_KNOWN_SYMBOLS]);
    for (const symbol of allKnownSymbols) {
      const scopedId = scopedKrakenBySymbol.get(symbol);
      if (scopedId && !nonKrakenSymbols.has(symbol)) {
        const owner = ACTIVE_STABLECOINS.find((stablecoin) => stablecoin.id === scopedId);
        expect(owner?.symbol.toUpperCase(), `${symbol} scoped Kraken id ${scopedId} must match an active coin`).toBe(symbol);
        continue;
      }
      const matchingIds = TRACKED_STABLECOINS
        .filter((stablecoin) => stablecoin.symbol.toUpperCase() === symbol)
        .map((stablecoin) => stablecoin.id);

      expect(matchingIds, `${symbol} CEX symbol must have exactly one tracked owner`).toHaveLength(1);
    }
  });
});
