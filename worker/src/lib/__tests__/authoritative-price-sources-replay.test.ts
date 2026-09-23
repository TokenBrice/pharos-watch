import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  asset,
  fetchEvmCallHexAtBlockMock,
  fetchLiveOverrides,
  freshParent,
  makeHistoricalMeta,
  makeHistoricalPriceSeries,
  resetAuthoritativePriceSourceMocks,
  resolveClosestBlockAtOrBeforeTimestampMock,
  unpricedChild,
} from "./authoritative-price-sources.test-support";

const fetchMarketBackfillPriceSeriesMock = vi.fn();

vi.mock("../../api/backfill-price-sources", () => ({
  fetchMarketBackfillPriceSeries: (...args: unknown[]) => fetchMarketBackfillPriceSeriesMock(...args),
}));

// Import the defining module, not the one-line re-export barrel: critical
// ownership resolves import specifiers to files and does not follow
// re-exports, so this is what keeps the suite in the coverage owner set.
import { fetchAuthoritativeHistoricalPriceSeries } from "../authoritative-price-sources/index";

const QUOTE_HEX =
  "0x000000000000000000000000000000000000000000000000000000e8d435370b0000000000000000000000000000000000000000000000000000000000000000";
const IUSD_QUOTE_HEX = "0x00000000000000000000000000000000000000000000000000000000000f4240";

