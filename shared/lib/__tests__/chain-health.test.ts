import { describe, it, expect } from "vitest";
import {
  computeConcentrationScore,
  computeBackingDiversityScore,
  computePegStabilityScore,
  computeQualityScore,
  computeHealthScore,
  getHealthBand,
  HEALTH_METHODOLOGY_VERSION,
} from "../chain-health";

describe("computeConcentrationScore", () => {
  it("returns 0 for a single-stablecoin chain", () => {
    expect(computeConcentrationScore([1.0])).toBe(0);
  });

  it("returns ~50 for an even two-coin split", () => {
    const score = computeConcentrationScore([0.5, 0.5]);
    expect(score).toBe(50);
  });

  it("returns high score for evenly distributed coins", () => {
    const shares = [0.25, 0.25, 0.25, 0.25];
    expect(computeConcentrationScore(shares)).toBe(75);
  });

  it("returns 0 for empty array", () => {
    expect(computeConcentrationScore([])).toBe(0);
  });
});

describe("computeBackingDiversityScore", () => {
  it("returns 0 for monoculture (all one type)", () => {
    const distribution = { "rwa-backed": 1, "crypto-backed": 0, algorithmic: 0 };
    expect(computeBackingDiversityScore(distribution)).toBe(0);
  });

  it("returns 100 for perfect three-way split", () => {
    const distribution = { "rwa-backed": 1/3, "crypto-backed": 1/3, algorithmic: 1/3 };
    expect(computeBackingDiversityScore(distribution)).toBe(100);
  });

  it("returns intermediate score for two-type split", () => {
    const distribution = { "rwa-backed": 0.5, "crypto-backed": 0.5, algorithmic: 0 };
    const score = computeBackingDiversityScore(distribution);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });
});

describe("computePegStabilityScore", () => {
  it("returns 100 for perfect peg", () => {
    const coins = [{ price: 1.0, pegRef: 1.0, supplyUsd: 1_000_000 }];
    expect(computePegStabilityScore(coins)).toBe(100);
  });

  it("returns 0 when deviation exceeds 500 bps", () => {
    const coins = [{ price: 0.94, pegRef: 1.0, supplyUsd: 1_000_000 }];
    expect(computePegStabilityScore(coins)).toBe(0);
  });

  it("returns 50 for no-price coins", () => {
    const coins = [{ price: null as number | null, pegRef: 1.0, supplyUsd: 1_000_000 }];
    expect(computePegStabilityScore(coins)).toBe(50);
  });

  it("supply-weights multiple coins", () => {
    const coins = [
      { price: 1.0, pegRef: 1.0, supplyUsd: 900_000 },
      { price: 0.97, pegRef: 1.0, supplyUsd: 100_000 },
    ];
    const score = computePegStabilityScore(coins);
    // 90% weight at 100, 10% weight at 40 => 94
    expect(score).toBe(94);
  });
});

describe("computeQualityScore", () => {
  it("returns supply-weighted average", () => {
    const coins = [
      { safetyScore: 80, supplyUsd: 500_000 },
      { safetyScore: 60, supplyUsd: 500_000 },
    ];
    expect(computeQualityScore(coins, 0.5)).toBe(70);
  });

  it("returns null when coverage is below threshold", () => {
    const coins = [
      { safetyScore: null as number | null, supplyUsd: 600_000 },
      { safetyScore: 80, supplyUsd: 400_000 },
    ];
    expect(computeQualityScore(coins, 0.5)).toBeNull();
  });

  it("uses default 40 for unrated coins when coverage is sufficient", () => {
    const coins = [
      { safetyScore: 80, supplyUsd: 800_000 },
      { safetyScore: null as number | null, supplyUsd: 200_000 },
    ];
    const score = computeQualityScore(coins, 0.5);
    // 80% at 80, 20% at 40 => 72
    expect(score).toBe(72);
  });
});

describe("computeHealthScore", () => {
  it("computes weighted composite", () => {
    const score = computeHealthScore({
      quality: 80,
      concentration: 60,
      pegStability: 90,
      backingDiversity: 40,
    });
    // 0.35*80 + 0.25*60 + 0.25*90 + 0.15*40 = 28+15+22.5+6 = 71.5 => 72
    expect(score).toBe(72);
  });

  it("returns null when quality is null", () => {
    expect(computeHealthScore({
      quality: null,
      concentration: 60,
      pegStability: 90,
      backingDiversity: 40,
    })).toBeNull();
  });
});

describe("getHealthBand", () => {
  it("maps score ranges correctly", () => {
    expect(getHealthBand(85)).toBe("robust");
    expect(getHealthBand(65)).toBe("healthy");
    expect(getHealthBand(45)).toBe("mixed");
    expect(getHealthBand(25)).toBe("fragile");
    expect(getHealthBand(10)).toBe("concentrated");
    expect(getHealthBand(null)).toBeNull();
  });
});

describe("HEALTH_METHODOLOGY_VERSION", () => {
  it("is a semver-like string", () => {
    expect(HEALTH_METHODOLOGY_VERSION).toMatch(/^\d+\.\d+$/);
  });
});
