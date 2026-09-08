import { describe, expect, it } from "vitest";

import { dedupeYieldRankings } from "@shared/lib/yield-rankings";

type Ranking = {
  id: string;
  currentApy: number;
  pharosYieldScore: number | null;
  apy30d: number;
  sourceTvlUsd: number | null;
  yieldSource: string;
};

function makeRanking(overrides: Partial<Ranking>): Ranking {
  return {
    id: "usdc-circle",
    currentApy: 4.1,
    pharosYieldScore: 22,
    apy30d: 4.1,
    sourceTvlUsd: 100_000_000,
    yieldSource: "Base source",
    ...overrides,
  };
}

describe("dedupeYieldRankings", () => {
  it("keeps only the preferred row per stablecoin id", () => {
    const rankings = dedupeYieldRankings([
      makeRanking({ id: "usdc-circle", currentApy: 4.2, yieldSource: "Lower" }),
      makeRanking({ id: "usdc-circle", currentApy: 4.7, yieldSource: "Higher" }),
      makeRanking({ id: "usdt-tether", currentApy: 3.8, apy30d: 3.7 }),
    ]);

    expect(rankings).toHaveLength(2);
    expect(rankings.find((row) => row.id === "usdc-circle")?.yieldSource).toBe("Higher");
  });

  it("keeps the first exact tie including unrelated payload", () => {
    const first = { ...makeRanking({ pharosYieldScore: null, sourceTvlUsd: null }), payload: { venue: "first" } };
    const second = { ...first, yieldSource: "Second", payload: { venue: "second" } };
    expect(dedupeYieldRankings([first, second])).toEqual([first]);
  });

  it("returns a single row unchanged", () => {
    const row = makeRanking({ id: "solo", currentApy: 5.0 });
    expect(dedupeYieldRankings([row])).toEqual([row]);
  });

  it("prefers PYS over TVL when current APY matches", () => {
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
      makeRanking({ id: "usdt-tether", currentApy: 3.8, apy30d: 3.7 }),
    ]);

    expect(rankings.find((row) => row.id === "usdc-circle")?.yieldSource).toBe("Higher PYS");
  });

  it("prefers 30-day APY over TVL when current APY and PYS match", () => {
    const lower = makeRanking({ apy30d: 4, sourceTvlUsd: 100_000_000, yieldSource: "Lower" });
    const higher = makeRanking({ apy30d: 5, sourceTvlUsd: 1, yieldSource: "Higher" });
    for (const rows of [[lower, higher], [higher, lower]]) {
      expect(dedupeYieldRankings(rows)).toEqual([higher]);
    }
  });

  it("prefers TVL when all earlier scores match", () => {
    const lower = makeRanking({ sourceTvlUsd: 1, yieldSource: "Lower" });
    const higher = makeRanking({ sourceTvlUsd: 2, yieldSource: "Higher" });
    for (const rows of [[lower, higher], [higher, lower]]) {
      expect(dedupeYieldRankings(rows)).toEqual([higher]);
    }
  });

  it("prefers finite zero to null PYS and TVL", () => {
    for (const field of ["pharosYieldScore", "sourceTvlUsd"] as const) {
      const missing = makeRanking({ [field]: null, yieldSource: "Missing" });
      const finite = makeRanking({ [field]: 0, yieldSource: "Finite" });
      for (const rows of [[missing, finite], [finite, missing]]) {
        expect(dedupeYieldRankings(rows)).toEqual([finite]);
      }
    }
  });
});
