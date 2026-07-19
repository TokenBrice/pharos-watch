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

    const { stablecoinPriceById } = await loadTrackedStablecoinMaps({} as D1Database, NOW_SEC);

    expect(stablecoinPriceById.get("slvon-ondo")).toBe(52.37);
    expect(stablecoinPriceById.get("susn-noon")).toBe(1.2055005012280287);
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

    const { stablecoinPriceById } = await loadTrackedStablecoinMaps({} as D1Database, NOW_SEC);

    expect(stablecoinPriceById.has("usdc-circle")).toBe(false);
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
});
