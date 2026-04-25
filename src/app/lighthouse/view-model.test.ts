import { describe, expect, it } from "vitest";
import type { ChainSummary } from "@shared/types/chains";
import type { StabilityIndexCurrent } from "@shared/types/stability";
import { buildLighthouseSceneModel, formatLighthouseShipSummary } from "./view-model";

function makeChain(overrides: Partial<ChainSummary> & Pick<ChainSummary, "id" | "name" | "totalUsd">): ChainSummary {
  return {
    id: overrides.id,
    name: overrides.name,
    logoPath: overrides.logoPath ?? `/logos/${overrides.id}.svg`,
    type: overrides.type ?? "evm",
    totalUsd: overrides.totalUsd,
    change24h: overrides.change24h ?? 0,
    change24hPct: overrides.change24hPct ?? 0,
    change7d: overrides.change7d ?? 0,
    change7dPct: overrides.change7dPct ?? 0,
    change30d: overrides.change30d ?? 0,
    change30dPct: overrides.change30dPct ?? 0,
    stablecoinCount: overrides.stablecoinCount ?? 1,
    dominantStablecoin: overrides.dominantStablecoin ?? { id: `${overrides.id}-dominant`, symbol: "USDX", share: 0.4 },
    topStablecoins: overrides.topStablecoins,
    dominanceShare: overrides.dominanceShare ?? 0.05,
    healthScore: overrides.healthScore ?? 70,
    healthBand: overrides.healthBand ?? "healthy",
    healthFactors: overrides.healthFactors ?? {
      concentration: 0.1,
      quality: 0.7,
      pegStability: 0.8,
      backingDiversity: 0.6,
      chainEnvironment: 0.7,
    },
  };
}

const PSI: StabilityIndexCurrent = {
  score: 72,
  band: "STEADY",
  components: {
    severity: 18,
    breadth: 11,
    stressBreadth: 4,
    trend: 2,
  },
  computedAt: 1710000000,
  methodologyVersion: "v1",
  totalMcapUsd: 1_000_000_000,
  contributors: [],
};

