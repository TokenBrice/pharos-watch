import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeOrderbookDepth,
  fetchBinanceOrderbookDepths,
  fetchCoinbaseOrderbookDepths,
  fetchKrakenOrderbookDepths,
  summarizeCexOrderbookDepths,
} from "../cex-orderbooks";
import { mockFetch } from "@shared/test-utils/mock-fetch";

afterEach(() => vi.unstubAllGlobals());

describe("computeOrderbookDepth", () => {
  it("computes two-percent downside and upside depth from L2 books", () => {
    const depth = computeOrderbookDepth({
      venue: "binance",
      symbol: "USDT",
      productId: "USDTUSD",
      bids: [
        { price: 0.999, size: 1_000 },
        { price: 0.985, size: 2_000 },
        { price: 0.970, size: 10_000 },
      ],
      asks: [
        { price: 1.001, size: 1_500 },
        { price: 1.015, size: 2_000 },
        { price: 1.030, size: 10_000 },
      ],
      fetchedAt: 1_700_000_000,
    });

    expect(depth).toMatchObject({
      venue: "binance",
      symbol: "USDT",
      productId: "USDTUSD",
      spreadBps: expect.closeTo(20, 6),
      depthDown2PctUsd: expect.closeTo(0.999 * 1_000 + 0.985 * 2_000, 6),
      depthUp2PctUsd: expect.closeTo(1.001 * 1_500 + 1.015 * 2_000, 6),
      bidLevels: 3,
      askLevels: 3,
      fetchedAt: 1_700_000_000,
    });
  });

  it("rejects wide spreads", () => {
    const depth = computeOrderbookDepth({
      venue: "coinbase",
      symbol: "USDT",
      productId: "USDT-USD",
      bids: [{ price: 0.90, size: 1_000 }],
      asks: [{ price: 1.10, size: 1_000 }],
    });

    expect(depth).toBeNull();
  });
});

describe("direct CEX orderbook fetchers", () => {
  it("parses Binance orderbook depth for configured major pairs", async () => {
    mockFetch([{
      match: () => true,
      body: {
        bids: [["0.999", "1000"]],
        asks: [["1.001", "1000"]],
      },
    }]);

    const rows = await fetchBinanceOrderbookDepths();

    expect(rows.map((row) => row.symbol).sort()).toEqual(["USDC", "USDT"]);
    expect(rows[0]?.venue).toBe("binance");
  });

  it("parses Coinbase orderbook depth for configured major products", async () => {
    mockFetch([{
      match: () => true,
      body: {
        bids: [["0.999", "1000", 2]],
        asks: [["1.001", "1000", 3]],
      },
    }]);

    const rows = await fetchCoinbaseOrderbookDepths();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ venue: "coinbase", symbol: "USDT", productId: "USDT-USD" });
  });

  it("parses Kraken orderbook depth through response aliases", async () => {
    mockFetch([{
      match: () => true,
      respond: (request) => {
        const key = request.url.includes("USDTUSD") ? "USDTZUSD" : "USDCUSD";
        return new Response(JSON.stringify({
          error: [],
          result: {
            [key]: {
              bids: [["0.999", "1000", 1700000000]],
              asks: [["1.001", "1000", 1700000000]],
            },
          },
        }), { status: 200 });
      },
    }]);

    const rows = await fetchKrakenOrderbookDepths();

    expect(rows.map((row) => row.symbol).sort()).toEqual(["USDC", "USDT"]);
    expect(rows.every((row) => row.venue === "kraken")).toBe(true);
  });
});

describe("summarizeCexOrderbookDepths", () => {
  it("summarizes max depths by symbol and venue counts", () => {
    const summary = summarizeCexOrderbookDepths([
      {
        venue: "binance",
        symbol: "USDT",
        productId: "USDTUSD",
        midPrice: 1,
        spreadBps: 1,
        depthDown2PctUsd: 10,
        depthUp2PctUsd: 20,
        bidLevels: 1,
        askLevels: 1,
        fetchedAt: 1,
      },
      {
        venue: "kraken",
        symbol: "USDT",
        productId: "USDTUSD",
        midPrice: 1,
        spreadBps: 1,
        depthDown2PctUsd: 30,
        depthUp2PctUsd: 15,
        bidLevels: 1,
        askLevels: 1,
        fetchedAt: 1,
      },
    ]);

    expect(summary).toEqual({
      checkedSymbols: 1,
      venueCount: 2,
      observations: 2,
      maxDepthDown2PctUsdBySymbol: { USDT: 30 },
      maxDepthUp2PctUsdBySymbol: { USDT: 20 },
    });
  });
});
