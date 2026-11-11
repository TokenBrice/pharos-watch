import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinData } from "@shared/types/supply";

const loadStablecoinsCache = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/stablecoins-cache", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/stablecoins-cache")>(),
  loadStablecoinsCache,
}));

import { loadTrackedStablecoinMaps } from "../orchestrator-phases/lookups";

const NOW_SEC = 1_700_000_000;

function makeAsset(overrides: Partial<StablecoinData> & Pick<StablecoinData, "id" | "price">): StablecoinData {
  const base = {
    name: overrides.id,
    symbol: overrides.id,
    geckoId: null,
    pegType: "peggedUSD",
    pegMechanism: "test",
    priceSource: "coingecko",
    priceConfidence: "single-source",
    priceUpdatedAt: NOW_SEC - 60,
    priceObservedAt: NOW_SEC - 60,
    priceObservedAtMode: "upstream",
    priceSyncedAt: NOW_SEC - 60,
    consensusSources: [],
    agreeSources: ["coingecko"],
    circulating: { peggedUSD: 1_000_000 },
    circulatingPrevDay: {},
    circulatingPrevWeek: {},
    circulatingPrevMonth: {},
    chainCirculating: {},
    chains: [],
    supplySource: undefined,
  };
  return { ...base, ...overrides } as StablecoinData;
}

