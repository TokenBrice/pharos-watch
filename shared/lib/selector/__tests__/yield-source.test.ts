import { describe, expect, it } from "vitest";
import { selectYieldSource } from "../yield-source";
import type { MergedRow, YieldSourceCandidate } from "../types";
import { buildFixtureData, makeInput } from "./fixture";

/**
 * Regression for audit Q-072: selectYieldSource must measure candidate excess
 * APY against the row's per-coin benchmarkRate (same definition the main scorer
 * uses) rather than a hardcoded 4% floor, so non-USD pegs and shifted market
 * benchmarks rank consistently with the primary score.
 */
describe("selectYieldSource benchmark threading", () => {
  const base = buildFixtureData().rows.get("usds-sky")!;

  const candidate = (
    sourceKey: string,
    apy30d: number,
    sourceRiskScore: number,
  ): YieldSourceCandidate => ({
    sourceKey,
    protocol: sourceKey,
    chain: "Ethereum",
    yieldType: "lending-vault",
    apy30d,
    pharosYieldScore: 80,
    sourceTvlUsd: 100_000_000,
    dataSource: "test",
    sourceRiskScore,
    venueRiskTier: "low",
    deploymentPlace: "lending",
    sourceDepthRatio: 0.8,
    sourceSwitchCount30d: 0,
    observationCount30d: 30,
    freshness: { capturedAt: 1_700_000_000, ageSeconds: 120 },
    isPrimary: true,
  });

  // "safe-low-apy" has a slightly better risk score; "high-apy" has higher APY.
  // The APY term only counts when a candidate's APY clears the benchmark, so the
  // per-coin benchmarkRate decides which source wins.
  const makeRow = (benchmarkRate: number | null): MergedRow => ({
    ...base,
    benchmarkRate,
    yieldSources: [candidate("safe-low-apy", 2.5, 15), candidate("high-apy", 7, 20)],
  });

  const input = makeInput({ profile: "yield", venuePreferences: ["lend"] });

  it("lets the higher-APY source win when it clears a low per-coin benchmark", () => {
    // benchmark 1 -> high-apy excess 6 dominates its risk deficit.
    const selected = selectYieldSource(makeRow(1), input);
    expect(selected?.sourceKey).toBe("high-apy");
  });

  it("falls back to the safer source once the benchmark neutralizes APY excess", () => {
    // benchmark 8 > both APYs -> excess clamps to 0 for both, so the APY term
    // no longer rewards high-apy and its risk deficit makes safe-low-apy win.
    const selected = selectYieldSource(makeRow(8), input);
    expect(selected?.sourceKey).toBe("safe-low-apy");
  });
});
