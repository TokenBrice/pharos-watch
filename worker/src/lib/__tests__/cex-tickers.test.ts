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
    expect(outcome.value.diagnostics).toEqual([
      {
        source: "coinbase",
        stage: "primary",
        endpoint: "api.exchange.coinbase.com/products/{product}/ticker",
        status: 404,
        ok: false,
        success: false,
      },
      {
        source: "coinbase",
        stage: "primary",
        endpoint: "api.exchange.coinbase.com/products/{product}/ticker",
        status: 404,
        ok: false,
        success: false,
      },
    ]);
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
  });

});

describe("fetchKrakenPrices", () => {
  function mockKrakenSocket(rest: unknown, onSubscribe: (socket: EventTarget) => void) {
    const socket = Object.assign(new EventTarget(), {
      accept: vi.fn(),
      close: vi.fn(),
      send: vi.fn((_subscription: string) => onSubscribe(socket)),
    });
    const fetch = vi.fn(async (url: string) => {
      if (url === "https://ws.kraken.com/v2") return { status: 101, webSocket: socket };
      expect(socket.close).toHaveBeenCalledOnce();
      return Response.json(rest);
    });
    vi.stubGlobal("fetch", fetch);
    return { socket, fetch };
  }

  function snapshot(socket: EventTarget, rows: object[], type = "snapshot") {
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ channel: "ticker", type, data: rows }) }));
  }

  it("retains the QCAD REST book when the snapshot ages out during collection", async () => {
    const now = Math.floor(Date.now() / 1000);
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1_000);
    try {
      mockKrakenSocket({ result: { QCADUSD: { b: ["0.7"], a: ["0.7"] } } }, (ws) => {
        snapshot(ws, [{ symbol: "QCAD/USD", bid: 0.69, ask: 0.69, timestamp: new Date((now - 599) * 1_000).toISOString() }]);
        clock.mockReturnValue((now + 3) * 1_000);
      });
      const { value } = await fetchKrakenPrices(["QCAD"], undefined, true);
      expect(value.prices.get("QCAD")).toBe(0.7);
      expect(value.quoteBasisBySymbol?.get("QCAD")).toBe("bid-ask-midpoint");
      expect(value.bookSnapshotsBySymbol?.get("QCAD")).toEqual({ price: 0.69, observedAt: now - 599 });
    } finally {
      clock.mockRestore();
    }
  });

  it("collects only exact, fresh, two-sided BBO snapshots and keeps REST quotes", async () => {
    const now = Date.now();
    const row = { bid: 1.10, ask: 1.102, timestamp: new Date(now - 10_000).toISOString().replace(/Z$/, "123Z") };
    const pairs = ["AUDX", "BRL1", "EURC", "EUROP", "MXNB", "PAXG", "QCAD", "TGBP", "XAUT", "ZCHF"];
    const result = Object.fromEntries([...pairs, "USDC"].map((symbol) => [symbol + "USD", { c: ["1.05"] }]));
    const { socket, fetch } = mockKrakenSocket({ result }, (ws) => {
      snapshot(ws, [{ ...row, symbol: "EURC/USD", bid: 9, ask: 9 }], "update");
      snapshot(ws, [
        { ...row, symbol: "EURC/EUR" },
        { ...row, symbol: "USDC/USD" },
        { ...row, symbol: "EURC/USD" },
        { ...row, symbol: "AUDX/USD", bid: 0 },
        { ...row, symbol: "BRL1/USD", timestamp: "2026-11-20" },
        { ...row, symbol: "EUROP/USD", timestamp: new Date(now + 60_000).toISOString() },
        { ...row, symbol: "ZCHF/USD", timestamp: new Date(now - 601_000).toISOString() },
        { ...row, symbol: "MXNB/USD", bid: 1.12 },
        { ...row, symbol: "TGBP/USD", ask: 1.2 },
        ...["PAXG", "QCAD", "XAUT"].map((symbol) => ({ ...row, symbol: symbol + "/USD" })),
      ]);
    });
    const { kind, value } = await fetchKrakenPrices([...pairs, "USDC"], undefined, true);
    expect(kind).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(socket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      method: "subscribe", params: { channel: "ticker", symbol: pairs.map((s) => s + "/USD"), event_trigger: "bbo", snapshot: true },
    });
    expect([...value.bookSnapshotsBySymbol!.keys()]).toEqual(["EURC", "PAXG", "QCAD", "XAUT"]);
    expect(value.bookSnapshotsBySymbol?.get("EURC")).toEqual({
      price: expect.closeTo(1.101, 9), observedAt: Math.floor((now - 10_000) / 1000),
    });
    for (const symbol of [...pairs, "USDC"]) {
      expect(value.prices.get(symbol)).toBe(1.05);
      expect(value.quoteBasisBySymbol?.get(symbol)).toBe("last-trade");
    }
    expect(value.diagnostics).toEqual([expect.objectContaining({
      endpoint: "ws.kraken.com/v2", candidateCount: 10, resolvedCount: 4,
      rejectionReasonCounts: { "invalid-shape": 3, stale: 1, "wide-spread": 2 },
    })]);
  });

  it.each(["timeout", "abort", "message-cap", "byte-cap"] as const)("cleans up a partial subscription on %s", async (stop) => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { socket, fetch } = mockKrakenSocket({ result: { QCADUSD: { c: ["0.7"] } } }, (ws) => {
        snapshot(ws, [{ symbol: "AUDX/USD", bid: 0.6, ask: 0.6, timestamp: new Date().toISOString() }]);
        if (stop === "abort") controller.abort();
        const heartbeat = (data: string) => ws.dispatchEvent(new MessageEvent("message", { data }));
        if (stop === "message-cap") for (let i = 0; i < 64; i++) heartbeat("{}");
        if (stop === "byte-cap") heartbeat("€".repeat(12_000));
      });
      const outcome = fetchKrakenPrices(["AUDX", "QCAD"], controller.signal, true);
      if (stop === "abort") {
        await expect(outcome).rejects.toThrow();
        expect(fetch).toHaveBeenCalledOnce();
      } else {
        if (stop === "timeout") await vi.advanceTimersByTimeAsync(2_000);
        const { value } = await outcome;
        expect([...value.prices]).toEqual([["QCAD", 0.7]]);
        expect(value.bookSnapshotsBySymbol).toEqual(new Map([["AUDX", { price: 0.6, observedAt: expect.any(Number) }]]));
        expect(value.diagnostics[0]).toMatchObject({ errorClass: stop, rejectionReasonCounts: { "missing-quote": 1 } });
      }
      expect(socket.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the same deadline to a stalled upgrade before using REST", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async (_url: string, options: RequestInit) => {
        if (new Headers(options.headers).has("Upgrade")) {
          return new Promise<Response>((_, reject) => options.signal?.addEventListener("abort", () => reject(options.signal?.reason)));
        }
        return Response.json({ result: { AUDXUSD: { c: ["0.66"] } } });
      });
      vi.stubGlobal("fetch", fetch);
      const outcome = fetchKrakenPrices(["AUDX"], undefined, true);
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await outcome).value).toMatchObject({
        prices: new Map([["AUDX", 0.66]]), observedAtBySymbol: new Map(),
        diagnostics: [expect.objectContaining({ status: null, errorClass: "timeout" })],
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns ok outcome mapping pair keys to tracked symbols", async () => {
    const fetch = mockFetch([{
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
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toContain("https://api.kraken.com/0/public/Ticker");
    expect(outcome.kind).toBe("ok");
    expect(outcome.value.prices.get("USDT")).toBeCloseTo(1.0002, 4);
    expect(outcome.value.prices.get("USDC")).toBeCloseTo(0.9998, 4);
    expect(outcome.value.prices.get("DAI")).toBeCloseTo(1.0, 4);
    expect(outcome.value.prices.get("TGBP")).toBeCloseTo(1.35365, 5);
    expect(outcome.value.prices.get("MXNB")).toBeCloseTo(0.0566, 8);
    expect(outcome.value.quoteBasisBySymbol?.get("MXNB")).toBe("bid-ask-midpoint");
    expect(outcome.value.quoteBasisBySymbol?.get("USDC")).toBe("last-trade");
    expect(outcome.value.observedAtBySymbol.has("USDC")).toBe(false);
    expect(outcome.value.prices.has("BTC")).toBe(false);
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
    expect(outcome.value.prices.get("CASH")).toBeCloseTo(0.99985, 8);
    expect(outcome.value.prices.get("USDGO")).toBeCloseTo(0.99997, 8);
    expect(outcome.value.prices.size).toBe(2);
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
    expect(outcome.value.prices.get("AUDX")).toBeCloseTo(0.70345, 8);
    expect(outcome.value.prices.get("BRL1")).toBeCloseTo(0.18263, 8);
    expect(outcome.value.prices.get("EUROP")).toBeCloseTo(1.11515, 8);
    expect(outcome.value.prices.get("QCAD")).toBeCloseTo(0.71475, 8);
    expect(outcome.value.prices.get("USDPT")).toBeCloseTo(0.999995, 8);
    expect(outcome.value.prices.get("USDSM")).toBeCloseTo(1.0, 8);
    expect(outcome.value.prices.get("USDSUI")).toBeCloseTo(1.000295, 8);
    expect(outcome.value.prices.get("ZCHF")).toBeCloseTo(1.210695, 8);
    expect(outcome.value.prices.size).toBe(8);
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

  it("maps every curated CEX symbol to exactly one tracked stablecoin id", () => {
    for (const symbol of allKnownSymbols) {
      const matchingIds = TRACKED_STABLECOINS
        .filter((stablecoin) => stablecoin.symbol.toUpperCase() === symbol)
        .map((stablecoin) => stablecoin.id);

      expect(matchingIds, `${symbol} CEX symbol must have exactly one tracked owner`).toHaveLength(1);
    }
  });
});
