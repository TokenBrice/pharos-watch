import { describe, expect, it } from "vitest";
import { resolveEvidenceNullReason, resolvePenaltyDerivedFields } from "../evaluation-scoring";

const base = {
  apy30d: 5,
  safetyScore: 80,
  apyVarianceScore: 0.1,
  benchmarkRate: 4,
  benchmarkCurrency: "USD",
  usdBenchmarkRate: 4,
  sourceRiskPenalty: 1,
  safetySnapshotUnavailable: false,
  evidenceNullReason: null,
};

describe("resolvePenaltyDerivedFields", () => {
  it("publishes no score whenever a null reason exists", () => {
    for (const input of [
      { ...base, apy30d: 301, benchmarkRate: 301 },
      { ...base, apyVarianceScore: null },
    ]) {
      expect(resolvePenaltyDerivedFields(input)).toMatchObject({
        pharosYieldScore: null,
        pysNullReason: "missing-inputs",
      });
    }
  });

  it("keeps a legitimately rounded-zero score scored", () => {
    expect(resolvePenaltyDerivedFields({ ...base, apy30d: 0.001, benchmarkRate: 0.001, usdBenchmarkRate: 0.001 }))
      .toMatchObject({ pharosYieldScore: 0, pysNullReason: null });
  });

  it("keeps measured zero variance eligible for a positive score", () => {
    expect(resolvePenaltyDerivedFields({ ...base, apyVarianceScore: 0 }).pharosYieldScore).toBeGreaterThan(0);
  });
});

describe("resolveEvidenceNullReason", () => {
  const healthy = {
    sourceFreshness: "fresh" as const,
    benchmarkFreshness: "healthy" as const,
    referenceBenchmarkFreshness: "healthy" as const,
  };

  it("withholds PYS for missing opportunity evidence after freshness failures", () => {
    expect(resolveEvidenceNullReason({ ...healthy, opportunityEvidenceComplete: false }))
      .toBe("opportunity-evidence-missing");
    expect(resolveEvidenceNullReason({ ...healthy, sourceFreshness: "stale", opportunityEvidenceComplete: false }))
      .toBe("source-stale");
    expect(resolveEvidenceNullReason({ ...healthy, sourceFreshness: "unknown", opportunityEvidenceComplete: false }))
      .toBe("source-freshness-unknown");
    expect(resolveEvidenceNullReason({ ...healthy, benchmarkFreshness: "stale", opportunityEvidenceComplete: false }))
      .toBe("benchmark-stale");
    expect(resolveEvidenceNullReason({ ...healthy, opportunityEvidenceComplete: true })).toBeNull();
  });
});