describe("loadTrackedStablecoinMaps", () => {
  beforeEach(() => {
    loadStablecoinsCache.mockReset();
  });

  it("retains fresh corroborated NAV prices for CL target references", async () => {
    loadStablecoinsCache.mockResolvedValue({
      kind: "ok",
      updatedAt: NOW_SEC,
      payload: {
        peggedAssets: [
          makeAsset({
            id: "slvon-ondo",
            price: 52.37,
            priceConfidence: "high",
            circulating: { peggedUSD: 100, peggedEUR: 250 },
            agreeSources: ["coingecko", "coingecko-onchain-address", "alchemy-address"],
          }),
          makeAsset({
            id: "susn-noon",
            price: 1.2055005012280287,
            priceConfidence: "high",
            agreeSources: ["coingecko", "coingecko-onchain-address", "alchemy-address"],
          }),
        ],
      },
    });

    const { stablecoinPriceById, stablecoinMcapById } = await loadTrackedStablecoinMaps({} as D1Database, NOW_SEC);

    expect(stablecoinPriceById.get("slvon-ondo")).toBe(52.37);
    expect(stablecoinPriceById.get("susn-noon")).toBe(1.2055005012280287);
    expect(stablecoinMcapById).toEqual(new Map([["slvon-ondo", 350], ["susn-noon", 1_000_000]]));
  });

  it("rejects fallback-only multi-source tracked prices for CL target references", async () => {
    loadStablecoinsCache.mockResolvedValue({
      kind: "ok",
      updatedAt: NOW_SEC,
      payload: {
        peggedAssets: [
          makeAsset({
            id: "usdc-circle",
            price: 0.42,
            priceConfidence: "high",
            priceSource: "dexscreener-address+alchemy-address",
            agreeSources: ["dexscreener-address", "alchemy-address"],
          }),
        ],
      },
    });

    const { stablecoinPriceById, stablecoinMcapById } = await loadTrackedStablecoinMaps({} as D1Database, NOW_SEC);

    expect(stablecoinPriceById.has("usdc-circle")).toBe(false);
    expect(stablecoinMcapById).toEqual(new Map([["usdc-circle", 1_000_000]]));
  });

  it("admits fresh observed soft primaries only as comparison anchors", async () => {
    loadStablecoinsCache.mockResolvedValue({
      kind: "ok",
      updatedAt: NOW_SEC,
      payload: {
        peggedAssets: [
          makeAsset({ id: "mai-qidao", price: 0.996 }),
          makeAsset({ id: "usda-alpha-partner", price: 0.92, priceObservedAt: NOW_SEC - 1_800 }),
          makeAsset({ id: "pathusd-bridge", price: 0.999 }),
          makeAsset({ id: "wars-argentine-peso", price: 0.0006 }),
          makeAsset({ id: "stale", price: 1, priceObservedAt: NOW_SEC - 1_801 }),
          makeAsset({ id: "future", price: 1, priceObservedAt: NOW_SEC + 1 }),
          makeAsset({ id: "unclocked", price: 1, priceObservedAt: undefined, priceUpdatedAt: undefined }),
          makeAsset({ id: "nominal", price: 1, priceSource: "protocol-par" }),
          makeAsset({ id: "invalid", price: Number.NaN }),
          makeAsset({ id: "zero", price: 0 }),
          makeAsset({ id: "fallback", price: 1, priceConfidence: "fallback" }),
          makeAsset({ id: "cached", price: 1, priceSource: "cached" }),
        ],
      },
    });

    const { stablecoinPriceById, primaryPriceById, stablecoinPriceProvenanceById } =
      await loadTrackedStablecoinMaps({} as D1Database, NOW_SEC);

    expect(primaryPriceById).toEqual(new Map([
      ["mai-qidao", 0.996], ["usda-alpha-partner", 0.92],
      ["pathusd-bridge", 0.999], ["wars-argentine-peso", 0.0006],
    ]));
    expect(stablecoinPriceById.size).toBe(0);
    expect(stablecoinPriceProvenanceById.size).toBe(0);
  });

  it("admits a fresh guarded protocol-redeem NAV price for a navToken", async () => {
    loadStablecoinsCache.mockResolvedValue({
      kind: "ok",
      updatedAt: NOW_SEC,
      payload: {
        peggedAssets: [
          makeAsset({
            id: "susn-noon",
            price: 1.2241,
            priceSource: "protocol-redeem",
            priceConfidence: "high",
            agreeSources: ["protocol-redeem"],
          }),
        ],
      },
    });

    const { stablecoinPriceById, stablecoinMcapById } = await loadTrackedStablecoinMaps({} as D1Database, NOW_SEC);

    expect(stablecoinPriceById.get("susn-noon")).toBe(1.2241);
    expect(stablecoinMcapById).toEqual(new Map([["susn-noon", 1_000_000]]));
  });

  it("rejects the cached-rate NAV degradation lane for a navToken", async () => {
    loadStablecoinsCache.mockResolvedValue({
      kind: "ok",
      updatedAt: NOW_SEC,
      payload: {
        peggedAssets: [
          makeAsset({
            id: "susn-noon",
            price: 1.2241,
            priceSource: "protocol-redeem-cached-rate",
            priceConfidence: "low",
            agreeSources: ["protocol-redeem-cached-rate"],
          }),
        ],
      },
    });

    const { stablecoinPriceById } = await loadTrackedStablecoinMaps({} as D1Database, NOW_SEC);

    expect(stablecoinPriceById.has("susn-noon")).toBe(false);
  });

  it("rejects a stale guarded NAV price for a navToken", async () => {
    loadStablecoinsCache.mockResolvedValue({
      kind: "ok",
      updatedAt: NOW_SEC,
      payload: {
        peggedAssets: [
          makeAsset({
            id: "susn-noon",
            price: 1.2241,
            priceSource: "protocol-redeem",
            priceConfidence: "high",
            agreeSources: ["protocol-redeem"],
            priceObservedAt: NOW_SEC - 1_801,
            priceUpdatedAt: NOW_SEC - 1_801,
          }),
        ],
      },
    });

    const { stablecoinPriceById } = await loadTrackedStablecoinMaps({} as D1Database, NOW_SEC);

    expect(stablecoinPriceById.has("susn-noon")).toBe(false);
  });

  it("rejects a future-dated guarded NAV price for a navToken", async () => {
    loadStablecoinsCache.mockResolvedValue({
      kind: "ok",
      updatedAt: NOW_SEC,
      payload: {
        peggedAssets: [
          makeAsset({
            id: "susn-noon",
            price: 1.2241,
            priceSource: "protocol-redeem",
            priceConfidence: "high",
            agreeSources: ["protocol-redeem"],
            // Provider clock an hour ahead of the DEX stage clock: a negative
            // age is not freshness for this lane or its provenance fence.
            priceObservedAt: NOW_SEC + 3_600,
            priceUpdatedAt: NOW_SEC + 3_600,
          }),
        ],
      },
    });

    const { stablecoinPriceById, stablecoinPriceProvenanceById } = await loadTrackedStablecoinMaps({} as D1Database, NOW_SEC);

    expect(stablecoinPriceProvenanceById.has("susn-noon")).toBe(false);
    expect(stablecoinPriceById.has("susn-noon")).toBe(false);
  });

  it("does not admit a protocol-redeem price for a non-navToken", async () => {
    loadStablecoinsCache.mockResolvedValue({
      kind: "ok",
      updatedAt: NOW_SEC,
      payload: {
        peggedAssets: [
          makeAsset({
            id: "usdc-circle",
            price: 1.0001,
            priceSource: "protocol-redeem",
            priceConfidence: "high",
            agreeSources: ["protocol-redeem"],
          }),
        ],
      },
    });

    const { stablecoinPriceById } = await loadTrackedStablecoinMaps({} as D1Database, NOW_SEC);

    expect(stablecoinPriceById.has("usdc-circle")).toBe(false);
  });

  it("omits nonpositive circulating amounts without dropping trusted prices", async () => {
    loadStablecoinsCache.mockResolvedValue({
      kind: "ok",
      updatedAt: NOW_SEC,
      payload: { peggedAssets: [
        makeAsset({
          id: "zero", price: 1, circulating: { peggedUSD: 0 },
          priceConfidence: "high", agreeSources: ["coingecko", "coingecko-onchain-address", "alchemy-address"],
        }),
        makeAsset({
          id: "negative", price: 1, circulating: { peggedUSD: -1 },
          priceConfidence: "high", agreeSources: ["coingecko", "coingecko-onchain-address", "alchemy-address"],
        }),
      ] },
    });
    const maps = await loadTrackedStablecoinMaps({} as D1Database, NOW_SEC);
    expect(maps.stablecoinMcapById).toEqual(new Map());
    expect(maps.stablecoinPriceById).toEqual(new Map([["zero", 1], ["negative", 1]]));
    expect(maps.stablecoinPriceProvenanceById.get("zero")).toEqual({
      referencePriceSourceId: "coingecko", referencePriceObservedAt: NOW_SEC - 60,
    });
  });

  it("returns empty price, provenance and market-cap maps when the cache is unavailable", async () => {
    loadStablecoinsCache.mockResolvedValue({ kind: "missing" });
    expect(await loadTrackedStablecoinMaps({} as D1Database, NOW_SEC)).toEqual({
      stablecoinPriceById: new Map(), primaryPriceById: new Map(),
      stablecoinMcapById: new Map(), stablecoinPriceProvenanceById: new Map(),
    });
  });
});
