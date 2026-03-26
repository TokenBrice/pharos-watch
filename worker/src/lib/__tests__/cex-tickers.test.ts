import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BINANCE_KNOWN_SYMBOLS,
  BITSTAMP_KNOWN_SYMBOLS,
  COINBASE_KNOWN_SYMBOLS,
  KRAKEN_KNOWN_SYMBOLS,
  fetchBinancePrices,
  fetchBitstampPrices,
  fetchCoinbasePrices,
  fetchKrakenPrices,
} from "../cex-tickers";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";

afterEach(() => vi.unstubAllGlobals());

describe("fetchBinancePrices", () => {
  it("returns stablecoin/USD prices from ticker endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { symbol: "USDTUSD", price: "0.9999" },
        { symbol: "USDCUSD", price: "1.0001" },
        { symbol: "BTCUSD", price: "65000" },
      ]),
    }));
    const results = await fetchBinancePrices();
    expect(results.get("USDT")).toBeCloseTo(0.9999, 4);
    expect(results.get("USDC")).toBeCloseTo(1.0001, 4);
    expect(results.has("BTC")).toBe(false);
  });

  it("returns empty map on failure", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, body: { cancel } }));
    const results = await fetchBinancePrices();
    expect(results.size).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("returns empty map when Binance returns no stablecoin pairs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { symbol: "BTCUSD", price: "65000" },
        { symbol: "ETHUSDT", price: "3500" },
      ]),
    }));
    const results = await fetchBinancePrices();
    expect(results.size).toBe(0);
  });
});

describe("fetchCoinbasePrices", () => {
  it("returns prices for listed stablecoin products", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("/products/USDT-USD/ticker"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ price: "0.9998" }) });
      if (url.includes("/products/DAI-USD/ticker"))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ price: "1.0000" }) });
      return Promise.resolve({ ok: false, status: 404 });
    }));
    const results = await fetchCoinbasePrices(["USDT", "DAI", "XYZFAKE"]);
    expect(results.get("USDT")).toBeCloseTo(0.9998, 4);
    expect(results.get("DAI")).toBeCloseTo(1.0, 4);
    expect(results.has("XYZFAKE")).toBe(false);
  });

  it("cancels failed product responses before continuing", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, body: { cancel } }));

    const results = await fetchCoinbasePrices(["USDT"]);

    expect(results.size).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});

describe("fetchKrakenPrices", () => {
  it("maps returned pair keys to tracked symbols", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        error: [],
        result: {
          USDTZUSD: { c: ["1.0002"] },
          USDCUSD: { c: ["0.9998"] },
          DAIUSD: { c: ["1.0000"] },
          BTCUSD: { c: ["65000"] },
        },
      }),
    }));

    const results = await fetchKrakenPrices(["USDT", "USDC", "DAI"]);
    expect(results.get("USDT")).toBeCloseTo(1.0002, 4);
    expect(results.get("USDC")).toBeCloseTo(0.9998, 4);
    expect(results.get("DAI")).toBeCloseTo(1.0, 4);
    expect(results.has("BTC")).toBe(false);
  });

  it("returns empty map when Kraken returns an API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: ["EGeneral:Temporary lockout"], result: {} }),
    }));

    const results = await fetchKrakenPrices(["USDT"]);
    expect(results.size).toBe(0);
  });

  it("cancels failed HTTP responses", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, body: { cancel } }));

    const results = await fetchKrakenPrices(["USDT"]);

    expect(results.size).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});

describe("fetchBitstampPrices", () => {
  it("parses tracked stablecoin/USD pairs from the all-tickers endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { pair: "USDT/USD", market: "USDT/USD", last: "1.0001" },
        { pair: "USDC/USD", market: "USDC/USD", last: "0.9999" },
        { pair: "BTC/USD", market: "BTC/USD", last: "65000" },
      ]),
    }));

    const results = await fetchBitstampPrices();
    expect(results.get("USDT")).toBeCloseTo(1.0001, 4);
    expect(results.get("USDC")).toBeCloseTo(0.9999, 4);
    expect(results.has("BTC")).toBe(false);
  });

  it("cancels failed HTTP responses", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, body: { cancel } }));

    const results = await fetchBitstampPrices();

    expect(results.size).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(2);
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
});
