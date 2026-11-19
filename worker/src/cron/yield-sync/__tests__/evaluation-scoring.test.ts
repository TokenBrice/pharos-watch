import { describe, expect, it } from "vitest";
import { resolvePenaltyDerivedFields } from "../candidate-scoring";
import { resolveEvidenceNullReason } from "../../../lib/yield-ranking-helpers";
import { HOUR_SECONDS } from "@shared/lib/time-constants";
import { OPTIONAL_YIELD_SOURCES } from "@shared/lib/yield-source-cadence";
import { baseEvaluationInput, resolvedYield } from "../../__tests__/yield-evaluation.test-support";
import { evaluateYieldSourcesCooperative } from "../evaluation";

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

  it("keeps source and benchmark priorities independent of opportunity evidence", () => {
    for (const opportunityEvidenceComplete of [true, false, undefined]) {
      expect(resolveEvidenceNullReason({ ...healthy, referenceBenchmarkFreshness: "stale", opportunityEvidenceComplete }))
        .toBe("benchmark-stale");
      expect(resolveEvidenceNullReason({ ...healthy, sourceFreshness: "unknown", benchmarkFreshness: "stale", opportunityEvidenceComplete }))
        .toBe("source-freshness-unknown");
      expect(resolveEvidenceNullReason({ ...healthy, sourceFreshness: "stale", referenceBenchmarkFreshness: "stale", opportunityEvidenceComplete }))
        .toBe("source-stale");
      expect(resolveEvidenceNullReason({ ...healthy, benchmarkFreshness: "degraded", referenceBenchmarkFreshness: "degraded", opportunityEvidenceComplete }))
        .toBe(opportunityEvidenceComplete === false ? "opportunity-evidence-missing" : null);
    }
  });
});

describe("yield source age and divergence evidence", () => {
  it.each([
    ["2027-01-19T11:44:59Z", "fresh", false],
    ["2027-01-19T11:45:00Z", "fresh", true],
    ["2027-01-19T13:45:01Z", "stale", false],
  ] as const)("assesses Friday's USYC report over the MLK weekend at %s", async (asOf, freshness, aging) => {
    const { stablecoinId: id, sourceKey } = OPTIONAL_YIELD_SOURCES.hashnote;
    const startSec = Date.parse(asOf) / 1000;
    const input = baseEvaluationInput({ startSec, resolved: [{ id, symbol: "USYC", yield: resolvedYield({
      dataSource: "protocol-api", sourceKey, sourceObservedAt: Date.parse("2027-01-15T11:45:00Z") / 1000,
    }) }] });
    const { evaluatedSources: [row] } = await evaluateYieldSourcesCooperative(input);
    expect(row.sourceFreshness).toBe(freshness);
    expect(row.rejected).toBe(freshness === "stale");
    expect(row.warnings.includes("aging")).toBe(aging);
  });

  it.each([[30, 0], [49, 0.25]])("applies reUSD's age penalty at %sh only when overdue", async (ageHours, surcharge) => {
    const { stablecoinId: id, sourceKey } = OPTIONAL_YIELD_SOURCES.re;
    const input = baseEvaluationInput();
    const evaluate = async (age: number) => (await evaluateYieldSourcesCooperative({
      ...input,
      resolved: [{ id, symbol: "reUSD", yield: resolvedYield({
        dataSource: "protocol-api", sourceKey, sourceObservedAt: input.startSec - age * HOUR_SECONDS,
      }) }],
    })).evaluatedSources[0];
    const current = await evaluate(0);
    const aged = await evaluate(ageHours);
    expect(aged.sourceFreshness).toBe("fresh");
    expect(aged.sourceRiskPenalty - current.sourceRiskPenalty).toBeCloseTo(surcharge);
    expect(aged.warnings.includes("aging")).toBe(surcharge > 0);
  });

  it("flags excess APY only against a populated same-unit cohort", async () => {
    const input = baseEvaluationInput({ resolved: [
      { id: "usdc-circle", currency: "USD", apy: 4 },
      { id: "usdt-tether", currency: "USD", apy: 4 },
      { id: "dai-makerdao", currency: "USD", apy: 4 },
      { id: "usds-sky", currency: "USD", apy: 15 },
      { id: "a7a5-old-vector", currency: "RUB", apy: 15 },
    ].map(({ id, currency, apy }) => ({ id, symbol: currency, yield: resolvedYield({ currentApy: apy }) })) });
    const { evaluatedSources } = await evaluateYieldSourcesCooperative(input);
    expect(evaluatedSources.filter((row) => row.warnings.includes("yield-divergence")).map((row) => row.id))
      .toEqual(["usds-sky"]);
  });

  it.each([[0, "unknown", false], [8, "stale", true]] as const)("uses a %sh pool batch age only for delivery", async (ageHours, freshness, rejected) => {
    const input = baseEvaluationInput({
      dlPoolsMeta: { mode: "dex-cache", updatedAt: null, ageSeconds: ageHours * HOUR_SECONDS, poolCount: 1, fallbackMode: null },
      resolved: [{ id: "coin-a", symbol: "A", yield: resolvedYield({ sourceObservedAt: null }) }],
    });
    const { evaluatedSources: [row] } = await evaluateYieldSourcesCooperative(input);
    expect(row).toMatchObject({ sourceObservedAt: null, sourceFreshness: freshness, rejected, pharosYieldScore: null });
  });
});
