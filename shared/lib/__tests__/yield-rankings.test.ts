import { describe, expect, it } from "vitest";

import { dedupeYieldRankings } from "@shared/lib/yield-rankings";
import type { YieldRanking } from "@shared/types";

function makeRanking(overrides: Partial<YieldRanking>): YieldRanking {
  return {
    id: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    currentApy: 4.1,
    apy7d: 4.1,
    apy30d: 4.1,
    apyBase: 4.1,
    apyReward: null,
    yieldSource: "Base source",
    yieldType: "governance-set",
    dataSource: "defillama",
    sourceTvlUsd: 100_000_000,
    pharosYieldScore: 22,
    safetyScore: 82,
    safetyGrade: "A-",
    yieldToRisk: 0.2,
    excessYield: 0.1,
    yieldStability: 0.9,
    apyVariance30d: 0.2,
    apyMin30d: 4.0,
    apyMax30d: 4.3,
    warningSignals: [],
    altSources: [],
    ...overrides,
  };
}

describe("dedupeYieldRankings", () => {
  it("keeps only the preferred row per stablecoin id", () => {
    const rankings = dedupeYieldRankings([
      makeRanking({ id: "usdc-circle", currentApy: 4.2, yieldSource: "Lower" }),
      makeRanking({ id: "usdc-circle", currentApy: 4.7, yieldSource: "Higher" }),
      makeRanking({ id: "usdt-tether", symbol: "USDT", name: "Tether", currentApy: 3.8, apy30d: 3.7 }),
    ]);

    expect(rankings).toHaveLength(2);
    expect(rankings.find((row) => row.id === "usdc-circle")?.yieldSource).toBe("Higher");
  });

  it("handles rows with all null scores gracefully", () => {
    const rankings = dedupeYieldRankings([
      makeRanking({ id: "a", currentApy: 0, pharosYieldScore: null, apy30d: 0, sourceTvlUsd: null }),
      makeRanking({ id: "a", currentApy: 0, pharosYieldScore: null, apy30d: 0, sourceTvlUsd: null }),
    ]);
    expect(rankings).toHaveLength(1);
  });

  it("returns a single row unchanged", () => {
    const rankings = dedupeYieldRankings([
      makeRanking({ id: "solo", currentApy: 5.0 }),
    ]);
    expect(rankings).toHaveLength(1);
    expect(rankings[0].id).toBe("solo");
  });

  it("uses PYS and TVL as tie-breakers when APY matches", () => {
    const rankings = dedupeYieldRankings([
      makeRanking({
        id: "usdc-circle",
        currentApy: 4.5,
        pharosYieldScore: 19,
        sourceTvlUsd: 50_000_000,
        yieldSource: "Lower PYS",
      }),
      makeRanking({
        id: "usdc-circle",
        currentApy: 4.5,
        pharosYieldScore: 24,
        sourceTvlUsd: 10_000_000,
        yieldSource: "Higher PYS",
      }),
      makeRanking({ id: "usdt-tether", symbol: "USDT", name: "Tether", currentApy: 3.8, apy30d: 3.7 }),
    ]);

    expect(rankings.find((row) => row.id === "usdc-circle")?.yieldSource).toBe("Higher PYS");
  });
});
