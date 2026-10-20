import { describe, expect, it } from "vitest";
import { resolveYieldRowSafety } from "@shared/lib/yield-opportunity-risk";
import { qualifyYieldEvidence, scoreYieldPys } from "../yield-ranking-helpers";

const evidence = {
  evidenceClass: "direct-onchain" as const,
  sourceFreshness: "fresh" as const,
  benchmarkFreshness: "healthy" as const,
  referenceBenchmarkFreshness: "healthy" as const,
  sourceDepthRatio: 0.1,
  observationCount30d: 9,
  apyBase: 5,
  apyReward: null,
  warnings: ["yield-spike", "safety-unrated", "opportunity-evidence-missing"],
};
const scoreInput = {
  apy30d: 5, safetyScore: 80, apyVarianceScore: 0, scalingFactor: 8,
  benchmarkRate: 4.2, benchmarkCurrency: "USD", usdBenchmarkRate: 4.2, sourceRiskPenalty: 1.2,
};

function safety(yieldType: "nav-appreciation" | "lending-opportunity", underlyingSafety = { score: 80, grade: "A-" }) {
  return resolveYieldRowSafety({
    yieldType, underlyingSafety, defaultSafetyScore: 40, ratedProvenance: "cached-publish",
    sourceRisk: { venueProtocol: "aave-v3", sourceRiskPenalty: 1.2 }, sourceTvlUsd: 1_000_000,
  });
}

describe("normalized yield qualification and final scoring", () => {
  it.each(["nav-appreciation", "lending-opportunity"] as const)("consumes canonical %s safety without changing warning order", yieldType => {
    const resolution = safety(yieldType);
    const result = qualifyYieldEvidence({ ...evidence, safety: resolution });
    expect(result).toEqual({ evidenceCompleteness: 1, scoreQualification: "rated",
      warnings: ["yield-spike"], evidenceNullReason: null });
    const scored = scoreYieldPys({ ...scoreInput, safetyScore: resolution.safetyScore, nullReason: result.evidenceNullReason });
    expect(scored.pharosYieldScore).toBeGreaterThan(0);
    expect(scored.pysNullReason).toBeNull();
    expect(scored.components.sourceRiskPenalty).toBe(1.2);
    expect(evidence.warnings).toEqual(["yield-spike", "safety-unrated", "opportunity-evidence-missing"]);
  });

  it.each(["healthy", "degraded", "stale"] as const)("qualifies %s benchmark evidence before scoring", benchmarkFreshness => {
    const result = qualifyYieldEvidence({ ...evidence, safety: safety("nav-appreciation"), benchmarkFreshness });
    expect(result.scoreQualification).toBe(benchmarkFreshness === "healthy" ? "rated" : benchmarkFreshness === "degraded" ? "estimated" : "NR");
    const scored = scoreYieldPys({ ...scoreInput, nullReason: result.evidenceNullReason });
    expect(scored.pysNullReason).toBe(benchmarkFreshness === "stale" ? "benchmark-stale" : null);
    expect(scored.pharosYieldScore === null).toBe(benchmarkFreshness === "stale");
  });

  it("preserves unavailable variance, negative APY and legitimately rounded zero", () => {
    expect(scoreYieldPys({ ...scoreInput, apyVarianceScore: null, nullReason: null }))
      .toMatchObject({ pharosYieldScore: null, pysNullReason: "missing-inputs" });
    expect(scoreYieldPys({ ...scoreInput, apy30d: -1, nullReason: null }))
      .toMatchObject({ pharosYieldScore: null, pysNullReason: "apy-non-positive" });
    expect(scoreYieldPys({ ...scoreInput, apy30d: 0.001, benchmarkRate: 0.001, usdBenchmarkRate: 0.001, nullReason: null }))
      .toMatchObject({ pharosYieldScore: 0, pysNullReason: null });
  });

  it("keeps default safety estimated and appends only missing safety warnings", () => {
    const resolution = resolveYieldRowSafety({ yieldType: "nav-appreciation", underlyingSafety: undefined,
      defaultSafetyScore: 40, sourceRisk: null, sourceTvlUsd: null, ratedProvenance: "cached-publish" });
    const result = qualifyYieldEvidence({ ...evidence, safety: resolution, sourceDepthRatio: null,
      observationCount30d: null, warnings: ["data-stale", "benchmark-degraded"] });
    expect(result).toEqual({ evidenceCompleteness: 0.4286, scoreQualification: "estimated",
      evidenceNullReason: null, warnings: ["data-stale", "benchmark-degraded", "safety-unrated"] });
    expect(scoreYieldPys({ ...scoreInput, safetyScore: resolution.safetyScore, nullReason: result.evidenceNullReason }).pharosYieldScore).toBeGreaterThan(0);
  });

  it("preserves caller-admitted publish-time safety and explicit null-reason priority", () => {
    const publishedSafetyScore = 52;
    const scored = scoreYieldPys({ ...scoreInput, safetyScore: publishedSafetyScore, nullReason: null });
    expect(scored.components.riskPenalty).toBe(2.45);
    expect(scored.pharosYieldScore).toBeGreaterThan(0);
    expect(scoreYieldPys({ ...scoreInput, apy30d: -1, nullReason: "safety-unrated" }))
      .toMatchObject({ pharosYieldScore: null, pysNullReason: "safety-unrated" });
    const result = qualifyYieldEvidence({ ...evidence, safety: safety("nav-appreciation"),
      sourceFreshness: "stale", referenceBenchmarkFreshness: "stale" });
    expect(result.evidenceNullReason).toBe("source-stale");
    expect(scoreYieldPys({ ...scoreInput, nullReason: result.evidenceNullReason }))
      .toMatchObject({ pharosYieldScore: null, pysNullReason: "source-stale" });
  });
});
