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
  it("prices the AUDD-USDC FX-stablecoin product from its bid/ask midpoint", async () => {
    // Live shape probed 2026-09-26 from
    // https://api.exchange.coinbase.com/products/AUDD-USDC/ticker (fx_stablecoin
    // book; USDC quote treated at USD par). Midpoint must win over the last
    // trade so the thin book's prints cannot skew the hard-market voice.
    mockFetch([
      {
        match: "/products/AUDD-USDC/ticker",
        body: {
          ask: "0.7075",
          bid: "0.7036",
          price: "0.7036",
          time: "2026-09-26T22:28:40.333586513Z",
        },
      },
      { match: () => true, body: {}, status: 404 },
    ], { requireMatch: true });
    const outcome = await fetchCoinbasePrices(["AUDD"]);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.get("AUDD")).toBeCloseTo(0.70555, 6);
    const expectedSec = Math.floor(Date.parse("2026-09-26T22:28:40.333586513Z") / 1000);
    expect(outcome.value.observedAtBySymbol.get("AUDD")).toBe(expectedSec);
  });

  it("prices the XSGD-USDC FX-stablecoin product from its bid/ask midpoint", async () => {
    // Live shape probed 2026-10-30 from
    // https://api.exchange.coinbase.com/products/XSGD-USDC/ticker (USDC quote
    // treated at USD par under the AUDD-USDC precedent).
    mockFetch([
      {
        match: "/products/XSGD-USDC/ticker",
        body: {
          ask: "0.7831",
          bid: "0.7821",
          price: "0.783",
          time: "2026-10-30T21:18:48.841299403Z",
        },
      },
      { match: () => true, body: {}, status: 404 },
    ], { requireMatch: true });
    const outcome = await fetchCoinbasePrices(["XSGD"]);
    expect(COINBASE_KNOWN_SYMBOLS).toContain("XSGD");
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.get("XSGD")).toBeCloseTo(0.7826, 6);
    const expectedSec = Math.floor(Date.parse("2026-10-30T21:18:48.841299403Z") / 1000);
    expect(outcome.value.observedAtBySymbol.get("XSGD")).toBe(expectedSec);
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
      return new Response(JSON.stringify({ price: "1.0000", time: "2026-06-11T12:00:00.000Z" }), {
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
              // Live shape probed 2026-09-26: MXNBUSD bid/ask midpoint preferred over last.
              MXNBUSD: { a: ["0.056620"], b: ["0.056580"], c: ["0.056530"] },
              BTCUSD: { c: ["65000"] },
            },
      },
    }]);

    const outcome = await fetchKrakenPrices(["USDT", "USDC", "DAI", "TGBP", "MXNB"]);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.get("USDT")).toBeCloseTo(1.0002, 4);
    expect(outcome.value.get("USDC")).toBeCloseTo(0.9998, 4);
    expect(outcome.value.get("DAI")).toBeCloseTo(1.0, 4);
    expect(outcome.value.get("TGBP")).toBeCloseTo(1.35365, 5);
    expect(outcome.value.get("MXNB")).toBeCloseTo(0.0566, 8);
    expect(outcome.value.has("BTC")).toBe(false);
  });

  it("requests the exact SoFiUSD market and prefers its bid/ask midpoint", async () => {
    const requestedUrls: string[] = [];
    mockFetch([{
      match: (request) => {
        requestedUrls.push(request.url);
        return true;
      },
      body: {
        error: [],
        result: {
          // Live SOFIDUSD ticker shape observed 2026-10-05.
          SOFIDUSD: { a: ["0.99979000"], b: ["0.99976000"], c: ["0.99976000"] },
        },
      },
    }]);

    const outcome = await fetchKrakenPrices(["SOFID"]);

    expect(KRAKEN_KNOWN_SYMBOLS).toContain("SOFID");
    expect(requestedUrls).toEqual(["https://api.kraken.com/0/public/Ticker?pair=SOFIDUSD"]);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.get("SOFID")).toBeCloseTo(0.999775, 8);
    expect(outcome.value.size).toBe(1);
  });

  it("requests the exact Tether Gold market and prefers its bid/ask midpoint", async () => {
    const requestedUrls: string[] = [];
    mockFetch([{
      match: (request) => {
        requestedUrls.push(request.url);
        return true;
      },
      body: {
        error: [],
        result: {
          // Live XAUTUSD ticker shape observed 2026-10-30.
          XAUTUSD: { a: ["3906.10000"], b: ["3906.00000"], c: ["3905.00000"] },
        },
      },
    }]);

    const outcome = await fetchKrakenPrices(["XAUT"]);

    expect(KRAKEN_KNOWN_SYMBOLS).toContain("XAUT");
    expect(requestedUrls).toEqual(["https://api.kraken.com/0/public/Ticker?pair=XAUTUSD"]);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.get("XAUT")).toBeCloseTo(3906.05, 8);
    expect(outcome.value.size).toBe(1);
  });

  it("requests the reviewed CASH and USDGO markets and prefers their bid/ask midpoints", async () => {
    const requestedUrls: string[] = [];
    mockFetch([{
      match: (request) => {
        requestedUrls.push(request.url);
        return true;
      },
      body: {
        error: [],
        result: {
          // Live ticker shapes observed 2026-10-30.
          CASHUSD: { a: ["1.00000000", "101"], b: ["0.99970000", "101"], c: ["1.00070000", "1900.92179"] },
          USDGOUSD: { a: ["1.00001000", "41158"], b: ["0.99993000", "15239"], c: ["0.99993000", "344.90729"] },
        },
      },
    }]);

    const symbols = ["CASH", "USDGO"];
    const outcome = await fetchKrakenPrices(symbols);

    for (const symbol of symbols) expect(KRAKEN_KNOWN_SYMBOLS).toContain(symbol);
    expect(requestedUrls).toEqual([
      "https://api.kraken.com/0/public/Ticker?pair=CASHUSD,USDGOUSD",
    ]);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.get("CASH")).toBeCloseTo(0.99985, 8);
    expect(outcome.value.get("USDGO")).toBeCloseTo(0.99997, 8);
    expect(outcome.value.size).toBe(2);
  });

  it("requests the 2026-10-30 reviewed Kraken books and prefers their bid/ask midpoints", async () => {
    const requestedUrls: string[] = [];
    mockFetch([{
      match: (request) => {
        requestedUrls.push(request.url);
        return true;
      },
      body: {
        error: [],
        result: {
          // Live ticker shapes observed 2026-10-30.
          AUDXUSD: { a: ["0.70372000", "107413"], b: ["0.70318000", "15000"], c: ["0.70330000", "599.98546851"] },
          BRL1USD: { a: ["0.18285000", "8656"], b: ["0.18241000", "2787"], c: ["0.18287000", "2593.34863638"] },
          EUROPUSD: { a: ["1.11580000", "13974"], b: ["1.11450000", "1000"], c: ["1.11450000", "94.76470"] },
          QCADUSD: { a: ["0.71510000", "69954"], b: ["0.71440000", "69964"], c: ["0.71510000", "16769.00000000"] },
          USDPTUSD: { a: ["1.00044000", "100000"], b: ["0.99955000", "100000"], c: ["1.00044000", "247.41593"] },
          USDSMUSD: { a: ["1.00050000", "24985"], b: ["0.99950000", "23177"], c: ["0.99950000", "6.03650"] },
          USDSUIUSD: { a: ["1.00039000", "9974"], b: ["1.00020000", "12813"], c: ["1.00014000", "9973.75794"] },
          ZCHFUSD: { a: ["1.21152000", "4116"], b: ["1.20987000", "417"], c: ["1.21003000", "4.59130"] },
        },
      },
    }]);

    const symbols = ["ZCHF", "USDSM", "USDSUI", "USDPT", "EUROP", "QCAD", "AUDX", "BRL1"];
    const outcome = await fetchKrakenPrices(symbols);

    for (const symbol of symbols) expect(KRAKEN_KNOWN_SYMBOLS).toContain(symbol);
    expect(requestedUrls).toEqual([
      `https://api.kraken.com/0/public/Ticker?pair=${[
        "AUDXUSD", "BRL1USD", "EUROPUSD", "QCADUSD",
        "USDPTUSD", "USDSMUSD", "USDSUIUSD", "ZCHFUSD",
      ].join(",")}`,
    ]);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.get("AUDX")).toBeCloseTo(0.70345, 8);
    expect(outcome.value.get("BRL1")).toBeCloseTo(0.18263, 8);
    expect(outcome.value.get("EUROP")).toBeCloseTo(1.11515, 8);
    expect(outcome.value.get("QCAD")).toBeCloseTo(0.71475, 8);
    expect(outcome.value.get("USDPT")).toBeCloseTo(0.999995, 8);
    expect(outcome.value.get("USDSM")).toBeCloseTo(1.0, 8);
    expect(outcome.value.get("USDSUI")).toBeCloseTo(1.000295, 8);
    expect(outcome.value.get("ZCHF")).toBeCloseTo(1.210695, 8);
    expect(outcome.value.size).toBe(8);
  });

  it("requests Wyoming FRNT's exact USD book and uses its bid/ask instead of the last trade", async () => {
    const requestedUrls: string[] = [];
    mockFetch([{
      match: (request) => {
        requestedUrls.push(request.url);
        return true;
      },
      body: {
        error: [],
        result: {
          FRNTUSD: { a: ["1.00000000"], b: ["0.99840000"], c: ["1.00000000"] },
        },
      },
    }]);

    const outcome = await fetchKrakenPrices(["FRNT"]);

    expect(KRAKEN_KNOWN_SYMBOLS).toContain("FRNT");
    expect(requestedUrls).toEqual(["https://api.kraken.com/0/public/Ticker?pair=FRNTUSD"]);
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.get("FRNT")).toBeCloseTo(0.9992, 8);
    expect(outcome.value.size).toBe(1);
  });

  it("returns upstream-error outcome when Kraken returns an API error", async () => {
    mockFetch([{ match: () => true, body: { error: ["EGeneral:Temporary lockout"], result: {} } }]);

    const outcome = await fetchKrakenPrices(["USDT"]);
    expect(outcome.kind).toBe("upstream-error");
    expect(outcome.value.size).toBe(0);
    expect(outcome).toMatchObject({ reason: "EGeneral:Temporary lockout" });
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

  it("maps every curated CEX symbol to exactly one tracked stablecoin id", () => {
    for (const symbol of allKnownSymbols) {
      const matchingIds = TRACKED_STABLECOINS
        .filter((stablecoin) => stablecoin.symbol.toUpperCase() === symbol)
        .map((stablecoin) => stablecoin.id);

      expect(matchingIds, `${symbol} CEX symbol must have exactly one tracked owner`).toHaveLength(1);
    }
  });
});
