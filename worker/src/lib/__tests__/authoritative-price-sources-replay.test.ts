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

import { getProtocolParPriceOverride } from "../authoritative-price-sources/protocol-par";
import { m0ExtensionProvider } from "../authoritative-price-sources/m0-extension";

const fetchMarketBackfillPriceSeriesMock = vi.fn();

vi.mock("../historical-market-prices", () => ({
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
    fetchMarketBackfillPriceSeriesMock.mockResolvedValue(makeHistoricalPriceSeries([
      { timestamp: 1_710_000_000, price: 1 }, { timestamp: 1_710_086_400, price: 1 },
    ]));
    const result = await fetchAuthoritativeHistoricalPriceSeries(
      makeHistoricalMeta("cusd-cap", "Cap cUSD", "CUSD", { flags: { governance: "centralized-dependent" } }),
      { candidateTimestamps: [1_710_000_000, 1_710_086_400], supplySnapshots: [{ ts: 1_710_000_000, supply: 100_000_000 }, { ts: 1_710_086_400, supply: 105_000_000 }] },
    );
    expect(result).toEqual({
      matched: true, source: "protocol-redeem",
      prices: [{ timestamp: 1_710_000_000, price: 0.99999266 }, { timestamp: 1_710_086_400, price: 0.99999266 }],
    });
    expect(resolveClosestBlockAtOrBeforeTimestampMock).toHaveBeenCalledTimes(2);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(2);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenNthCalledWith(
      1, "ethereum", "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc", expect.stringMatching(/^0xb7c4a6bf/), 22_874_100,
      expect.objectContaining({ extraRpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"] }),
    );
  });

  it("returns matched null historical prices when the authoritative provider fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    resolveClosestBlockAtOrBeforeTimestampMock.mockRejectedValue(new Error("rpc index down"));
    fetchMarketBackfillPriceSeriesMock.mockResolvedValue(makeHistoricalPriceSeries([{ timestamp: 1_710_000_000, price: 1 }]));
    const result = await fetchAuthoritativeHistoricalPriceSeries(
      makeHistoricalMeta("cusd-cap", "Cap cUSD", "CUSD", { flags: { governance: "centralized-dependent" } }),
      { candidateTimestamps: [1_710_000_000], supplySnapshots: [{ ts: 1_710_000_000, supply: 100_000_000 }] },
    );
    expect(result).toEqual({ matched: true, source: "protocol-redeem", prices: null });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[authoritative-price-sources] cusd-cap historical source failed:"));
    warnSpy.mockRestore();
  });

  it("returns a live iUSD override from the infiniFi redeem quote", async () => {
    fetchEvmCallHexAtBlockMock.mockResolvedValue(IUSD_QUOTE_HEX);
    const overrides = await fetchLiveOverrides([
      asset("iusd-infinifi", { circulating: { peggedUSD: 180_000_000 } }),
      freshParent("usdc-circle", 1, "coingecko+pyth"),
    ]);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(1);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledWith(
      "ethereum", "0xCb1747E89a43DEdcF4A2b831a0D94859EFeC7601", expect.stringMatching(/^0xf308cf65/), "latest",
      expect.objectContaining({ extraRpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"] }),
    );
    expect(overrides.get("iusd-infinifi")).toMatchObject({ price: 1, source: "protocol-redeem", confidence: "high" });
  });

  it("returns a live USDAI override from tracked PYUSD pricing", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchLiveOverrides([
      asset("usdai-usd-ai", { circulating: { peggedUSD: 27_000_000 } }),
      freshParent("pyusd-paypal", 1.00006543, "coingecko+defillama-list+pyth", { nowSec, circulating: { peggedUSD: 880_000_000 } }),
    ]);
    expect(overrides.get("usdai-usd-ai")).toEqual({
      price: 1.00006543, source: "protocol-redeem", confidence: "high", observedAt: nowSec - 60, observedAtMode: "upstream",
      metadata: {
        inheritedFrom: "pyusd-paypal", parentSource: "coingecko+defillama-list+pyth",
        parentConfidence: "high", parentObservedAt: nowSec - 60, parentObservedAtMode: "upstream", parentReplaySafe: true,
      },
    });
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();
  });

  it("returns live inherited overrides for M0 extension assets from tracked M pricing", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const ids = ["wm-m0", "usdk-kast", "xo-exodus", "usdnr-nerona"] as const;
    const overrides = await fetchLiveOverrides([
      ...ids.map((id) => asset(id, { circulating: { peggedUSD: 24_000_000 } })),
      freshParent("m-m0", 0.99981234, "coingecko+raydium-dex", { nowSec, circulating: { peggedUSD: 283_000_000 } }),
    ]);
    for (const id of ids) {
      expect(overrides.get(id)).toMatchObject({
        price: 0.99981234, source: "protocol-redeem", confidence: "high", observedAt: nowSec - 60,
        metadata: { inheritedFrom: "m-m0", parentReplaySafe: true },
      });
    }
  });

  it("returns live inherited overrides for AUSD and USDC extension assets", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const overrides = await fetchLiveOverrides([
      asset("iusd-initia", { circulating: { peggedUSD: 54_000_000 } }),
      asset("usdcx-movement", { circulating: { peggedUSD: 6_000_000 } }),
      asset("weusd-picwe", { circulating: { peggedUSD: 500_000 } }),
      freshParent("ausd-agora", 1.000012, "coingecko+pyth", { nowSec, circulating: { peggedUSD: 120_000_000 } }),
      freshParent("usdc-circle", 0.99998, "coingecko+pyth", { nowSec, circulating: { peggedUSD: 61_000_000_000 } }),
    ]);
    for (const [id, price, parent] of [["iusd-initia", 1.000012, "ausd-agora"], ["usdcx-movement", 0.99998, "usdc-circle"], ["weusd-picwe", 0.9899802, "usdc-circle"]] as const) {
      expect(overrides.get(id)).toMatchObject({ price, source: "protocol-redeem", confidence: "high", metadata: { inheritedFrom: parent, parentReplaySafe: true } });
    }
  });

  it.each([["protocol-derived", "protocol-redeem"], ["cached replay", "cached"], ["unregistered", "not-a-registered-source"]])(
    "treats a fresh %s incumbent as a non-market WEUSD price",
    async (_kind, incumbentSource) => {
      const nowSec = Math.floor(Date.now() / 1000);
      const overrides = await fetchLiveOverrides([
        freshParent("weusd-picwe", 0.99, incumbentSource, { nowSec }),
        freshParent("usdc-circle", 0.99998, "coingecko+pyth", { nowSec }),
      ]);
      expect(overrides.get("weusd-picwe")).toMatchObject({ price: 0.9899802, source: "protocol-redeem", metadata: { inheritedFrom: "usdc-circle" } });
    },
  );

  it("builds nominal fallbacks independently of observed-route dispatch", () => {
    const overrides = new Map(["sofid-sofi", "usbd-bima", "usdq-quill", "zarm-mento", "xofm-mento"].map((id) =>
      [id, getProtocolParPriceOverride(id, {
        rates: { peggedZAR: 0.0608, peggedXOF: 0.00172 }, type: "fresh", updatedAt: 1_778_000_000,
        updatedAtByPeg: { peggedZAR: 1_778_000_003, peggedXOF: 1_778_000_004 },
        typeByPeg: { peggedZAR: "fresh", peggedXOF: "fresh" },
      })]));

    // SOFID's repaired market route must not fall back to nominal publication.
    const nominal = { source: "protocol-par", confidence: null, observedAt: null, observedAtMode: "nominal_reference" };
    const fx = (fxObservedAt: number) => ({ nominalFx: { fxReferenceType: "fresh", fxObservedAt } });
    expect(overrides.get("usbd-bima")).toEqual({ price: 1, ...nominal });
    expect(overrides.get("sofid-sofi")).toBeNull();
    expect(overrides.get("usdq-quill")).toEqual({ price: 1, ...nominal });
    expect(overrides.get("zarm-mento")).toEqual({ price: 0.0608, ...nominal, ...fx(1_778_000_003) });
    expect(overrides.get("xofm-mento")).toEqual({ price: 0.00172, ...nominal, ...fx(1_778_000_004) });
  });

  it("keeps static ZAR nominal and withholds missing/stale FX", () => {
    for (const type of ["none", "stale", "static"] as const) {
      const quote = getProtocolParPriceOverride("zarm-mento", { rates: { peggedZAR: 0.06 }, type, updatedAt: null });
      expect(quote).toEqual(type === "static" ? { price: 0.06, source: "protocol-par", confidence: null,
        observedAt: null, observedAtMode: "nominal_reference", nominalFx: { fxReferenceType: "static", fxObservedAt: null } } : null);
    }
  });

  it.each([
    ["usbd-bima", "USD"],
    ["zarm-mento", "ZAR"],
  ] as const)("never synthesizes par replay history for %s, so replay preserves existing rows", async (id, pegCurrency) => {
    const result = await fetchAuthoritativeHistoricalPriceSeries(
      makeHistoricalMeta(id, id, id.toUpperCase(), { flags: { pegCurrency, governance: "centralized" } }),
      { candidateTimestamps: [1_778_000_000, 1_778_086_400] },
    );

    expect(result).toEqual({ matched: true, source: "protocol-par", prices: null });
  });

  it("replays historical iUSD prices through the infiniFi redeem quote", async () => {
    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValueOnce(24_133_673).mockResolvedValueOnce(24_209_239);
    fetchEvmCallHexAtBlockMock.mockResolvedValue(IUSD_QUOTE_HEX);
    fetchMarketBackfillPriceSeriesMock.mockResolvedValue(makeHistoricalPriceSeries([
      { timestamp: 1_767_196_936, price: 0.9 }, { timestamp: 1_768_107_667, price: 1.02 },
    ]));
    const result = await fetchAuthoritativeHistoricalPriceSeries(
      makeHistoricalMeta("iusd-infinifi", "infiniFi USD", "IUSD", { flags: { backing: "crypto-backed", governance: "centralized-dependent", yieldBearing: true } }),
      { candidateTimestamps: [1_767_196_936, 1_768_107_667] },
    );
    expect(result).toEqual({
      matched: true, source: "protocol-redeem",
      prices: [{ timestamp: 1_767_196_936, price: 0.9 }, { timestamp: 1_768_107_667, price: 1.02 }],
    });
    expect(resolveClosestBlockAtOrBeforeTimestampMock).toHaveBeenCalledTimes(2);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenCalledTimes(2);
    expect(fetchEvmCallHexAtBlockMock).toHaveBeenNthCalledWith(
      1, "ethereum", "0xCb1747E89a43DEdcF4A2b831a0D94859EFeC7601", expect.stringMatching(/^0xf308cf65/), 24_133_673,
      expect.objectContaining({ extraRpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"] }),
    );
  });

  it("replays historical USDAI prices from the tracked PYUSD market series and forwards API key", async () => {
    fetchMarketBackfillPriceSeriesMock.mockResolvedValue(makeHistoricalPriceSeries([
      { timestamp: 1_759_363_200, price: 0.99994 }, { timestamp: 1_759_366_800, price: 1.00011 },
    ]));
    const meta = makeHistoricalMeta("usdai-usd-ai", "USDai", "USDai", { flags: { governance: "centralized-dependent" } });
    const result = await fetchAuthoritativeHistoricalPriceSeries(meta, { candidateTimestamps: [1_759_363_200, 1_759_366_800] });
    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pyusd-paypal", geckoId: "paypal-usd" }), "paypal-usd", { granularity: "hourly", coingeckoApiKey: null },
    );
    expect(result).toEqual({
      matched: true, source: "protocol-redeem",
      prices: [{ timestamp: 1_759_363_200, price: 0.99994 }, { timestamp: 1_759_366_800, price: 1.00011 }],
    });
    await fetchAuthoritativeHistoricalPriceSeries(meta, { candidateTimestamps: [1_759_363_200], coingeckoApiKey: "cg-pro-key" });
    expect(fetchMarketBackfillPriceSeriesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "pyusd-paypal", geckoId: "paypal-usd" }), "paypal-usd", { granularity: "hourly", coingeckoApiKey: "cg-pro-key" },
    );
  });

  it.each([
    ["usdk-kast", true, "protocol-redeem"], ["xo-exodus", true, "protocol-redeem"], ["usdnr-nerona", true, "protocol-redeem"],
    ["wm-m0", false, null], ["m-m0", false, null], ["weusd-picwe", false, null], ["oned-gennius", false, null], ["pyusdx-moonpay", false, null],
  ] as const)("preserves backfill / own market history for %s without synthesizing parent series", async (id, matched, source) => {
    const result = await fetchAuthoritativeHistoricalPriceSeries(
      makeHistoricalMeta(id, id, id.toUpperCase(), { flags: { governance: "centralized", rwa: true } }),
      { candidateTimestamps: [1_776_000_000, 1_776_003_600] },
    );
    expect(result).toEqual({ matched, source, prices: null });
    expect(fetchMarketBackfillPriceSeriesMock).not.toHaveBeenCalled();
  });

  it("skips untrusted M parents and falls back to nominal par for USDK/USDN", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const par = { price: 1, source: "protocol-par", confidence: null, observedAt: null, observedAtMode: "nominal_reference" };
    for (const parent of [
      freshParent("m-m0", 0.9998, "coingecko+pyth", { nowSec, priceConfidence: "low" }),
      freshParent("m-m0", 0.9998, "cached", { nowSec }),
      freshParent("m-m0", 0.9998, "coingecko+pyth", { nowSec, observedAt: nowSec - 1_000 }),
      asset("m-m0", { price: 0.9998, priceConfidence: "high", priceObservedAt: nowSec - 60, priceObservedAtMode: "upstream" }),
    ]) {
      const overrides = await fetchLiveOverrides([asset("usdk-kast"), asset("wm-m0"), parent]);
      expect(overrides.has("wm-m0")).toBe(false);
      expect(overrides.get("usdk-kast")).toEqual(par);
    }
    for (const id of ["usdk-kast", "usdn-noble"]) {
      expect((await fetchLiveOverrides([asset(id)])).get(id)).toEqual(par);
    }
    warnSpy.mockRestore();
  });

  it("applies M0 parent trust rules for protocol-authoritative, address-composite, single-source, and same-run chains", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const proto = await fetchLiveOverrides([
      asset("usdk-kast"),
      freshParent("m-m0", 0.9998, "protocol-redeem", { nowSec, priceConfidence: "single-source", priceObservedAtMode: "local_fetch" }),
    ]);
    expect(proto.get("usdk-kast")).toMatchObject({
      price: 0.9998, source: "protocol-redeem", confidence: "high",
      metadata: { inheritedFrom: "m-m0", parentSource: "protocol-redeem", parentConfidence: "single-source", parentReplaySafe: true },
    });

    const addr = await fetchLiveOverrides([
      asset("usdk-kast"), asset("xo-exodus"), asset("wm-m0"),
      freshParent("m-m0", 0.9998, "alchemy-address+coingecko+coingecko-onchain-address+moralis-address", { nowSec, priceObservedAtMode: "local_fetch" }),
    ]);
    for (const id of ["usdk-kast", "xo-exodus"]) {
      expect(addr.get(id)).toMatchObject({ price: 0.9998, source: "protocol-redeem", confidence: "high", metadata: { inheritedFrom: "m-m0", parentReplaySafe: false } });
    }
    expect(addr.has("wm-m0")).toBe(false);

    const singleIds = ["wm-m0", "usdk-kast", "xo-exodus", "usdnr-nerona"] as const;
    const single = await fetchLiveOverrides([
      ...singleIds.map((id) => asset(id)),
      freshParent("m-m0", 0.999674, "coingecko", { nowSec, priceConfidence: "single-source" }),
    ]);
    for (const id of singleIds) {
      expect(single.get(id)).toMatchObject({
        price: 0.999674, source: "coingecko", confidence: "single-source",
        metadata: { inheritedFrom: "m-m0", parentSource: "coingecko", parentConfidence: "single-source", parentReplaySafe: true },
      });
    }

    const usdn = await fetchLiveOverrides([
      asset("usdn-noble"),
      freshParent("m-m0", 0.999766, "defillama-contract", { nowSec, priceConfidence: "single-source" }),
    ]);
    expect(usdn.get("usdn-noble")).toMatchObject({
      price: 0.999766, source: "defillama-contract", confidence: "single-source",
      metadata: { inheritedFrom: "m-m0", parentSource: "defillama-contract", parentConfidence: "single-source", parentReplaySafe: true },
    });

    const m0Spy = vi.spyOn(m0ExtensionProvider, "fetchLivePrice").mockResolvedValue({
      price: 0.999812, source: "coingecko", confidence: "single-source", observedAt: nowSec - 60, observedAtMode: "upstream",
      metadata: { inheritedFrom: "musd-metamask", parentReplaySafe: true },
    });
    try {
      const chain = await fetchLiveOverrides([
        unpricedChild("m-m0"), unpricedChild("wm-m0"), unpricedChild("usdn-noble"),
        freshParent("musd-metamask", 0.999812, "coingecko", { nowSec, priceConfidence: "single-source" }),
      ]);
      expect(chain.get("m-m0")).toMatchObject({ price: 0.999812, source: "coingecko", confidence: "single-source", metadata: { inheritedFrom: "musd-metamask", parentReplaySafe: true } });
      for (const id of ["wm-m0", "usdn-noble"]) {
        expect(chain.get(id)).toMatchObject({ price: 0.999812, source: "coingecko", confidence: "single-source", metadata: { inheritedFrom: "m-m0", parentReplaySafe: true } });
      }
    } finally {
      m0Spy.mockRestore();
    }
  });

  it("does not return a crvUSD override and preserves backfill rows when coverage is too low", async () => {
    const overrides = await fetchLiveOverrides([asset("crvusd-curve", { circulating: { peggedUSD: 400_000_000 } })]);
    expect(overrides.has("crvusd-curve")).toBe(false);
    expect(fetchEvmCallHexAtBlockMock).not.toHaveBeenCalled();

    resolveClosestBlockAtOrBeforeTimestampMock.mockResolvedValueOnce(22_874_100);
    fetchEvmCallHexAtBlockMock.mockResolvedValue(QUOTE_HEX);
    fetchMarketBackfillPriceSeriesMock.mockResolvedValue(makeHistoricalPriceSeries([
      { timestamp: 1_710_000_000, price: 1 }, { timestamp: 1_710_086_400, price: 1 },
    ]));
    expect(await fetchAuthoritativeHistoricalPriceSeries(
      makeHistoricalMeta("cusd-cap", "Cap cUSD", "CUSD", { flags: { governance: "centralized-dependent" } }),
      { candidateTimestamps: [1_710_000_000, 1_710_086_400] },
    )).toEqual({ matched: true, source: "protocol-redeem", prices: null });
  });
});
