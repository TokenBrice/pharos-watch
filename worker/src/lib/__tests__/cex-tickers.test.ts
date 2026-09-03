import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { makeNoopD1 } from "../../test-helpers/noop-d1";

const { sleepWithSignalMock } = vi.hoisted(() => ({
  sleepWithSignalMock: vi.fn(async () => undefined),
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
import coinbaseTickerFixture from "./fixtures/coinbase-ticker.json";
import { mockFetch } from "@shared/test-utils/mock-fetch";

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

  it("ignores stable-quoted Binance markets that are no longer configured", async () => {
    mockFetch([{
      match: () => true,
      body: [
            { symbol: "USDTUSD", price: "0.9999" },
            { symbol: "USDCUSD", price: "1.0001" },
            { symbol: "BFUSDUSDT", price: "0.9995" },
            { symbol: "BFUSDUSDC", price: "0.9993" },
      ],
    }]);

    const results = (await fetchBinancePricesDetailed()).value.prices;
    expect(results.has("BFUSD")).toBe(false);
  });

  it("returns empty map on failure", async () => {
    const fetchMock = mockFetch([{ match: () => true, body: "upstream unavailable", status: 503 }]);
    const results = (await fetchBinancePricesDetailed()).value.prices;
    expect(results.size).toBe(0);
    // One fetch per host (2 hosts). 5xx short-circuits to the next host
    // instead of retrying the same host.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns empty map when Binance returns no stablecoin pairs", async () => {
    mockFetch([{
      match: () => true,
      body: [
            { symbol: "BTCUSD", price: "65000" },
            { symbol: "ETHUSDT", price: "3500" },
      ],
    }]);
    const results = (await fetchBinancePricesDetailed()).value.prices;
    expect(results.size).toBe(0);
  });

  it("reports Binance response and match counts for diagnostics", async () => {
    mockFetch([{
      match: () => true,
      body: [
            { symbol: "BTCUSD", price: "65000" },
            { symbol: "ETHUSDT", price: "3500" },
      ],
    }]);

    const {
      value: { prices, diagnostics },
    } = await fetchBinancePricesDetailed();

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

  it("captures Binance non-OK snippets for diagnostics", async () => {
    mockFetch([{ match: () => true, body: "blocked by upstream", status: 403 }]);

    const {
      value: { prices, diagnostics },
    } = await fetchBinancePricesDetailed();

    expect(prices.size).toBe(0);
    expect(diagnostics[0]).toMatchObject({
      source: "binance",
      status: 403,
      ok: false,
      success: false,
      snippet: "blocked by upstream",
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

  it("returns no-data outcome when hosts return 200 but no tracked pairs", async () => {
    mockFetch([{ match: () => true, body: [{ symbol: "BTCUSD", price: "65000" }] }]);
    const outcome = await fetchBinancePricesDetailed();
    expect(outcome.kind).toBe("no-data");
    expect(outcome.value.prices.size).toBe(0);
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
  it("returns ok outcome with prices for listed stablecoin products", async () => {
    mockFetch([
      { match: "/products/USDT-USD/ticker", body: { price: "0.9998" } },
      { match: "/products/USDS-USD/ticker", body: { price: "1.0000" } },
      { match: () => true, body: {}, status: 404 },
    ], { requireMatch: true });
    const outcome = await fetchCoinbasePrices(["USDT", "USDS", "XYZFAKE"]);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.get("USDT")).toBeCloseTo(0.9998, 4);
    expect(outcome.value.prices.get("USDS")).toBeCloseTo(1.0, 4);
    expect(outcome.value.prices.has("XYZFAKE")).toBe(false);
  });

  it("exposes per-pair upstream observed-at derived from Coinbase `time` ISO string", async () => {
    mockFetch([
      {
        match: "/products/USDT-USD/ticker",
        body: {
          bid: "0.9997",
          ask: "0.9999",
          price: "0.9998",
          time: "2026-04-17T15:05:04.183Z",
        },
      },
      { match: () => true, body: {}, status: 404 },
    ], { requireMatch: true });
    const outcome = await fetchCoinbasePrices(["USDT"]);
    expect(outcome.kind).toBe("ok");
    const expectedSec = Math.floor(Date.parse("2026-04-17T15:05:04.183Z") / 1000);
    expect(outcome.value.observedAtBySymbol.get("USDT")).toBe(expectedSec);
  });

  it("cancels failed product responses and returns upstream-error outcome", async () => {
    const cancel = vi.fn(async () => undefined);
    const failedResponse = () => new Response(new ReadableStream({ cancel }), { status: 404 });
    mockFetch([{
      match: () => true,
      outcomes: [{ response: failedResponse() }],
    }]);

    const outcome = await fetchCoinbasePrices(["USDT"]);

    // When every product request fails (whether via throw or non-OK response),
    // Coinbase gives the breaker no reason to believe it's contributing — treat
    // as upstream-error so the breaker tracks consecutive failures.
    expect(outcome.kind).toBe("upstream-error");
    expect(outcome.value.prices.size).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns upstream-error outcome when every product request throws", async () => {
    mockFetch([{ match: () => true, outcomes: [new Error("network down")] }]);
    const outcome = await fetchCoinbasePrices(["USDT"]);
    expect(outcome.kind).toBe("upstream-error");
    expect(outcome.value.prices.size).toBe(0);
  });

  it("returns ok outcome when some products fail and others succeed", async () => {
    mockFetch([
      { match: "/products/USDT-USD/ticker", body: { price: "0.9998" } },
      { match: () => true, outcomes: [new Error("network down")] },
    ], { requireMatch: true });
    const outcome = await fetchCoinbasePrices(["USDT", "DAI"]);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.get("USDT")).toBeCloseTo(0.9998, 4);
    expect(outcome.value.prices.has("DAI")).toBe(false);
  });

  it("rejects ticker prices with trailing non-numeric text", async () => {
    mockFetch([
      { match: "/products/USDT-USD/ticker", body: { bid: "0.9997 USD", ask: "0.9999 USD", price: "0.9998 USD" } },
      { match: () => true, body: {}, status: 404 },
    ], { requireMatch: true });

    const outcome = await fetchCoinbasePrices(["USDT"]);

    expect(outcome.kind).toBe("no-data");
    expect(outcome.value.prices.has("USDT")).toBe(false);
  });

  it("rejects non-decimal JavaScript numeric literal price strings", async () => {
    mockFetch([
      { match: "/products/USDT-USD/ticker", body: { bid: "0x10", ask: "0b10", price: "0o10" } },
      { match: () => true, body: {}, status: 404 },
    ], { requireMatch: true });

    const outcome = await fetchCoinbasePrices(["USDT"]);

    expect(outcome.kind).toBe("no-data");
    expect(outcome.value.prices.has("USDT")).toBe(false);
  });

  it("keeps Coinbase product fetches serial inside the primary-provider budget", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = mockFetch([{
      match: () => true,
      respond: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return new Response(JSON.stringify({ price: "1.0000", time: "2026-06-11T12:00:00.000Z" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      },
    }]);

    const outcome = await fetchCoinbasePrices(["USDT", "PAXG", "USDS", "USD1", "HONEY"]);

    expect(outcome.kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(maxInFlight).toBe(1);
  });

  it("parses a real Coinbase USDT-USD ticker response (fixture)", async () => {
    // Fixture captured from https://api.exchange.coinbase.com/products/USDT-USD/ticker
    // Verifies our parser survives the live response shape (bid/ask present;
    // midpoint preferred over last-trade price).
    mockFetch([
      { match: "/products/USDT-USD/ticker", body: coinbaseTickerFixture },
      { match: () => true, body: {}, status: 404 },
    ], { requireMatch: true });
    const outcome = await fetchCoinbasePrices(["USDT"]);
    expect(outcome.kind).toBe("ok");
    const bid = Number(coinbaseTickerFixture.bid);
    const ask = Number(coinbaseTickerFixture.ask);
    expect(outcome.value.prices.get("USDT")).toBeCloseTo((bid + ask) / 2, 6);
  });
});

describe("fetchKrakenPrices", () => {
  it("returns ok outcome mapping pair keys to tracked symbols", async () => {
    mockFetch([{
      match: () => true,
      body: {
            error: [],
            result: {
              USDTZUSD: { c: ["1.0002"] },
              USDCUSD: { c: ["0.9998"] },
              DAIUSD: { c: ["1.0000"] },
              TGBPUSD: { a: ["1.3538"], b: ["1.3535"], c: ["1.3531"] },
              BTCUSD: { c: ["65000"] },
            },
      },
    }]);

    const outcome = await fetchKrakenPrices(["USDT", "USDC", "DAI", "TGBP"]);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.get("USDT")).toBeCloseTo(1.0002, 4);
    expect(outcome.value.get("USDC")).toBeCloseTo(0.9998, 4);
    expect(outcome.value.get("DAI")).toBeCloseTo(1.0, 4);
    expect(outcome.value.get("TGBP")).toBeCloseTo(1.35365, 5);
    expect(outcome.value.has("BTC")).toBe(false);
  });

  it("returns no-data outcome when Kraken returns an API error", async () => {
    mockFetch([{ match: () => true, body: { error: ["EGeneral:Temporary lockout"], result: {} } }]);

    const outcome = await fetchKrakenPrices(["USDT"]);
    expect(outcome.kind).toBe("no-data");
    expect(outcome.value.size).toBe(0);
  });

  it("returns upstream-error when HTTP request fails", async () => {
    const cancel = vi.fn(async () => undefined);
    const failedResponse = () => new Response(new ReadableStream({ cancel }), { status: 503 });
    mockFetch([{
      match: () => true,
      outcomes: [{ response: failedResponse() }, { response: failedResponse() }],
    }]);

    const outcome = await fetchKrakenPrices(["USDT"]);

    expect(outcome.kind).toBe("upstream-error");
    expect(outcome.value.size).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(2);
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
      ],
    }]);

    const outcome = await fetchBitstampPrices();
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.get("USDT")).toBeCloseTo(1.0001, 4);
    expect(outcome.value.prices.get("USDC")).toBeCloseTo(0.9999, 4);
    expect(outcome.value.prices.has("BTC")).toBe(false);
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

  it("returns upstream-error when HTTP request fails", async () => {
    const cancel = vi.fn(async () => undefined);
    const failedResponse = () => new Response(new ReadableStream({ cancel }), { status: 500 });
    mockFetch([{
      match: () => true,
      outcomes: [{ response: failedResponse() }, { response: failedResponse() }],
    }]);

    const outcome = await fetchBitstampPrices();

    expect(outcome.kind).toBe("upstream-error");
    expect(outcome.value.prices.size).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("returns no-data outcome when response has no tracked pairs", async () => {
    mockFetch([{ match: () => true, body: [{ pair: "BTC/USD", market: "BTC/USD", last: "65000" }] }]);
    const outcome = await fetchBitstampPrices();
    expect(outcome.kind).toBe("no-data");
  });
});

describe("COINBASE_KNOWN_SYMBOLS", () => {
  it("contains only uppercase symbols", () => {
    for (const symbol of COINBASE_KNOWN_SYMBOLS) {
      expect(symbol).toBe(symbol.toUpperCase());
    }
  });

  it("has a reasonable number of entries (5-25)", () => {
    expect(COINBASE_KNOWN_SYMBOLS.length).toBeGreaterThanOrEqual(5);
    expect(COINBASE_KNOWN_SYMBOLS.length).toBeLessThanOrEqual(25);
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

  it("keeps Binance symbols uppercase and tracked", () => {
    expect(new Set(BINANCE_KNOWN_SYMBOLS).size).toBe(BINANCE_KNOWN_SYMBOLS.length);
    for (const symbol of BINANCE_KNOWN_SYMBOLS) {
      expect(symbol).toBe(symbol.toUpperCase());
      expect(trackedSymbols.has(symbol)).toBe(true);
    }
  });

  it("keeps Kraken symbols uppercase", () => {
    expect(new Set(KRAKEN_KNOWN_SYMBOLS).size).toBe(KRAKEN_KNOWN_SYMBOLS.length);
    for (const symbol of KRAKEN_KNOWN_SYMBOLS) {
      expect(symbol).toBe(symbol.toUpperCase());
      expect(trackedSymbols.has(symbol)).toBe(true);
    }
  });

  it("keeps Bitstamp symbols uppercase", () => {
    expect(new Set(BITSTAMP_KNOWN_SYMBOLS).size).toBe(BITSTAMP_KNOWN_SYMBOLS.length);
    for (const symbol of BITSTAMP_KNOWN_SYMBOLS) {
      expect(symbol).toBe(symbol.toUpperCase());
      expect(trackedSymbols.has(symbol)).toBe(true);
    }
  });

  it("keeps Coinbase symbols uppercase, unique, and tracked", () => {
    expect(new Set(COINBASE_KNOWN_SYMBOLS).size).toBe(COINBASE_KNOWN_SYMBOLS.length);
    for (const symbol of COINBASE_KNOWN_SYMBOLS) {
      expect(symbol).toBe(symbol.toUpperCase());
      expect(trackedSymbols.has(symbol)).toBe(true);
    }
  });

  it("maps every curated CEX symbol to exactly one tracked stablecoin id", () => {
    for (const symbol of allKnownSymbols) {
      const matchingIds = TRACKED_STABLECOINS
        .filter((stablecoin) => stablecoin.symbol.toUpperCase() === symbol)
        .map((stablecoin) => stablecoin.id);

      expect(matchingIds, `${symbol} CEX symbol must have exactly one tracked owner`).toHaveLength(1);
    }
  });
});