describe("buildLighthouseSceneModel", () => {
  it("selects the top visible ships and resolves a default selection", () => {
    const chains = [
      makeChain({
        id: "ethereum",
        name: "Ethereum",
        totalUsd: 400_000_000,
        stablecoinCount: 12,
        dominantStablecoin: { id: "usdt", symbol: "USDT", share: 0.46 },
        topStablecoins: [{ id: "usdt", symbol: "USDT", share: 0.46, supplyUsd: 184_000_000 }],
      }),
      makeChain({
        id: "tron",
        name: "Tron",
        totalUsd: 300_000_000,
        stablecoinCount: 9,
        dominantStablecoin: { id: "usdt", symbol: "USDT", share: 0.6 },
        topStablecoins: [{ id: "usdt", symbol: "USDT", share: 0.6, supplyUsd: 180_000_000 }],
      }),
      makeChain({
        id: "base",
        name: "Base",
        totalUsd: 200_000_000,
        stablecoinCount: 8,
        dominantStablecoin: { id: "usdc", symbol: "USDC", share: 0.39 },
        topStablecoins: [{ id: "usdc", symbol: "USDC", share: 0.39, supplyUsd: 78_000_000 }],
      }),
      makeChain({
        id: "arbitrum",
        name: "Arbitrum",
        totalUsd: 100_000_000,
        healthBand: "mixed",
        stablecoinCount: 6,
        dominantStablecoin: { id: "usdc", symbol: "USDC", share: 0.35 },
      }),
      makeChain({
        id: "polygon",
        name: "Polygon",
        totalUsd: 60_000_000,
        change7dPct: -0.045,
        healthBand: "fragile",
        stablecoinCount: 5,
        dominantStablecoin: { id: "usdt", symbol: "USDT", share: 0.52 },
      }),
      makeChain({
        id: "solana",
        name: "Solana",
        totalUsd: 40_000_000,
        change7dPct: 0.01,
        healthBand: "concentrated",
        stablecoinCount: 4,
        dominantStablecoin: { id: "usdc", symbol: "USDC", share: 0.7 },
      }),
      makeChain({
        id: "bsc",
        name: "BSC",
        totalUsd: 20_000_000,
        healthBand: "healthy",
        stablecoinCount: 3,
        dominantStablecoin: { id: "usdt", symbol: "USDT", share: 0.4 },
      }),
    ];

    const model = buildLighthouseSceneModel({ chains, totalUsd: 1_120_000_000, stabilityIndex: PSI, selectedId: null });

    expect(model.visibleShipCount).toBe(6);
    expect(model.selectedId).toBe("ethereum");
    expect(model.selectedShip?.name).toBe("Ethereum");
    expect(model.tailFleet?.remainingCount).toBe(1);
    expect(model.sceneSummary).toContain("Pharos Lighthouse");
    expect(model.sceneSummary).toContain("STEADY 72");
  });

  it("keeps ship widths monotonic and avoids NaN for bad inputs", () => {
    const chains = [
      makeChain({ id: "a", name: "A", totalUsd: 10_000_000, change7dPct: 0.01, healthBand: "robust" }),
      makeChain({ id: "b", name: "B", totalUsd: 5_000_000, change7dPct: -0.01, healthBand: "healthy" }),
      makeChain({ id: "c", name: "C", totalUsd: 1_000_000, change7dPct: Number.NaN, healthBand: null }),
    ];
    const model = buildLighthouseSceneModel({
      chains,
      totalUsd: 16_000_000,
      stabilityIndex: null,
      selectedId: "missing",
    });

    expect(model.ships[0]?.hullWidth ?? 0).toBeGreaterThanOrEqual(model.ships[1]?.hullWidth ?? 0);
    expect(model.ships[1]?.hullWidth ?? 0).toBeGreaterThanOrEqual(model.ships[2]?.hullWidth ?? 0);
    expect(model.selectedId).toBe("a");
    expect(model.selectedShip?.id).toBe("a");
    expect(model.ships.every((ship) => Number.isFinite(ship.hullWidth) && Number.isFinite(ship.mastHeight))).toBe(true);
  });

  it("formats the selected ship summary with the expected anchors", () => {
    const chain = makeChain({
      id: "ethereum",
      name: "Ethereum",
      totalUsd: 400_000_000,
      stablecoinCount: 9,
      dominantStablecoin: { id: "usdt", symbol: "USDT", share: 0.46 },
      topStablecoins: [{ id: "usdt", symbol: "USDT", share: 0.46, supplyUsd: 184_000_000 }],
    });
    const model = buildLighthouseSceneModel({
      chains: [chain],
      totalUsd: 400_000_000,
      stabilityIndex: PSI,
      selectedId: "ethereum",
    });
    expect(formatLighthouseShipSummary(model.selectedShip ?? model.ships[0]!)).toContain("Ethereum");
    expect(formatLighthouseShipSummary(model.selectedShip ?? model.ships[0]!)).toContain("$400.0M");
  });

  it("derives pennant width from dominant cargo share", () => {
    const chains = [
      makeChain({
        id: "low",
        name: "Low",
        totalUsd: 10_000_000,
        dominantStablecoin: { id: "a", symbol: "A", share: 0.2 },
      }),
      makeChain({
        id: "high",
        name: "High",
        totalUsd: 9_000_000,
        dominantStablecoin: { id: "b", symbol: "B", share: 0.75 },
      }),
    ];
    const model = buildLighthouseSceneModel({ chains, totalUsd: 19_000_000, stabilityIndex: PSI, selectedId: null });
    const low = model.ships.find((ship) => ship.id === "low");
    const high = model.ships.find((ship) => ship.id === "high");
    expect(high?.pennantWidth ?? 0).toBeGreaterThan(low?.pennantWidth ?? 0);
  });
});
