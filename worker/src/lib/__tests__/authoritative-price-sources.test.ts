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
      "ausd-agora",
      {
        id: "ausd-agora",
        geckoId: "agora-dollar",
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
    const nowSec = Math.floor(Date.now() / 1000);
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
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
        circulating: { peggedUSD: 880_000_000 },
      },
    ]);

    expect(overrides.get("usdai-usd-ai")).toEqual({
      price: 1.00006543,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: nowSec - 60,
      observedAtMode: "upstream",
      metadata: {
        inheritedFrom: "pyusd-paypal",
        parentSource: "coingecko+defillama-list+pyth",
        parentConfidence: "high",
        parentObservedAt: nowSec - 60,
        parentObservedAtMode: "upstream",
        parentReplaySafe: true,
      },
    });
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("returns live inherited overrides for M0 extension assets from tracked wM pricing", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
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
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
        circulating: { peggedUSD: 93_000_000 },
      },
    ]);

    expect(overrides.get("usdk-kast")).toMatchObject({
      price: 0.99981234,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: nowSec - 60,
      metadata: {
        inheritedFrom: "wm-m0",
        parentReplaySafe: true,
      },
    });
    expect(overrides.get("xo-exodus")).toMatchObject({
      price: 0.99981234,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: nowSec - 60,
      metadata: {
        inheritedFrom: "wm-m0",
        parentReplaySafe: true,
      },
    });
    expect(overrides.get("usdnr-nerona")).toMatchObject({
      price: 0.99981234,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: nowSec - 60,
      metadata: {
        inheritedFrom: "wm-m0",
        parentReplaySafe: true,
      },
    });
  });

  it("returns live inherited overrides for AUSD and USDC extension assets", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "iusd-initia",
        name: "Initia iUSD",
        symbol: "iUSD",
        circulating: { peggedUSD: 54_000_000 },
      },
      {
        id: "usdcx-movement",
        name: "Movement USDCx",
        symbol: "USDCx",
        circulating: { peggedUSD: 6_000_000 },
      },
      {
        id: "ausd-agora",
        name: "Agora AUSD",
        symbol: "AUSD",
        price: 1.000012,
        priceSource: "coingecko+pyth",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
        circulating: { peggedUSD: 120_000_000 },
      },
      {
        id: "usdc-circle",
        name: "USDC",
        symbol: "USDC",
        price: 0.99998,
        priceSource: "coingecko+pyth",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
        circulating: { peggedUSD: 61_000_000_000 },
      },
    ]);

    expect(overrides.get("iusd-initia")).toMatchObject({
      price: 1.000012,
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "ausd-agora",
        parentReplaySafe: true,
      },
    });
    expect(overrides.get("usdcx-movement")).toMatchObject({
      price: 0.99998,
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "usdc-circle",
        parentReplaySafe: true,
      },
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
      prices: [{ timestamp: 1_759_363_200, price: 1 }],
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

  it("skips inherited tracked-price overrides when the parent price is low confidence, cached, stale, or missing provenance", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const child = {
      id: "usdk-kast",
      name: "KAST Dollar",
      symbol: "USDK",
      circulating: { peggedUSD: 24_000_000 },
    };

    for (const parent of [
      {
        id: "wm-m0",
        name: "Wrapped M",
        symbol: "wM",
        price: 0.9998,
        priceSource: "coingecko+pyth",
        priceConfidence: "low" as const,
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream" as const,
      },
      {
        id: "wm-m0",
        name: "Wrapped M",
        symbol: "wM",
        price: 0.9998,
        priceSource: "cached",
        priceConfidence: "high" as const,
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream" as const,
      },
      {
        id: "wm-m0",
        name: "Wrapped M",
        symbol: "wM",
        price: 0.9998,
        priceSource: "coingecko+pyth",
        priceConfidence: "high" as const,
        priceObservedAt: nowSec - 1_000,
        priceObservedAtMode: "upstream" as const,
      },
      {
        id: "wm-m0",
        name: "Wrapped M",
        symbol: "wM",
        price: 0.9998,
        priceConfidence: "high" as const,
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream" as const,
      },
    ]) {
      const overrides = await fetchAuthoritativeLivePriceOverrides([child, parent]);
      expect(overrides.has("usdk-kast")).toBe(false);
    }

    warnSpy.mockRestore();
  });

  it("allows inherited tracked-price overrides from a fresh protocol-authoritative parent", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "usdk-kast",
        name: "KAST Dollar",
        symbol: "USDK",
        circulating: { peggedUSD: 24_000_000 },
      },
      {
        id: "wm-m0",
        name: "Wrapped M",
        symbol: "wM",
        price: 0.9998,
        priceSource: "protocol-redeem",
        priceConfidence: "single-source",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "local_fetch",
      },
    ]);

    expect(overrides.get("usdk-kast")).toMatchObject({
      price: 0.9998,
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "wm-m0",
        parentSource: "protocol-redeem",
        parentConfidence: "single-source",
        parentReplaySafe: true,
      },
    });
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

  it("prices an ERC-4626 NAV vault from convertToAssets() x parent price", async () => {
    // convertToAssets(10^18 gtUSDC shares) -> 1_010_000 USDC (1.01 per share)
    const oneShareUsdcRaw = 1_010_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${oneShareUsdcRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "gtusdc-gauntlet",
        name: "Gauntlet USDC Core",
        symbol: "gtUSDC",
        circulating: { peggedUSD: 128_000_000 },
      },
      {
        id: "usdc-circle",
        name: "USDC",
        symbol: "USDC",
        price: 0.9999,
        priceSource: "coingecko+pyth",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
      },
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0xdd0f28e19c1780eb6396170735d45153d261490d",
      expect.stringMatching(/^0x07a2d13a/),
      "latest",
      expect.any(Object),
    );

    const override = overrides.get("gtusdc-gauntlet");
    expect(override).toMatchObject({
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "usdc-circle",
        parentSource: "coingecko+pyth",
        parentConfidence: "high",
      },
    });
    // 1.01 assets per share * $0.9999 parent = ~$1.009899
    expect(override?.price).toBeCloseTo(1.01 * 0.9999, 4);
  });

  it("prices audited ERC-4626 NAV vaults from their configured parent assets", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const cases = [
      {
        id: "susdt-spark",
        parentId: "usdt-tether",
        parentSymbol: "USDT",
        vault: "0xe2e7a17dff93280dec073c995595155283e3c372",
        chain: "ethereum",
        outputRaw: 1_020_856n,
        expectedRatio: 1.020856,
      },
      {
        id: "susdc-spark",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0x28b3a8fb53b741a8fd78c0fb9a6b2393d896a43d",
        chain: "ethereum",
        outputRaw: 1_022_324n,
        expectedRatio: 1.022324,
      },
      {
        id: "gtusdcp-gauntlet",
        parentId: "usdc-circle",
        parentSymbol: "USDC",
        vault: "0x8c106eedad96553e64287a5a6839c3cc78afa3d0",
        chain: "ethereum",
        outputRaw: 1_021_717n,
        expectedRatio: 1.021717,
      },
      {
        id: "steakusdt-steakhouse",
        parentId: "usdt-tether",
        parentSymbol: "USDT",
        vault: "0xbeef003c68896c7d2c3c60d363e8d71a49ab2bf9",
        chain: "ethereum",
        outputRaw: 1_013_670n,
        expectedRatio: 1.01367,
      },
      {
        id: "srusde-strata",
        parentId: "usde-ethena",
        parentSymbol: "USDe",
        vault: "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003",
        chain: "ethereum",
        outputRaw: 1_020_871_205_300_000_000n,
        expectedRatio: 1.0208712,
      },
      {
        id: "sbold-k3-capital",
        parentId: "bold-liquity",
        parentSymbol: "BOLD",
        vault: "0x50bd66d59911f5e086ec87ae43c811e0d059dd11",
        chain: "ethereum",
        outputRaw: 1_041_000_000_000_000_000n,
        expectedRatio: 1.041,
      },
      {
        id: "ybold-yearn",
        parentId: "bold-liquity",
        parentSymbol: "BOLD",
        vault: "0x9f4330700a36b29952869fac9b33f45eedd8a3d8",
        chain: "ethereum",
        outputRaw: 1_000_000_000_000_000_000n,
        expectedRatio: 1,
      },
    ];

    for (const testCase of cases) {
      fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${testCase.outputRaw.toString(16).padStart(64, "0")}`);

      const overrides = await fetchAuthoritativeLivePriceOverrides([
        {
          id: testCase.id,
          name: testCase.id,
          symbol: testCase.id,
          circulating: { peggedUSD: 1_000_000 },
        },
        {
          id: testCase.parentId,
          name: testCase.parentSymbol,
          symbol: testCase.parentSymbol,
          price: 1,
          priceSource: "coingecko+pyth",
          priceConfidence: "high",
          priceObservedAt: nowSec - 60,
          priceObservedAtMode: "upstream",
        },
      ]);

      expect(fetchEvmCallHexAtBlockMock).toHaveBeenLastCalledWith(
        testCase.chain,
        testCase.vault,
        expect.stringMatching(/^0x07a2d13a/),
        "latest",
        expect.any(Object),
      );
      expect(overrides.get(testCase.id)).toMatchObject({
        source: "protocol-redeem",
        confidence: "high",
        metadata: {
          inheritedFrom: testCase.parentId,
        },
      });
      expect(overrides.get(testCase.id)?.price).toBeCloseTo(testCase.expectedRatio, 6);
    }
  });

  it("prices legacy Aave sGHO from previewRedeem() x tracked GHO price", async () => {
    const oneGhoRaw = 1_000_000_000_000_000_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${oneGhoRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "sgho-aave",
        name: "Aave Savings GHO",
        symbol: "sGHO",
        circulating: { peggedUSD: 4_000_000 },
      },
      {
        id: "gho-aave",
        name: "GHO",
        symbol: "GHO",
        price: 0.9997,
        priceSource: "coingecko+pyth",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
      },
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0x1a88df1cfe15af22b3c4c783d4e6f7f9e0c1885d",
      expect.stringMatching(/^0x4cdad506/),
      "latest",
      expect.any(Object),
    );
    expect(overrides.get("sgho-aave")).toMatchObject({
      price: 0.9997,
      source: "protocol-redeem",
      confidence: "high",
      metadata: { inheritedFrom: "gho-aave" },
    });
  });

  it("skips ERC-4626 NAV override when parent price is stale or untrusted", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "gtusdc-gauntlet",
        name: "Gauntlet USDC Core",
        symbol: "gtUSDC",
        circulating: { peggedUSD: 128_000_000 },
      },
      {
        id: "usdc-circle",
        name: "USDC",
        symbol: "USDC",
        price: 0.9999,
        priceSource: "coingecko+pyth",
        priceConfidence: "low",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
      },
    ]);

    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
    expect(overrides.has("gtusdc-gauntlet")).toBe(false);
    warnSpy.mockRestore();
  });

  it("prices an Idle CDO senior tranche from virtualPrice() x parent USDC price", async () => {
    // virtualPrice returns 1_081_076 (= 1.081076 USDC per AA share, 6 decimals)
    const virtualPriceRaw = 1_081_076n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${virtualPriceRaw}`);
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "aa-falconx-mev-capital",
        name: "MEV Capital Falcon USDC Senior Tranche",
        symbol: "AA_FalconXUSDC",
        circulating: { peggedUSD: 117_450_000 },
      },
      {
        id: "usdc-circle",
        name: "USDC",
        symbol: "USDC",
        price: 0.9999,
        priceSource: "coingecko+pyth",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
      },
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0x433d5b175148da32ffe1e1a37a939e1b7e79be4d",
      expect.stringMatching(new RegExp("^0x9290d427000000000000000000000000c26a6fa2c37b38e549a4a1807543801db684f99c$")),
      "latest",
      expect.any(Object),
    );

    const override = overrides.get("aa-falconx-mev-capital");
    expect(override).toMatchObject({
      source: "protocol-redeem",
      confidence: "high",
      metadata: { inheritedFrom: "usdc-circle" },
    });
    expect(override?.price).toBeCloseTo(1.081076 * 0.9999, 4);
  });

  it("rejects ERC-4626 NAV override when convertToAssets ratio is outside trusted bounds", async () => {
    // convertToAssets returns 100x the share amount — should be rejected
    const insaneRaw = 100_000_000n.toString(16).padStart(64, "0");
    fetchEvmCallHexAtBlockMock.mockResolvedValueOnce(`0x${insaneRaw}`);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nowSec = Math.floor(Date.now() / 1000);

    const overrides = await fetchAuthoritativeLivePriceOverrides([
      {
        id: "gtusdc-gauntlet",
        name: "Gauntlet USDC Core",
        symbol: "gtUSDC",
        circulating: { peggedUSD: 128_000_000 },
      },
      {
        id: "usdc-circle",
        name: "USDC",
        symbol: "USDC",
        price: 0.9999,
        priceSource: "coingecko+pyth",
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
      },
    ]);

    expect(overrides.has("gtusdc-gauntlet")).toBe(false);
    warnSpy.mockRestore();
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
