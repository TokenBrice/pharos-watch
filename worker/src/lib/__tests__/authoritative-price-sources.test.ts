import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchEvmCallHexAtBlockMock = vi.fn();
const resolveClosestBlockAtOrBeforeTimestampMock = vi.fn();
const fetchMarketBackfillPriceSeriesMock = vi.fn();

vi.mock("@shared/lib/stablecoins", () => ({
  TRACKED_META_BY_ID: new Map([
    [
      "cusd-cap",
      {
        id: "cusd-cap",
        contracts: [{ chain: "ethereum", address: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc", decimals: 18 }],
      },
    ],
    [
      "iusd-infinifi",
      {
        id: "iusd-infinifi",
        contracts: [{ chain: "ethereum", address: "0x48f9e38f3070ad8945dfeae3fa70987722e3d89c", decimals: 18 }],
      },
    ],
    [
      "pyusd-paypal",
      {
        id: "pyusd-paypal",
        geckoId: "paypal-usd",
      },
    ],
    [
      "wm-m0",
      {
        id: "wm-m0",
        geckoId: "wrappedm-by-m0",
      },
    ],
    [
      "usdai-usd-ai",
      {
        id: "usdai-usd-ai",
        geckoId: "usdai",
      },
    ],
    [
      "usdc-circle",
      {
        id: "usdc-circle",
        contracts: [{ chain: "ethereum", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }],
      },
    ],
  ]),
}));

vi.mock("../evm-rpc", () => ({
  fetchEvmCallHexAtBlock: (...args: unknown[]) => fetchEvmCallHexAtBlockMock(...args),
  resolveClosestBlockAtOrBeforeTimestamp: (...args: unknown[]) => resolveClosestBlockAtOrBeforeTimestampMock(...args),
}));

vi.mock("../../api/backfill-price-sources", () => ({
  fetchMarketBackfillPriceSeries: (...args: unknown[]) => fetchMarketBackfillPriceSeriesMock(...args),
}));

import {
  fetchAuthoritativeHistoricalPriceSeries,
  fetchAuthoritativeLivePriceOverrides,
} from "../authoritative-price-sources";

const QUOTE_HEX =
  "0x000000000000000000000000000000000000000000000000000000e8d435370b0000000000000000000000000000000000000000000000000000000000000000";
const IUSD_QUOTE_HEX = "0x00000000000000000000000000000000000000000000000000000000000f4240";

describe("authoritative-price-sources", () => {
  beforeEach(() => {
    fetchEvmCallHexAtBlockMock.mockReset();
    resolveClosestBlockAtOrBeforeTimestampMock.mockReset();
    fetchMarketBackfillPriceSeriesMock.mockReset();
  });

  it("returns a live cUSD override from the authoritative redemption quote", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(QUOTE_HEX);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "cusd-cap",
        name: "Cap cUSD",
        symbol: "CUSD",
        circulating: { peggedUSD: 114_000_000 },
      },
      {
        id: "usdt-tether",
        name: "Tether",
        symbol: "USDT",
        circulating: { peggedUSD: 100_000_000_000 },
      },
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      expect.stringMatching(/^0xb7c4a6bf/),
      "latest",
      expect.objectContaining({
        extraRpcUrls: ["https://ethereum-rpc.publicnode.com"],
      }),
    );

    expect(overrides.get("cusd-cap")).toEqual({
      price: 0.99999266,
      source: "protocol-redeem",
      confidence: "high",
    });
    expect(overrides.has("usdt-tether")).toBe(false);
  });

  it("replays historical cUSD prices through the same authoritative provider", async () => {
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValueOnce(22_874_100).mockResolvedValueOnce(22_875_000);
    fetchEvmCallHexAtBlockMock.mockResolvedValue(QUOTE_HEX);

    const result = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "cusd-cap",
        name: "Cap cUSD",
        symbol: "CUSD",
        flags: {
          pegCurrency: "USD",
          backing: "rwa-backed",
          governance: "centralized-dependent",
          yieldBearing: false,
          rwa: false,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_710_000_000, 1_710_086_400],
        supplySnapshots: [
          { ts: 1_710_000_000, supply: 100_000_000 },
          { ts: 1_710_086_400, supply: 105_000_000 },
        ],
      },
    );

    expect(result).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: [
        { timestamp: 1_710_000_000, price: 0.99999266 },
        { timestamp: 1_710_086_400, price: 0.99999266 },
      ],
    });
    expect(resolveClosestBlockAtOrBeforeTimestampMock).toHaveBeenCalledTimes(2);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(2);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenNthCalledWith(
      1,
      "ethereum",
      "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      expect.stringMatching(/^0xb7c4a6bf/),
      22_874_100,
      expect.objectContaining({
        extraRpcUrls: ["https://ethereum-rpc.publicnode.com"],
      }),
    );
  });

  it("returns a live iUSD override from the infiniFi redeem quote", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(IUSD_QUOTE_HEX);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "iusd-infinifi",
        name: "infiniFi USD",
        symbol: "IUSD",
        circulating: { peggedUSD: 180_000_000 },
      },
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0xCb1747E89a43DEdcF4A2b831a0D94859EFeC7601",
      expect.stringMatching(/^0xf308cf65/),
      "latest",
      expect.objectContaining({
        extraRpcUrls: ["https://ethereum-rpc.publicnode.com"],
      }),
    );

    expect(overrides.get("iusd-infinifi")).toEqual({
      price: 1,
      source: "protocol-redeem",
      confidence: "high",
    });
  });

  it("returns a live USDAI override from tracked PYUSD pricing", async () => {
    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "usdai-usd-ai",
        name: "USDai",
        symbol: "USDai",
        circulating: { peggedUSD: 27_000_000 },
      },
      {
        id: "pyusd-paypal",
        name: "PayPal USD",
        symbol: "PYUSD",
        price: 1.00006543,
        priceSource: "coingecko+defillama-list+pyth",
        priceConfidence: "high",
        circulating: { peggedUSD: 880_000_000 },
      },
    ]);

    expect(overrides.get("usdai-usd-ai")).toEqual({
      price: 1.00006543,
      source: "protocol-redeem",
      confidence: "high",
    });
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("returns live inherited overrides for M0 extension assets from tracked wM pricing", async () => {
    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "usdk-kast",
        name: "KAST Dollar",
        symbol: "USDK",
        circulating: { peggedUSD: 24_000_000 },
      },
      {
        id: "xo-exodus",
        name: "XO Cash",
        symbol: "XO",
        circulating: { peggedUSD: 1_600_000 },
      },
      {
        id: "usdnr-nerona",
        name: "Nerona USD",
        symbol: "USDnr",
        circulating: { peggedUSD: 50_000_000 },
      },
      {
        id: "wm-m0",
        name: "Wrapped M",
        symbol: "wM",
        price: 0.99981234,
        priceSource: "coingecko+raydium-dex",
        priceConfidence: "high",
        circulating: { peggedUSD: 93_000_000 },
      },
    ]);

    expect(overrides.get("usdk-kast")).toEqual({
      price: 0.99981234,
      source: "protocol-redeem",
      confidence: "high",
    });
    expect(overrides.get("xo-exodus")).toEqual({
      price: 0.99981234,
      source: "protocol-redeem",
      confidence: "high",
    });
    expect(overrides.get("usdnr-nerona")).toEqual({
      price: 0.99981234,
      source: "protocol-redeem",
      confidence: "high",
    });
  });

  it("replays historical iUSD prices through the infiniFi redeem quote", async () => {
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValueOnce(24_133_673).mockResolvedValueOnce(24_209_239);
    fetchEvmCallHexAtBlockMock.mockResolvedValue(IUSD_QUOTE_HEX);

    const result = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "iusd-infinifi",
        name: "infiniFi USD",
        symbol: "IUSD",
        flags: {
          pegCurrency: "USD",
          backing: "crypto-backed",
          governance: "centralized-dependent",
          yieldBearing: true,
          rwa: false,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_767_196_936, 1_768_107_667],
      },
    );

    expect(result).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: [
        { timestamp: 1_767_196_936, price: 1 },
        { timestamp: 1_768_107_667, price: 1 },
      ],
    });
    expect(resolveClosestBlockAtOrBeforeTimestampMock).toHaveBeenCalledTimes(2);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(2);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenNthCalledWith(
      1,
      "ethereum",
      "0xCb1747E89a43DEdcF4A2b831a0D94859EFeC7601",
      expect.stringMatching(/^0xf308cf65/),
      24_133_673,
      expect.objectContaining({
        extraRpcUrls: ["https://ethereum-rpc.publicnode.com"],
      }),
    );
  });

  it("replays historical USDAI prices from the tracked PYUSD market series", async () => {
    fetchMarketBackfillPriceSeriesMock.mockResolvedValue({
      prices: [
        { timestamp: 1_759_363_200, price: 0.99994 },
        { timestamp: 1_759_366_800, price: 1.00011 },
      ],
      diagnostics: {
        granularity: "hourly",
        sourcesUsed: ["coingecko"],
        quoteMode: "usd",
        quoteCurrency: "usd",
        mergeReasons: [],
        perSourceStats: [],
        policyAdjustments: [],
        finalPointCount: 2,
      },
    });

    const result = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "usdai-usd-ai",
        name: "USDai",
        symbol: "USDai",
        flags: {
          pegCurrency: "USD",
          backing: "rwa-backed",
          governance: "centralized-dependent",
          yieldBearing: false,
          rwa: false,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_759_363_200, 1_759_366_800],
      },
    );

    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenCalledTimes(1);
    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "pyusd-paypal",
        geckoId: "paypal-usd",
      }),
      "paypal-usd",
      {
        granularity: "hourly",
        coingeckoApiKey: null,
      },
    );
    expect(result).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: [
        { timestamp: 1_759_363_200, price: 0.99994 },
        { timestamp: 1_759_366_800, price: 1.00011 },
      ],
    });
  });

  it("replays historical M0 extension prices from the tracked wM market series", async () => {
    fetchMarketBackfillPriceSeriesMock.mockResolvedValue({
      prices: [
        { timestamp: 1_776_000_000, price: 0.99971 },
        { timestamp: 1_776_003_600, price: 1.00006 },
      ],
      diagnostics: {
        granularity: "hourly",
        sourcesUsed: ["coingecko"],
        quoteMode: "usd",
        quoteCurrency: "usd",
        mergeReasons: [],
        perSourceStats: [],
        policyAdjustments: [],
        finalPointCount: 2,
      },
    });

    const usdkResult = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "usdk-kast",
        name: "KAST Dollar",
        symbol: "USDK",
        flags: {
          pegCurrency: "USD",
          backing: "rwa-backed",
          governance: "centralized",
          yieldBearing: false,
          rwa: true,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_776_000_000, 1_776_003_600],
      },
    );
    const xoResult = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "xo-exodus",
        name: "XO Cash",
        symbol: "XO",
        flags: {
          pegCurrency: "USD",
          backing: "rwa-backed",
          governance: "centralized",
          yieldBearing: false,
          rwa: true,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_776_000_000, 1_776_003_600],
      },
    );
    const usdnrResult = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "usdnr-nerona",
        name: "Nerona USD",
        symbol: "USDnr",
        flags: {
          pegCurrency: "USD",
          backing: "rwa-backed",
          governance: "centralized",
          yieldBearing: false,
          rwa: true,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_776_000_000, 1_776_003_600],
      },
    );

    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenCalledTimes(3);
    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: "wm-m0",
        geckoId: "wrappedm-by-m0",
      }),
      "wrappedm-by-m0",
      {
        granularity: "hourly",
        coingeckoApiKey: null,
      },
    );
    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: "wm-m0",
        geckoId: "wrappedm-by-m0",
      }),
      "wrappedm-by-m0",
      {
        granularity: "hourly",
        coingeckoApiKey: null,
      },
    );
    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        id: "wm-m0",
        geckoId: "wrappedm-by-m0",
      }),
      "wrappedm-by-m0",
      {
        granularity: "hourly",
        coingeckoApiKey: null,
      },
    );
    expect(usdkResult).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: [
        { timestamp: 1_776_000_000, price: 0.99971 },
        { timestamp: 1_776_003_600, price: 1.00006 },
      ],
    });
    expect(xoResult).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: [
        { timestamp: 1_776_000_000, price: 0.99971 },
        { timestamp: 1_776_003_600, price: 1.00006 },
      ],
    });
    expect(usdnrResult).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: [
        { timestamp: 1_776_000_000, price: 0.99971 },
        { timestamp: 1_776_003_600, price: 1.00006 },
      ],
    });
  });

  it("passes the CoinGecko API key through authoritative market-history replays", async () => {
    fetchMarketBackfillPriceSeriesMock.mockResolvedValue({
      prices: [
        { timestamp: 1_759_363_200, price: 1 },
      ],
      diagnostics: {
        granularity: "hourly",
        sourcesUsed: ["coingecko"],
        quoteMode: "usd",
        quoteCurrency: "usd",
        mergeReasons: [],
        perSourceStats: [],
        policyAdjustments: [],
        finalPointCount: 1,
      },
    });

    await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "usdai-usd-ai",
        name: "USDai",
        symbol: "USDai",
        flags: {
          pegCurrency: "USD",
          backing: "rwa-backed",
          governance: "centralized-dependent",
          yieldBearing: false,
          rwa: false,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_759_363_200],
        coingeckoApiKey: "cg-pro-key",
      },
    );

    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "pyusd-paypal",
        geckoId: "paypal-usd",
      }),
      "paypal-usd",
      {
        granularity: "hourly",
        coingeckoApiKey: "cg-pro-key",
      },
    );
  });

  it("skips inherited tracked-price overrides when the parent asset is unavailable", async () => {
    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "usdk-kast",
        name: "KAST Dollar",
        symbol: "USDK",
        circulating: { peggedUSD: 24_000_000 },
      },
    ]);

    expect(overrides.has("usdk-kast")).toBe(false);
  });

  it("does not return a crvUSD override (demoted to regular consensus source)", async () => {
    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "crvusd-curve",
        name: "crvUSD",
        symbol: "crvUSD",
        circulating: { peggedUSD: 400_000_000 },
      },
    ]);

    expect(overrides.has("crvusd-curve")).toBe(false);
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("preserves existing backfill rows when authoritative history coverage is too low", async () => {
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValueOnce(22_874_100);
    fetchEvmCallHexAtBlockMock.mockResolvedValue(QUOTE_HEX);

    const result = await fetchAuthoritativeHistoricalPriceSeries(
      {
        id: "cusd-cap",
        name: "Cap cUSD",
        symbol: "CUSD",
        flags: {
          pegCurrency: "USD",
          backing: "rwa-backed",
          governance: "centralized-dependent",
          yieldBearing: false,
          rwa: false,
          navToken: false,
        },
      },
      {
        candidateTimestamps: [1_710_000_000, 1_710_086_400],
      },
    );

    expect(result).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: null,
    });
  });
});
