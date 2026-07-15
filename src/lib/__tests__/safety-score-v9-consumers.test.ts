import { describe, expect, it } from "vitest";
import {
  buildRegistryFreezeFallback,
  buildV9AccessCoverageProjection,
  buildV9DependencyProjection,
  buildV9PortfolioProjection,
  buildV9SafetyTableRows,
  getV9BluechipFloorAvailability,
  getV9GradeRiskBucket,
  getV9StressAvailability,
  resolveV9ConsumerResponse,
} from "@/lib/safety-score-v9-consumers";
import { makeReportCardsV9Response, makeV9Card } from "@/test/fixtures/safety-score-v9";

describe("V9 safety consumer projections", () => {
  it("requires a complete exact identity and rejects stale previous publications", () => {
    const response = makeReportCardsV9Response();
    expect(resolveV9ConsumerResponse(response, response.safetyScoreIdentity).status).toBe("available");

    const expectedIdentity = {
      ...response.safetyScoreIdentity,
      publicationGenerationId: "v9-publication-2",
    };
    expect(resolveV9ConsumerResponse(response, expectedIdentity)).toEqual({
      status: "unavailable",
      reason: "identity-mismatch",
    });
    expect(resolveV9ConsumerResponse({ ...response, safetyScoreIdentity: undefined }, expectedIdentity)).toEqual({
      status: "unavailable",
      reason: "invalid-v9-response",
    });
  });

  it("uses explicit V9 grade classes and three-pillar table rows", () => {
    expect(getV9GradeRiskBucket("B-")).toBe("safe");
    expect(getV9GradeRiskBucket("C+")).toBe("neutral");
    expect(getV9GradeRiskBucket("C")).toBe("neutral");
    expect(getV9GradeRiskBucket("C-")).toBe("neutral");
    expect(getV9GradeRiskBucket("D")).toBe("risky");
    expect(getV9GradeRiskBucket("NR")).toBe("unavailable");

    const cards = [
      makeV9Card({ id: "asset-a", score: 61, grade: "C+", qualityScore: 62, pegAdjustedScore: 61 }),
      makeV9Card({ id: "asset-b", score: 88, grade: "A-", qualityScore: 90, pegAdjustedScore: 88 }),
    ];
    const response = makeReportCardsV9Response({ cards });
    const rows = buildV9SafetyTableRows(response, response.safetyScoreIdentity);
    expect(rows.status).toBe("available");
    if (rows.status !== "available") return;
    expect(rows.value.map((row) => [row.id, row.riskBucket])).toEqual([
      ["asset-b", "safe"],
      ["asset-a", "neutral"],
    ]);
    expect(rows.value[0]).toHaveProperty("pillars.backing");
    expect(rows.value[0]).not.toHaveProperty("dimensions");
  });

  it("projects serial and basket materiality without V8 dependency semantics", () => {
    const cards = [
      makeV9Card({ id: "asset-a" }),
      makeV9Card({
        id: "asset-b",
        dependencies: {
          serial: [{ upstreamAssetId: "asset-a", score: 84, blocked: true }],
          basket: [{ upstreamAssetId: "asset-c", score: null, weight: 0.25, boundedUnknown: true }],
          cycleBlocked: false,
          reasonCodes: [],
        },
      }),
    ];
    const response = makeReportCardsV9Response({ cards });
    const projected = buildV9DependencyProjection(response, response.safetyScoreIdentity);
    expect(projected.status).toBe("available");
    if (projected.status !== "available") return;
    expect(projected.value.edges).toEqual([
      expect.objectContaining({ from: "asset-a", to: "asset-b", materiality: "serial-blocked", weight: null }),
      expect.objectContaining({ from: "asset-c", to: "asset-b", materiality: "basket-bounded-unknown", weight: 0.25 }),
    ]);
  });

  it("uses V9 access/evidence for coverage and labels registry fallback as non-V9 evidence", () => {
    const response = makeReportCardsV9Response();
    const projection = buildV9AccessCoverageProjection(response, response.safetyScoreIdentity, "usdc-circle");
    expect(projection).toMatchObject({
      status: "available",
      value: {
        freezeStatus: "direct",
        liveReserveFresh: null,
        provenance: "v9-access-posture",
        evidence: { level: "adequate", freshness: "current" },
      },
    });
    expect(buildRegistryFreezeFallback("possible")).toEqual({
      status: "possible",
      provenance: "registry-fallback",
      countsAsV9Evidence: false,
    });
  });

  it("builds a three-pillar portfolio aggregate without inventing an asset grade", () => {
    const cards = [
      makeV9Card({ id: "asset-a", score: 80, grade: "B", qualityScore: 82, pegAdjustedScore: 80 }),
      makeV9Card({
        id: "asset-b",
        score: 90,
        grade: "A",
        qualityScore: 92,
        pegAdjustedScore: 90,
        dependencies: {
          serial: [],
          basket: [{ upstreamAssetId: "asset-a", score: 80, weight: 0.5, boundedUnknown: false }],
          cycleBlocked: false,
          reasonCodes: [],
        },
      }),
    ];
    const response = makeReportCardsV9Response({ cards });
    const result = buildV9PortfolioProjection(response, response.safetyScoreIdentity, [
      { coinId: "asset-a", amount: 100 },
      { coinId: "asset-b", amount: 300 },
    ]);
    expect(result).toMatchObject({
      status: "available",
      value: {
        aggregateLabel: "weighted-safety-aggregate",
        score: 88,
        assetGrade: null,
        pillars: { backing: 88, exit: 82, control: 84 },
        dependencyExposure: [{
          upstreamAssetId: "asset-a",
          dependentAssetId: "asset-b",
          kind: "basket",
          exposureUsd: 150,
        }],
      },
    });
  });

  it("fails closed for NR portfolios and unapproved V9 stress and Bluechip rules", () => {
    const nrCard = makeV9Card({
      score: null,
      grade: "NR",
      qualityScore: null,
      pegMultiplier: null,
      pegAdjustedScore: null,
      pillars: {
        backing: { score: null, evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
        exit: { score: null, evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
        control: { score: null, evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
      },
      weakestPillar: null,
      nrReasons: [{ code: "missing-pillar", message: "Required pillar evidence is missing.", field: "backing", origin: "asset" }],
    });
    const response = makeReportCardsV9Response({ cards: [nrCard] });
    expect(buildV9PortfolioProjection(response, response.safetyScoreIdentity, [{ coinId: nrCard.id, amount: 1 }])).toEqual({
      status: "unavailable",
      reason: "portfolio-card-not-rated",
    });
    expect(getV9StressAvailability(response, response.safetyScoreIdentity)).toEqual({
      status: "unavailable",
      reason: "v9-stress-mapping-unapproved",
    });
    expect(getV9BluechipFloorAvailability(response, response.safetyScoreIdentity)).toEqual({
      status: "unavailable",
      reason: "v9-bluechip-floor-unreviewed",
    });
  });
});
