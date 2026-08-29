import { describe, expect, it } from "vitest";
import {
  buildV9PortfolioProjection,
  buildV9SafetyTableMap,
  buildV9SafetyTableRows,
  getV9GradeRiskBucket,
  resolveV9ConsumerResponse,
} from "@/lib/safety-score-v9-consumers";
import { buildStablecoinTableInputs } from "@/lib/stablecoin-table-inputs";
import {
  makeReportCardsV9Response,
  makeV9Card,
} from "@/test/fixtures/safety-score-v9";

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

  it("rejects historical report versions at the live transition boundary", () => {
    const response = makeReportCardsV9Response();
    expect(resolveV9ConsumerResponse(
      { ...response, schemaVersion: 3 },
      response.safetyScoreIdentity,
    )).toEqual({
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
      makeV9Card({ id: "asset-b", score: 88, grade: "A+", qualityScore: 90, pegAdjustedScore: 88 }),
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

  it("preserves evidence, weakest-pillar, binding-cap, and mint summaries in table rows", () => {
    const bindingCap = {
      kind: "reason:missing-mint-authority",
      limit: 80,
      source: "evidence" as const,
      reason: "Mint control evidence is incomplete.",
      binding: true,
    };
    const card = makeV9Card({
      id: "asset-summary",
      evidence: { level: "insufficient", freshness: "stale", reasons: [] },
      caps: [bindingCap],
      bindingCap,
    });
    const response = makeReportCardsV9Response({ cards: [card] });
    const rows = buildV9SafetyTableRows(response, response.safetyScoreIdentity);

    expect(rows.status).toBe("available");
    if (rows.status !== "available") return;
    expect(rows.value[0]).toMatchObject({
      id: card.id,
      score: card.score,
      grade: card.grade,
      pillars: card.pillars,
      evidence: card.evidence,
      weakestPillar: card.weakestPillar,
      bindingCapReason: bindingCap.reason,
      mint: { score: card.pillars.control.score, posture: "distributed" },
    });
  });

  it("keeps NR, insufficient evidence, and absent breakdowns fail-closed", () => {
    const nrCard = makeV9Card({
      id: "asset-nr",
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
      evidence: { level: "insufficient", freshness: "unknown", reasons: [] },
      breakdowns: null,
    });
    const response = makeReportCardsV9Response({ cards: [nrCard] });
    const rows = buildV9SafetyTableRows(response, response.safetyScoreIdentity);

    expect(rows.status).toBe("available");
    if (rows.status !== "available") return;
    expect(rows.value).toHaveLength(1);
    expect(rows.value[0]).toMatchObject({
      score: null,
      grade: "NR",
      evidence: nrCard.evidence,
      weakestPillar: null,
      bindingCapReason: null,
      mint: null,
    });
    expect(rows.value[0]?.pillars.backing.score).toBeNull();
  });

  it("feeds the stable table, screener, and freezewatch from identical V9 values", () => {
    const card = makeV9Card({
      id: "asset-shared",
      evidence: { level: "adequate", freshness: "current", reasons: [] },
      weakestPillar: { pillar: "backing", score: 80 },
    });
    const response = makeReportCardsV9Response({ cards: [card] });
    const expected = buildV9SafetyTableMap(response, response.safetyScoreIdentity);
    const table = buildStablecoinTableInputs({ reportCardsV9: response }).reportCards;
    const screener = buildV9SafetyTableMap(response, response.safetyScoreIdentity);
    const freezewatch = buildV9SafetyTableMap(response, response.safetyScoreIdentity);

    expect(expected.status).toBe("available");
    expect(screener.status).toBe("available");
    expect(freezewatch.status).toBe("available");
    if (expected.status !== "available" || screener.status !== "available" || freezewatch.status !== "available") return;

    expect(table?.[card.id]).toEqual(expected.value[card.id]);
    expect(screener.value[card.id]).toEqual(expected.value[card.id]);
    expect(freezewatch.value[card.id]).toEqual(expected.value[card.id]);
  });

  it("builds a three-pillar portfolio aggregate without inventing an asset grade", () => {
    const cards = [
      makeV9Card({ id: "asset-a", score: 80, grade: "A-", qualityScore: 82, pegAdjustedScore: 80 }),
      makeV9Card({
        id: "asset-b",
        score: 90,
        grade: "A+",
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
        pillars: { backing: 88, exit: 90, control: 92 },
        dependencyExposure: [{
          upstreamAssetId: "asset-a",
          dependentAssetId: "asset-b",
          kind: "basket",
          exposureUsd: 150,
        }],
      },
    });
  });

  it("fails closed for NR portfolios", () => {
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
  });

  it("returns no table rows when the publication identity mismatches", () => {
    const response = makeReportCardsV9Response();
    const expectedIdentity = {
      ...response.safetyScoreIdentity,
      publicationGenerationId: "v9-publication-other",
    };

    expect(buildV9SafetyTableMap(response, expectedIdentity)).toEqual({
      status: "unavailable",
      reason: "identity-mismatch",
    });
    expect(buildV9SafetyTableRows(response, expectedIdentity)).toEqual({
      status: "unavailable",
      reason: "identity-mismatch",
    });
  });
});
