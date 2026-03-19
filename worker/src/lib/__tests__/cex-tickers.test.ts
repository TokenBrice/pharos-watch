import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BITSTAMP_KNOWN_SYMBOLS,
  COINBASE_KNOWN_SYMBOLS,
  KRAKEN_KNOWN_SYMBOLS,
  fetchBinancePrices,
  fetchBitstampPrices,
  fetchCoinbasePrices,
  fetchKrakenPrices,
} from "../cex-tickers";

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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const results = await fetchBinancePrices();
    expect(results.size).toBe(0);
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
  it("keeps Kraken symbols uppercase", () => {
    for (const symbol of KRAKEN_KNOWN_SYMBOLS) {
      expect(symbol).toBe(symbol.toUpperCase());
    }
  });

  it("keeps Bitstamp symbols uppercase", () => {
    for (const symbol of BITSTAMP_KNOWN_SYMBOLS) {
      expect(symbol).toBe(symbol.toUpperCase());
    }
  });
});
