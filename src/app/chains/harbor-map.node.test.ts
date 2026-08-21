import { describe, expect, it } from "vitest";
import type { ChainSummary } from "@shared/types/chains";
import { ZERO_RATIO } from "@shared/types/ratio";
import { buildChainHarborEntries, buildChainHarborModel } from "./harbor-map";

function makeChain(overrides: Partial<ChainSummary>): ChainSummary {
  return {
    id: overrides.id ?? "ethereum",
    name: overrides.name ?? "Ethereum",
    logoPath: overrides.logoPath ?? "/logos/chains/ethereum.svg",
    type: overrides.type ?? "evm",
    totalUsd: overrides.totalUsd ?? 100,
    change24h: overrides.change24h ?? 0,
    change24hPct: overrides.change24hPct ?? ZERO_RATIO,
    change7d: overrides.change7d ?? 0,
    change7dPct: overrides.change7dPct ?? ZERO_RATIO,
    change30d: overrides.change30d ?? 0,
    change30dPct: overrides.change30dPct ?? ZERO_RATIO,
    stablecoinCount: overrides.stablecoinCount ?? 3,
    dominantStablecoin: overrides.dominantStablecoin ?? {
      id: "usdc-circle",
      symbol: "USDC",
      share: 0.6,
    },
    topStablecoins: overrides.topStablecoins,
    dominanceShare: overrides.dominanceShare ?? 0.5,
    healthScore: overrides.healthScore === undefined ? 82 : overrides.healthScore,
    healthBand: overrides.healthBand === undefined ? "healthy" : overrides.healthBand,
    healthFactors: overrides.healthFactors ?? {
      concentration: 80,
      quality: 85,
      pegStability: 90,
      backingDiversity: 70,
      chainEnvironment: 80,
    },
    chainEnvironmentEvidence: overrides.chainEnvironmentEvidence ?? {
      source: "pharos-chain-tier",
      score: 80,
      resilienceTier: 2,
    },
  };
}

describe("buildChainHarborModel", () => {
  it("sorts chains by supply and derives top-harbor share and health summary", () => {
    const model = buildChainHarborModel([
      makeChain({ id: "base", name: "Base", totalUsd: 25, healthScore: 70, healthBand: "mixed" }),
      makeChain({ id: "ethereum", name: "Ethereum", totalUsd: 60, healthScore: 90, healthBand: "robust" }),
      makeChain({ id: "fragile", name: "FragileNet", totalUsd: 15, healthScore: 40, healthBand: "fragile" }),
    ], 100);

    expect(model.entries.map((entry) => entry.id)).toEqual(["ethereum", "base", "fragile"]);
    expect(model.topSharePct).toBe(100);
    expect(model.largestHarbor).toMatchObject({
      id: "ethereum",
      sharePct: 60,
      berthPct: 100,
      dominantSharePct: 60,
    });
    expect(model.fragileHarbors).toBe(1);
    expect(model.averageHealthScore).toBe(67);
  });

  it("builds a top-stablecoin cargo manifest for the harbor chart", () => {
    const model = buildChainHarborModel([
      makeChain({
        id: "ethereum",
        name: "Ethereum",
        totalUsd: 100,
        topStablecoins: [
          { id: "usdt-tether", symbol: "USDT", share: 0.45, supplyUsd: 45 },
          { id: "usdc-circle", symbol: "USDC", share: 0.35, supplyUsd: 35 },
          { id: "dai-makerdao", symbol: "DAI", share: 0.2, supplyUsd: 20 },
        ],
      }),
    ], 100);

    expect(model.entries[0]?.cargos).toEqual([
      { id: "usdt-tether", symbol: "USDT", sharePct: 45, cargoUsd: 45 },
      { id: "usdc-circle", symbol: "USDC", sharePct: 35, cargoUsd: 35 },
      { id: "dai-makerdao", symbol: "DAI", sharePct: 20, cargoUsd: 20 },
    ]);
  });

  it("caps the harbor map to the largest eight chains", () => {
    const chains = Array.from({ length: 10 }, (_, index) => makeChain({
      id: `chain-${index}`,
      name: `Chain ${index}`,
      totalUsd: 10 - index,
    }));

    const model = buildChainHarborModel(chains, 55);

    expect(model.entries).toHaveLength(8);
    expect(model.entries[0]?.id).toBe("chain-0");
    expect(model.entries[7]?.id).toBe("chain-7");
  });

  it("can derive selected-harbor entries for the full leaderboard", () => {
    const chains = Array.from({ length: 10 }, (_, index) => makeChain({
      id: `chain-${index}`,
      name: `Chain ${index}`,
      totalUsd: 10 - index,
    }));

    const entries = buildChainHarborEntries(chains, 55);

    expect(entries).toHaveLength(10);
    expect(entries[0]?.id).toBe("chain-0");
    expect(entries[9]?.id).toBe("chain-9");
    expect(entries[9]?.berthPct).toBe(10);
  });

  it("handles zero global supply and ignores unrated chains in the health average", () => {
    const model = buildChainHarborModel([
      makeChain({
        id: "zero",
        name: "ZeroNet",
        totalUsd: 0,
        healthScore: null,
        healthBand: null,
      }),
      makeChain({
        id: "scored",
        name: "ScoredNet",
        totalUsd: 0,
        healthScore: 64,
        healthBand: "mixed",
      }),
    ], 0);

    expect(model.topSharePct).toBe(0);
    expect(model.entries[0]).toMatchObject({
      id: "zero",
      sharePct: 0,
      berthPct: 0,
      healthScore: null,
      healthBand: null,
    });
    expect(model.averageHealthScore).toBe(64);
  });
});