describe("authoritative-price-sources", () => {
  beforeEach(() => {
    resetAuthoritativePriceSourceMocks();
    fetchMarketBackfillPriceSeriesMock.mockReset();
  });

  it("replays historical cUSD prices through the same authoritative provider", async () => {
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValueOnce(22_874_100).mockResolvedValueOnce(22_875_000);
    fetchEvmCallHexAtBlockMock.mockResolvedValue(QUOTE_HEX);

    const result = await fetchAuthoritativeHistoricalPriceSeries(
      makeHistoricalMeta("cusd-cap", "Cap cUSD", "CUSD", {
        flags: {
          governance: "centralized-dependent",
        },
      }),
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
        extraRpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
      }),
    );
  });

  it("returns matched null historical prices when the authoritative provider fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    resolveClosestBlockAtOrBeforeTimestampMock.mockRejectedValue(new Error("rpc index down"));

    const result = await fetchAuthoritativeHistoricalPriceSeries(
      makeHistoricalMeta("cusd-cap", "Cap cUSD", "CUSD", {
        flags: {
          governance: "centralized-dependent",
        },
      }),
      {
        candidateTimestamps: [1_710_000_000],
        supplySnapshots: [{ ts: 1_710_000_000, supply: 100_000_000 }],
      },
    );

    expect(result).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: null,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[authoritative-price-sources] cusd-cap historical source failed:"),
    );
    warnSpy.mockRestore();
  });

  it("returns a live iUSD override from the infiniFi redeem quote", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(IUSD_QUOTE_HEX);

    const overrides = await fetchLiveOverrides([
      asset("iusd-infinifi", { circulating: { peggedUSD: 180_000_000 } }),
    ]);

    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum",
      "0xCb1747E89a43DEdcF4A2b831a0D94859EFeC7601",
      expect.stringMatching(/^0xf308cf65/),
      "latest",
      expect.objectContaining({
        extraRpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
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
    const overrides = await fetchLiveOverrides([
      asset("usdai-usd-ai", { circulating: { peggedUSD: 27_000_000 } }),
      freshParent("pyusd-paypal", 1.00006543, "coingecko+defillama-list+pyth", {
        nowSec,
        circulating: { peggedUSD: 880_000_000 },
      }),
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
    const overrides = await fetchLiveOverrides([
      asset("m-m0", { circulating: { peggedUSD: 299_000_000 } }),
      asset("usdk-kast", { circulating: { peggedUSD: 24_000_000 } }),
      asset("xo-exodus", { circulating: { peggedUSD: 1_600_000 } }),
      asset("usdnr-nerona", { circulating: { peggedUSD: 50_000_000 } }),
      freshParent("wm-m0", 0.99981234, "coingecko+raydium-dex", {
        nowSec,
        circulating: { peggedUSD: 93_000_000 },
      }),
    ]);

    expect(overrides.get("m-m0")).toMatchObject({
      price: 0.99981234,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: nowSec - 60,
      metadata: {
        inheritedFrom: "wm-m0",
        parentReplaySafe: true,
      },
    });
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
    const overrides = await fetchLiveOverrides([
      asset("iusd-initia", { circulating: { peggedUSD: 54_000_000 } }),
      asset("usdcx-movement", { circulating: { peggedUSD: 6_000_000 } }),
      asset("weusd-picwe", { circulating: { peggedUSD: 500_000 } }),
      freshParent("ausd-agora", 1.000012, "coingecko+pyth", {
        nowSec,
        circulating: { peggedUSD: 120_000_000 },
      }),
      freshParent("usdc-circle", 0.99998, "coingecko+pyth", {
        nowSec,
        circulating: { peggedUSD: 61_000_000_000 },
      }),
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
    expect(overrides.get("weusd-picwe")).toMatchObject({
      price: 0.9899802,
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "usdc-circle",
        parentReplaySafe: true,
      },
    });
  });

  it("preserves a usable WEUSD market quote instead of applying the redemption floor", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchLiveOverrides([
      freshParent("weusd-picwe", 0.91, "coingecko", { nowSec }),
      freshParent("usdc-circle", 0.99998, "coingecko+pyth", { nowSec }),
    ]);

    expect(overrides.has("weusd-picwe")).toBe(false);
  });

  it("re-derives the WEUSD fallback when the incumbent market quote is stale restored data", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchLiveOverrides([
      // A restored row keeps its original observation time for up to seven
      // days while priceSyncedAt moves to the current run, so only the
      // observation age can disqualify it from the market-price-wins guard.
      freshParent("weusd-picwe", 0.91, "coingecko", { nowSec, observedAt: nowSec - 6 * 86400 }),
      freshParent("usdc-circle", 0.99998, "coingecko+pyth", { nowSec }),
    ]);

    expect(overrides.get("weusd-picwe")).toMatchObject({
      price: 0.9899802,
      source: "protocol-redeem",
      confidence: "high",
      metadata: { inheritedFrom: "usdc-circle" },
    });
  });

  it.each([
    ["protocol-derived", "protocol-redeem"],
    ["cached replay", "cached"],
    ["unregistered", "not-a-registered-source"],
  ])("treats a fresh %s incumbent as a non-market WEUSD price", async (_kind, incumbentSource) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchLiveOverrides([
      freshParent("weusd-picwe", 0.99, incumbentSource, { nowSec }),
      freshParent("usdc-circle", 0.99998, "coingecko+pyth", { nowSec }),
    ]);

    expect(overrides.get("weusd-picwe")).toMatchObject({
      price: 0.9899802,
      source: "protocol-redeem",
      metadata: { inheritedFrom: "usdc-circle" },
    });
  });

  it("returns protocol-par live overrides only for active direct-redeem fiat assets", async () => {
    const overrides = await fetchLiveOverrides(
      [
        asset("sofid-sofi", { circulating: { peggedUSD: 100_000_000 } }),
        asset("usbd-bima", { circulating: { peggedUSD: 7_500_000 } }),
        asset("usdq-quill", { circulating: { peggedUSD: 130_000 } }),
        asset("chfau-allunity", { circulating: { peggedCHF: 6_300_000 } }),
        asset("cadd-cad-digital", { circulating: { peggedCAD: 390_000 } }),
        asset("jpym-mento", { circulating: { peggedJPY: 104_000 } }),
        asset("zarm-mento", { circulating: { peggedZAR: 8_600 } }),
        asset("xofm-mento", { circulating: { peggedXOF: 32_000 } }),
      ],
      undefined,
      {
        rates: {
          peggedCHF: 1.27,
          peggedCAD: 0.73,
          peggedJPY: 0.00628,
          peggedZAR: 0.0608,
          peggedXOF: 0.00172,
        },
        type: "fresh",
        updatedAt: 1_778_000_000,
        updatedAtByPeg: {
          peggedCHF: 1_778_000_000,
          peggedCAD: 1_778_000_001,
          peggedJPY: 1_778_000_002,
          peggedZAR: 1_778_000_003,
          peggedXOF: 1_778_000_004,
        },
        typeByPeg: {
          peggedCHF: "fresh",
          peggedCAD: "fresh",
          peggedJPY: "fresh",
          peggedZAR: "fresh",
          peggedXOF: "fresh",
        },
      },
    );

    expect(overrides.has("sofid-sofi")).toBe(false);
    expect(overrides.get("usbd-bima")).toMatchObject({
      price: 1,
      source: "protocol-redeem",
      confidence: "high",
    });
    expect(overrides.get("usdq-quill")).toMatchObject({
      price: 1,
      source: "protocol-redeem",
      confidence: "high",
    });
    expect(overrides.get("chfau-allunity")).toMatchObject({
      price: 1.27,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: 1_778_000_000,
      observedAtMode: "upstream",
    });
    expect(overrides.get("cadd-cad-digital")).toMatchObject({
      price: 0.73,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: 1_778_000_001,
      observedAtMode: "upstream",
    });
    expect(overrides.get("jpym-mento")).toMatchObject({
      price: 0.00628,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: 1_778_000_002,
      observedAtMode: "upstream",
    });
    expect(overrides.get("zarm-mento")).toMatchObject({
      price: 0.0608,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: 1_778_000_003,
      observedAtMode: "upstream",
    });
    expect(overrides.get("xofm-mento")).toMatchObject({
      price: 0.00172,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: 1_778_000_004,
      observedAtMode: "upstream",
    });
  });

  it("skips CHF protocol-par overrides when the FX reference is missing or stale", async () => {
    const stale = await fetchLiveOverrides(
      [
        asset("chfau-allunity", { circulating: { peggedCHF: 6_300_000 } }),
      ],
      undefined,
      {
        rates: { peggedCHF: 1.27 },
        type: "stale",
        updatedAt: 1_778_000_000,
        updatedAtByPeg: { peggedCHF: 1_778_000_000 },
        typeByPeg: { peggedCHF: "stale" },
      },
    );
    const missing = await fetchLiveOverrides([
      asset("chfau-allunity", { circulating: { peggedCHF: 6_300_000 } }),
    ]);

    expect(stale.has("chfau-allunity")).toBe(false);
    expect(missing.has("chfau-allunity")).toBe(false);
  });

  it("labels static CHF protocol-par overrides as local fetches", async () => {
    const overrides = await fetchLiveOverrides(
      [
        asset("chfau-allunity", { circulating: { peggedCHF: 6_300_000 } }),
      ],
      undefined,
      {
        rates: { peggedCHF: 1.25 },
        type: "static",
        updatedAt: null,
        typeByPeg: { peggedCHF: "static" },
      },
    );

    expect(overrides.get("chfau-allunity")).toMatchObject({
      price: 1.25,
      source: "protocol-redeem",
      confidence: "high",
      observedAt: null,
      observedAtMode: "local_fetch",
    });
  });

  it("does not claim authoritative historical protocol-par coverage for CHF parity", async () => {
    const result = await fetchAuthoritativeHistoricalPriceSeries(
      makeHistoricalMeta("chfau-allunity", "AllUnity CHF", "CHFAU", {
        flags: {
          pegCurrency: "CHF",
          governance: "centralized",
          rwa: true,
        },
      }),
      {
        candidateTimestamps: [1_778_000_000],
      },
    );

    expect(result).toEqual({
      matched: false,
      source: null,
      prices: null,
    });
  });

  it("replays historical iUSD prices through the infiniFi redeem quote", async () => {
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValueOnce(24_133_673).mockResolvedValueOnce(24_209_239);
    fetchEvmCallHexAtBlockMock.mockResolvedValue(IUSD_QUOTE_HEX);

    const result = await fetchAuthoritativeHistoricalPriceSeries(
      makeHistoricalMeta("iusd-infinifi", "infiniFi USD", "IUSD", {
        flags: {
          backing: "crypto-backed",
          governance: "centralized-dependent",
          yieldBearing: true,
        },
      }),
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
        extraRpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
      }),
    );
  });

  it("replays historical USDAI prices from the tracked PYUSD market series", async () => {
    fetchMarketBackfillPriceSeriesMock.mockResolvedValue(
      makeHistoricalPriceSeries([
        { timestamp: 1_759_363_200, price: 0.99994 },
        { timestamp: 1_759_366_800, price: 1.00011 },
      ]),
    );

    const result = await fetchAuthoritativeHistoricalPriceSeries(
      makeHistoricalMeta("usdai-usd-ai", "USDai", "USDai", {
        flags: {
          governance: "centralized-dependent",
        },
      }),
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

  it.each([
    ["usdk-kast", "KAST Dollar", "USDK"],
    ["xo-exodus", "XO Cash", "XO"],
    ["usdnr-nerona", "Nerona USD", "USDnr"],
    ["m-m0", "M by M0", "M"],
  ])("replays historical %s prices from the tracked wM market series", async (id, name, symbol) => {
    fetchMarketBackfillPriceSeriesMock.mockResolvedValue(
      makeHistoricalPriceSeries([
        { timestamp: 1_776_000_000, price: 0.99971 },
        { timestamp: 1_776_003_600, price: 1.00006 },
      ]),
    );

    const result = await fetchAuthoritativeHistoricalPriceSeries(
      makeHistoricalMeta(id, name, symbol, {
        flags: {
          governance: "centralized",
          rwa: true,
        },
      }),
      {
        candidateTimestamps: [1_776_000_000, 1_776_003_600],
      },
    );
    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenCalledTimes(1);
    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenCalledWith(
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
    expect(result).toEqual({
      matched: true,
      source: "protocol-redeem",
      prices: [
        { timestamp: 1_776_000_000, price: 0.99971 },
        { timestamp: 1_776_003_600, price: 1.00006 },
      ],
    });
  });

  it("leaves WEUSD historical replay to market-price sources", async () => {
    const result = await fetchAuthoritativeHistoricalPriceSeries(
      makeHistoricalMeta("weusd-picwe", "Wrapped eUSD", "WEUSD"),
      {
        candidateTimestamps: [1_776_000_000, 1_776_003_600],
      },
    );

    expect(result).toEqual({
      matched: false,
      source: null,
      prices: null,
    });
    expect(fetchMarketBackfillPriceSeriesMock).not.toHaveBeenCalled();
  });

  it("passes the CoinGecko API key through authoritative market-history replays", async () => {
    fetchMarketBackfillPriceSeriesMock.mockResolvedValue(
      makeHistoricalPriceSeries([{ timestamp: 1_759_363_200, price: 1 }]),
    );

    await fetchAuthoritativeHistoricalPriceSeries(
      makeHistoricalMeta("usdai-usd-ai", "USDai", "USDai", {
        flags: {
          governance: "centralized-dependent",
        },
      }),
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
    const overrides = await fetchLiveOverrides([
      asset("usdk-kast", { circulating: { peggedUSD: 24_000_000 } }),
    ]);

    expect(overrides.has("usdk-kast")).toBe(false);
  });

  it("skips inherited tracked-price overrides when the parent price is low confidence, cached, stale, or missing provenance", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const child = asset("usdk-kast", { circulating: { peggedUSD: 24_000_000 } });

    for (const parent of [
      freshParent("wm-m0", 0.9998, "coingecko+pyth", { nowSec, priceConfidence: "low" }),
      freshParent("wm-m0", 0.9998, "cached", { nowSec }),
      freshParent("wm-m0", 0.9998, "coingecko+pyth", { nowSec, observedAt: nowSec - 1_000 }),
      asset("wm-m0", {
        price: 0.9998,
        priceConfidence: "high",
        priceObservedAt: nowSec - 60,
        priceObservedAtMode: "upstream",
      }),
    ]) {
      const overrides = await fetchLiveOverrides([child, parent]);
      expect(overrides.has("usdk-kast")).toBe(false);
    }

    warnSpy.mockRestore();
  });

  it("allows inherited tracked-price overrides from a fresh protocol-authoritative parent", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchLiveOverrides([
      asset("usdk-kast", { circulating: { peggedUSD: 24_000_000 } }),
      freshParent("wm-m0", 0.9998, "protocol-redeem", {
        nowSec,
        priceConfidence: "single-source",
        priceObservedAtMode: "local_fetch",
      }),
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

  it("allows scoped M0 wrappers to inherit a fresh high-confidence address-composite parent", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchLiveOverrides([
      asset("usdk-kast", { circulating: { peggedUSD: 24_000_000 } }),
      asset("xo-exodus", { circulating: { peggedUSD: 2_400_000 } }),
      asset("m-m0", { circulating: { peggedUSD: 300_000_000 } }),
      freshParent("wm-m0", 0.9998, "alchemy-address+coingecko+coingecko-onchain-address+moralis-address", {
        nowSec,
        priceObservedAtMode: "local_fetch",
      }),
    ]);

    expect(overrides.get("usdk-kast")).toMatchObject({
      price: 0.9998,
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "wm-m0",
        parentReplaySafe: false,
      },
    });
    expect(overrides.get("xo-exodus")).toMatchObject({
      price: 0.9998,
      source: "protocol-redeem",
      confidence: "high",
      metadata: {
        inheritedFrom: "wm-m0",
        parentReplaySafe: false,
      },
    });
    expect(overrides.has("m-m0")).toBe(false);
  });

  it("keeps scoped M0 wrapper overrides single-source when inheriting a fresh replay-safe single-source parent", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchLiveOverrides([
      asset("m-m0", { circulating: { peggedUSD: 300_000_000 } }),
      asset("usdk-kast", { circulating: { peggedUSD: 24_000_000 } }),
      asset("xo-exodus", { circulating: { peggedUSD: 2_400_000 } }),
      freshParent("wm-m0", 0.999674, "coingecko", {
        nowSec,
        priceConfidence: "single-source",
      }),
    ]);

    expect(overrides.get("m-m0")).toMatchObject({
      price: 0.999674,
      source: "coingecko",
      confidence: "single-source",
      metadata: {
        inheritedFrom: "wm-m0",
        parentSource: "coingecko",
        parentConfidence: "single-source",
        parentReplaySafe: true,
      },
    });
    expect(overrides.get("usdk-kast")).toMatchObject({
      price: 0.999674,
      source: "coingecko",
      confidence: "single-source",
      metadata: {
        inheritedFrom: "wm-m0",
        parentSource: "coingecko",
        parentConfidence: "single-source",
        parentReplaySafe: true,
      },
    });
    expect(overrides.get("xo-exodus")).toMatchObject({
      price: 0.999674,
      source: "coingecko",
      confidence: "single-source",
      metadata: {
        inheritedFrom: "wm-m0",
        parentSource: "coingecko",
        parentConfidence: "single-source",
        parentReplaySafe: true,
      },
    });
  });

  it("allows Noble USDN to inherit a fresh replay-safe M parent", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchLiveOverrides([
      asset("usdn-noble", { circulating: { peggedUSD: 4_000_000 } }),
      freshParent("m-m0", 0.999766, "defillama-contract", {
        nowSec,
        priceConfidence: "single-source",
      }),
    ]);

    expect(overrides.get("usdn-noble")).toMatchObject({
      price: 0.999766,
      source: "defillama-contract",
      confidence: "single-source",
      metadata: {
        inheritedFrom: "m-m0",
        parentSource: "defillama-contract",
        parentConfidence: "single-source",
        parentReplaySafe: true,
      },
    });
  });

  it("resolves a same-run wM -> M -> Noble USDN dependency chain", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchLiveOverrides([
      unpricedChild("m-m0"),
      unpricedChild("usdn-noble"),
      freshParent("wm-m0", 0.999812, "coingecko", {
        nowSec,
        priceConfidence: "single-source",
      }),
    ]);

    expect(overrides.get("m-m0")).toMatchObject({
      price: 0.999812,
      source: "coingecko",
      confidence: "single-source",
      metadata: {
        inheritedFrom: "wm-m0",
        parentReplaySafe: true,
      },
    });
    expect(overrides.get("usdn-noble")).toMatchObject({
      price: 0.999812,
      source: "coingecko",
      confidence: "single-source",
      metadata: {
        inheritedFrom: "m-m0",
        parentReplaySafe: true,
      },
    });
  });

  it("does not return a crvUSD override (demoted to regular consensus source)", async () => {
    const overrides = await fetchLiveOverrides([
      asset("crvusd-curve", { circulating: { peggedUSD: 400_000_000 } }),
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
