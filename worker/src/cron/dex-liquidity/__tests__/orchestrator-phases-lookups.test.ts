import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinData } from "@shared/types/market";

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

  it("still rejects a soft price without fresh multi-source agreement", async () => {
    loadStablecoinsCache.mockResolvedValue({
      kind: "ok",
      updatedAt: NOW_SEC,
      payload: {
        peggedAssets: [makeAsset({ id: "slvon-ondo", price: 31.42 })],
      },
    });

    const { stablecoinPriceById } = await loadTrackedStablecoinMaps({} as D1Database, NOW_SEC);

    expect(stablecoinPriceById.has("slvon-ondo")).toBe(false);
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
  });

  it("returns both empty maps when the cache is unavailable", async () => {
    loadStablecoinsCache.mockResolvedValue({ kind: "missing" });
    expect(await loadTrackedStablecoinMaps({} as D1Database, NOW_SEC)).toEqual({
      stablecoinPriceById: new Map(), stablecoinMcapById: new Map(),
    });
  });
});
