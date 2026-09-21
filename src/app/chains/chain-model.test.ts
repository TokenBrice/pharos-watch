import { describe, expect, it } from "vitest";
import type { ChainSummary } from "@shared/types/chains";
import { sortChains } from "./chain-model";

function chain(id: string, overrides: Partial<ChainSummary>): ChainSummary {
  return {
    id,
    name: id,
    logoPath: "",
    type: "other",
    totalUsd: 0,
    change24h: null,
    change24hPct: null,
    change7d: null,
    change7dPct: null,
    change30d: null,
    change30dPct: null,
    stablecoinCount: 0,
    dominantStablecoin: { id: "", symbol: "", share: 0 },
    topStablecoins: [],
    dominanceShare: 0,
    healthScore: null,
    healthBand: null,
    healthFactors: {
      concentration: 0,
      quality: null,
      pegStability: 0,
      backingDiversity: 0,
      chainEnvironment: 0,
    },
    ...overrides,
  };
}

describe("sortChains", () => {
  const rows = [
    chain("unknown", { healthScore: null }),
    chain("weak", { healthScore: 10 }),
    chain("strong", { healthScore: 90 }),
  ];

  it("keeps an unscored chain last when sorting descending", () => {
    expect(sortChains(rows, "healthScore", "desc").map((row) => row.id)).toEqual([
      "strong",
      "weak",
      "unknown",
    ]);
  });

  it("keeps an unscored chain last when sorting ascending", () => {
    // `?? -Infinity` used to rank the unmeasured chain as the unhealthiest one.
    expect(sortChains(rows, "healthScore", "asc").map((row) => row.id)).toEqual([
      "weak",
      "strong",
      "unknown",
    ]);
  });
});
