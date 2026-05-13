import { describe, expect, it } from "vitest";

import {
  buildCalibrationReport,
  GOLDEN_FIXTURES,
  parseArgs,
  scoreRows,
} from "../yield-pys-v8-calibration";

function row(overrides: Record<string, unknown>) {
  return {
    id: "base-usd",
    symbol: "BASE",
    name: "Base USD",
    currentApy: 4,
    apy7d: 4,
    apy30d: 4,
    apyBase: 4,
    apyReward: 0,
    yieldSource: "Fixture source",
    yieldType: "lending-vault",
    dataSource: "defillama",
    sourceTvlUsd: 10_000_000,
    pharosYieldScore: null,
    safetyScore: 80,
    safetyGrade: "B",
    yieldToRisk: null,
    excessYield: 1,
    benchmarkKey: "USD",
    benchmarkRate: 3,
    yieldStability: 0.9,
    apyVariance30d: 0.1,
    apyMin30d: 3.8,
    apyMax30d: 4.2,
    warningSignals: [],
    altSources: [],
    provenance: {
      sourceKey: "fixture:base",
      sourceObservedAt: 1_700_000_000,
      sourceAgeSeconds: 3600,
      confidenceTier: "curated",
      selectionMethod: "confidence-weighted",
      selectionReason: "fixture",
      sourceSwitch: false,
      previousBestSourceKey: null,
      usedLegacyHistory: false,
      usedDefaultSafety: false,
      benchmarkRecordDate: "2026-05-13",
      benchmarkIsFallback: false,
      benchmarkFallbackMode: null,
      anomalies: [],
    },
    ...overrides,
  };
}

describe("yield-pys-v8-calibration", () => {
  it("parses input and output arguments", () => {
    expect(parseArgs(["--input", "rankings.json", "--out", "agents/report.md"], new Date("2026-05-13T00:00:00Z"))).toEqual({
      inputPath: "rankings.json",
      outputPath: "agents/report.md",
      generatedAt: "2026-05-13T00:00:00.000Z",
    });
    expect(() => parseArgs(["--input"])).toThrow("--input requires a value");
  });

  it("applies source-risk penalties without changing the v7 baseline score", () => {
    const scored = scoreRows([
      row({ id: "clean", symbol: "CLN", apy30d: 8, currentApy: 8 }),
      row({
        id: "reward-heavy",
        symbol: "RWD",
        apy30d: 14,
        currentApy: 14,
        sourceRisk: {
          rewardShare: 0.9,
          sourceRiskPenalty: 2.5,
        },
      }),
      row({ id: "zero", symbol: "ZERO", apy30d: 0, currentApy: 0 }),
    ]);

    const rewardHeavy = scored.find((item) => item.id === "reward-heavy");
    const zero = scored.find((item) => item.id === "zero");

    expect(rewardHeavy?.driver).toBe("reward-heavy");
    expect(rewardHeavy?.v7Score).toBeGreaterThan(rewardHeavy?.v8Score ?? 0);
    expect(rewardHeavy?.sourceRiskPenalty).toBe(2.5);
    expect(zero?.v8Score).toBe(0);
    expect(zero?.driver).toBe("negative-zero");
  });

  it("renders required calibration sections and golden fixtures", () => {
    const markdown = buildCalibrationReport([
      row({ id: "eur", symbol: "EUR", benchmarkKey: "EUR", benchmarkRate: 2.5, sourceAgeSeconds: 30_000 }),
      row({ id: "missing-safety", symbol: "MISS", safetyScore: null }),
    ], "2026-05-13T00:00:00.000Z");

    expect(markdown).toContain("## Distribution");
    expect(markdown).toContain("## Top 20 Before");
    expect(markdown).toContain("## Top 20 After");
    expect(markdown).toContain("## Largest Rank Movers");
    expect(markdown).toContain("## Null-Rate Coverage");
    expect(markdown).toContain("## Non-USD Cohort Checks");
    expect(markdown).toContain("| EUR | 1 |");
    for (const fixture of GOLDEN_FIXTURES) {
      expect(markdown).toContain(`| ${fixture} |`);
    }
  });

  it("prefers nested sourceRisk fields while preserving legacy flat calibration artifacts", () => {
    const [nested, legacy] = scoreRows([
      row({
        id: "nested",
        symbol: "NEST",
        sourceRisk: {
          sourceRiskPenalty: 2,
          rewardShare: 0.9,
        },
        sourceRiskPenalty: 1,
        rewardShare: 0.1,
      }),
      row({
        id: "legacy",
        symbol: "LEG",
        sourceRiskPenalty: 2,
        rewardShare: 0.9,
      }),
    ]);

    expect(nested?.sourceRiskPenalty).toBe(2);
    expect(nested?.driver).toBe("reward-heavy");
    expect(legacy?.sourceRiskPenalty).toBe(2);
    expect(legacy?.driver).toBe("reward-heavy");
  });
});
