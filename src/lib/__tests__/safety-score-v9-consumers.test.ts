import { describe, expect, it } from "vitest";
import { internV9PublicWitnessTexts } from "@shared/lib/safety-score-v9/public-witness-texts";
import { projectV9Table, projectV9TableCard, projectV9Detail } from "@shared/lib/report-cards-v9-projections";
import { ReportCardsV9DetailResponseSchema, ReportCardsV9TableResponseSchema } from "@shared/types/report-cards-v9-projections";
import {
  buildV9PortfolioProjection,
  buildV9SafetyTableMap,
  buildV9SafetyTableRows,
  getV9GradeRiskBucket,
  resolveV9ConsumerResponse,
  readV9CardMintComponent,
  readV9CardIssuanceSummary,
} from "@/lib/safety-score-v9-consumers";
import { buildStablecoinTableInputs } from "@/lib/stablecoin-table-inputs";
import { makePublishedProcessDiagnostic } from "@shared/lib/__tests__/safety-score-v9-fixtures.test-support";
import {
  makeReportCardsV9ArchivedResponse,
  makeReportCardsV9Response,
  makeV9Card,
  makeV9Pillars,
} from "@/test/fixtures/safety-score-v9";

import { makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard, makeReportCardsV9PricedExcludedCard } from "@shared/test-utils/report-cards-v9";
import { ReportCardsV9CurrentResponseSchema } from "\@shared/types/report-cards-v9-current";
import { resolveSchemaLike } from "@shared/lib/schema-like";
import { buildV9RadarDataset } from "@/components/radar-chart-v9";
import { buildV9GradeCounts, buildV9PillarAverages, buildV9HeadlineStats, filterAndSortV9Cards } from "@/app/safety-scores/v9-view-model";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "../api-query-descriptors";
import { buildDetailDependencyContext } from "@/components/stablecoin-detail/dependency-context-model";
import { projectDependencyGraph } from "@shared/types/dependency-graph";

describe("V9 safety consumer projections", () => {
  it("requires resolved witness text at the independent consumer parser boundary", () => {
    const semantic = makeReportCardsV9Response();
    const reason = { code: "unresolved-control-identity" as const, message: "The independently scoped incident disposition remains unknown.", path: "control:incidentState" };
    semantic.cards[0]!.evidence.reasons = [reason];
    semantic.cards[0]!.pillars.control.reasons = [reason];
    const wire = { ...semantic, cards: semantic.cards.map((card) => internV9PublicWitnessTexts(card)) };
    expect(resolveV9ConsumerResponse(wire, semantic.safetyScoreIdentity)).toEqual({
      status: "unavailable", reason: "invalid-v9-response",
    });
    expect(resolveV9ConsumerResponse(semantic, semantic.safetyScoreIdentity)).toEqual({
      status: "available", identity: semantic.safetyScoreIdentity, value: semantic,
    });
  });
  it("preserves technical gap nulls and excludes them from grade risk buckets", () => {
    const gap = makeReportCardsV9PipelineGapCard("control", "A");
    const response = makeReportCardsV9Response({ cards: [gap] });
    expect(buildV9SafetyTableRows(response, response.safetyScoreIdentity)).toMatchObject({
      status: "available",
      value: [{ grade: null, score: null, ratingStatus: "pipeline-gap", riskBucket: null }],
    });
    for (const filter of ["safe", "neutral", "risky", "unavailable"] as const) {
      expect(buildV9SafetyTableRows(response, response.safetyScoreIdentity, filter)).toMatchObject({
        status: "available", value: [],
      });
    }
  });

  it("uses known-only score and per-pillar USD denominators for partial portfolios", () => {
    const known = makeReportCardsV9PartialCard("exit", "B", { id: "partial" });
    const gap = makeReportCardsV9PipelineGapCard(null, "A", { id: "gap" });
    const response = makeReportCardsV9Response({ cards: [gap, known] });
    expect(buildV9PortfolioProjection(response, response.safetyScoreIdentity, [
      { coinId: "partial", amount: 100 }, { coinId: "gap", amount: 300 },
    ])).toMatchObject({
      status: "available",
      value: {
        score: known.score, assetGrade: null, partialEvidence: true,
        pillars: { backing: 80, exit: null, control: 80 },
        coverageUsd: { total: 400, score: 100, pillars: { backing: 100, exit: 0, control: 100 } },
      },
    });
  });

  it("aggregates pillars whose optional aggregationDisposition is absent (defaults to included)", () => {
    const base = makeV9Card({ id: "implicit" });
    const pillars = Object.fromEntries((["backing", "exit", "control"] as const).map((key) => {
      const { aggregationDisposition: _omit, ...rest } = base.pillars[key];
      return [key, rest];
    })) as typeof base.pillars;
    const card = { ...base, pillars };
    const response = makeReportCardsV9Response({ cards: [card] });
    const result = buildV9PortfolioProjection(response, response.safetyScoreIdentity, [{ coinId: "implicit", amount: 10 }]);
    expect(result).toMatchObject({ status: "available", value: { pillars: { backing: base.pillars.backing.score, exit: base.pillars.exit.score, control: base.pillars.control.score } } });
  });

  it("returns null portfolio aggregates when no holding has a score", () => {
    const card = makeReportCardsV9PipelineGapCard(null, "B");
    const response = makeReportCardsV9Response({ cards: [card] });
    expect(buildV9PortfolioProjection(response, response.safetyScoreIdentity, [{ coinId: card.id, amount: 50 }]))
      .toMatchObject({ status: "available", value: {
        score: null, pillars: { backing: null, exit: null, control: null },
        coverageUsd: { total: 50, score: 0, pillars: { backing: 0, exit: 0, control: 0 } },
      } });
  });
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

  it("rejects independently changed canonical identity dimensions", () => {
    const response = makeReportCardsV9Response();
    const mutations = {
      methodologyVersion: "9.1",
      policyId: "another-policy",
      policyDigest: "e".repeat(64),
      evaluationBuildDigest: "f".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"1".repeat(64)}`,
      publicationGenerationId: "another-publication",
    };
    for (const [field, value] of Object.entries(mutations)) {
      expect(resolveV9ConsumerResponse(response, { ...response.safetyScoreIdentity, [field]: value }), field)
        .toEqual({ status: "unavailable", reason: "identity-mismatch" });
    }
    // Model/schema are literal V9 schema constraints, not mutable valid identities.
    for (const mutation of [{ model: "v8" }, { schemaVersion: 2 }]) {
      expect(resolveV9ConsumerResponse({
        ...response, safetyScoreIdentity: { ...response.safetyScoreIdentity, ...mutation },
      }, response.safetyScoreIdentity)).toEqual({ status: "unavailable", reason: "invalid-v9-response" });
    }
  });

  it("rejects held publications even when the held asset is rated", () => {
    const response = makeReportCardsV9Response();
    response.publicationHealth = {
      ...response.publicationHealth, status: "held", heldSinceSec: response.updatedAt,
      reasons: [{ code: "dex-stale" }],
    };
    expect(buildV9PortfolioProjection(response, response.safetyScoreIdentity, [{ coinId: "usdc-circle", amount: 100 }]))
      .toEqual({ status: "unavailable", reason: "v9-publication-held" });
  });

  it("ignores nonpositive unknown holdings but rejects an empty positive portfolio", () => {
    const response = makeReportCardsV9Response();
    const ignored = [{ coinId: "missing-zero", amount: 0 }, { coinId: "missing-negative", amount: -10 }];
    for (const holdings of [[], ignored]) {
      expect(buildV9PortfolioProjection(response, response.safetyScoreIdentity, holdings))
        .toEqual({ status: "unavailable", reason: "portfolio-empty" });
    }
    expect(buildV9PortfolioProjection(response, response.safetyScoreIdentity, [
      ...ignored, { coinId: "usdc-circle", amount: 100 },
    ])).toMatchObject({ status: "available", value: { score: 80, pillars: { backing: 80, exit: 82, control: 84 } } });
  });

  it("rejects a positive holding with no published card", () => {
    const response = makeReportCardsV9Response();
    expect(buildV9PortfolioProjection(response, response.safetyScoreIdentity, [
      { coinId: "usdc-circle", amount: 100 }, { coinId: "missing", amount: 1 },
    ])).toEqual({ status: "unavailable", reason: "portfolio-card-unavailable" });
  });

  it("attributes full serial exposure only to held dependents", () => {
    const dependent = (id: string) => makeV9Card({
      id, dependencies: {
        serial: [{ upstreamAssetId: "upstream", score: 80, ratingStatus: 80 === null ? "not-rated" as const : "rated" as const, partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: 80 === null ? ["U" as const] : [], blocked: false }],
        basket: [], cycleBlocked: false, reasonCodes: [],
      },
    });
    const response = makeReportCardsV9Response({
      cards: [dependent("held"), dependent("unheld"), makeV9Card({ id: "upstream" })],
    });
    const result = buildV9PortfolioProjection(response, response.safetyScoreIdentity, [{ coinId: "held", amount: 375 }]);
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error(result.reason);
    expect(result.value.dependencyExposure).toEqual([{
      upstreamAssetId: "upstream", dependentAssetId: "held", kind: "serial",
      materiality: "serial", exposureUsd: 375,
    }]);
  });
  it("keeps unknown basket shares unavailable, never $0, in the compact table projection", () => {
    const response = makeReportCardsV9Response({
      cards: ["held", "unheld", "up-half", "up-null", "up-serial", "up-zero"].map((id) => makeV9Card({ id })),
    });
    const table = projectV9Table(response);
    const edge = (from: string, to: string, kind: "serial" | "basket", weight: number | null) => ({
      from, to, kind, weight, upstreamScore: 80,
      materiality: kind === "serial" ? "serial" as const : weight === null ? "basket-bounded-unknown" as const : "basket-weighted" as const,
    });
    table.dependencyGraph = { edges: [
      edge("up-half", "held", "basket", 0.5),
      edge("up-half", "unheld", "basket", 0.5),
      edge("up-null", "held", "basket", null),
      edge("up-serial", "held", "serial", null),
      edge("up-zero", "held", "basket", 0),
    ] };
    expect(ReportCardsV9TableResponseSchema.safeParse(table).success).toBe(true);
    const result = buildV9PortfolioProjection(table, response.safetyScoreIdentity, [{ coinId: "held", amount: 300 }]);
    expect(result).toMatchObject({ status: "available" });
    if (result.status !== "available") throw new Error(result.reason);
    expect(result.value.dependencyExposure.map((row) => [row.upstreamAssetId, row.exposureUsd])).toEqual([
      ["up-half", 150], ["up-null", null], ["up-serial", 300], ["up-zero", 0],
    ]);
    const baseline = buildV9PortfolioProjection(projectV9Table(response), response.safetyScoreIdentity, [{ coinId: "held", amount: 300 }]);
    if (baseline.status !== "available") throw new Error(baseline.reason);
    expect(result.value.score).toBe(baseline.value.score);
    expect(result.value.pillars).toEqual(baseline.value.pillars);
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

  it("admits a report9 table projection", () => {
    const response = makeReportCardsV9Response();
    const table = projectV9Table(response);
    const result = buildV9SafetyTableMap({ ...table, schemaVersion: 9 }, response.safetyScoreIdentity);
    expect(result.status).toBe("available");
  });

  it("admits report9 with its open-evidence block and report8 as unavailable", () => {
    const report9 = makeReportCardsV9Response({
      openEvidence: {
        semantics: "open-question-v1",
        totals: { questions: 0, open: 0, issuer: 0, documentation: 0, obligations: 0 },
        owners: [],
        reasons: [],
        documentation: { questions: 0, datums: 0, facts: 0, reasons: [] },
        issuer: { questions: 0, assets: 0, oldestReviewedAtSec: null, newestReviewedAtSec: null },
        byCard: [],
      },
    });
    const result = resolveV9ConsumerResponse(report9, report9.safetyScoreIdentity);
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error(result.reason);
    expect(result.value.schemaVersion).toBe(9);
    expect(result.value.openEvidence?.semantics).toBe("open-question-v1");
    expect(result.value.openEvidenceUnavailableReason).toBeNull();
    expect(result.value.cards).toEqual(report9.cards);

    const report8 = makeReportCardsV9ArchivedResponse();
    const archived = resolveV9ConsumerResponse(report8, report8.safetyScoreIdentity);
    expect(archived.status).toBe("available");
    if (archived.status !== "available") throw new Error(archived.reason);
    // Report8 never carried the block: unavailable with its machine reason, never zero.
    expect(archived.value.openEvidence).toBeNull();
    expect(archived.value.openEvidenceUnavailableReason).toBe("publication-predates-open-evidence");

    const {
      openEvidence: _openEvidence,
      openEvidenceUnavailableReason: _openEvidenceUnavailableReason,
      ...pairless
    } = report9;
    expect(resolveV9ConsumerResponse(pairless, report9.safetyScoreIdentity)).toEqual({
      status: "unavailable",
      reason: "invalid-v9-response",
    });
    expect(resolveV9ConsumerResponse({ ...report9, schemaVersion: 10 }, report9.safetyScoreIdentity)).toEqual({
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
      kind: "parent",
      limit: 80,
      source: "parent" as const,
      reason: "The required parent limits the published score.",
      binding: true,
    };
    const card = makeV9Card({
      id: "asset-summary",
      evidence: { level: "insufficient", freshness: "stale", reasons: [] },
      caps: [bindingCap],
      bindingCap,
      dependencies: {
        serial: [{ upstreamAssetId: "required-parent", score: 80, blocked: false, ratingStatus: "rated", partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: [] }],
        basket: [], cycleBlocked: false, reasonCodes: [],
      },
    });
    const response = makeReportCardsV9Response({ cards: [card, makeV9Card({ id: "required-parent" })] });
    const rows = buildV9SafetyTableRows(response, response.safetyScoreIdentity);

    expect(rows.status).toBe("available");
    if (rows.status !== "available") return;
    expect(rows.value[0]).toMatchObject({
      id: card.id,
      score: card.score,
      grade: card.grade,
      pillars: {
        backing: { score: card.pillars.backing.score, aggregationDisposition: card.pillars.backing.aggregationDisposition },
        exit: { score: card.pillars.exit.score, aggregationDisposition: card.pillars.exit.aggregationDisposition },
        control: { score: card.pillars.control.score, aggregationDisposition: card.pillars.control.aggregationDisposition },
      },
      evidence: { level: card.evidence.level },
      weakestPillar: card.weakestPillar,
      bindingCapReason: bindingCap.reason,
      mint: { score: card.pillars.control.score, posture: "distributed" },
    });
    expect(buildV9SafetyTableRows(projectV9Table(response), response.safetyScoreIdentity)).toEqual(rows);
    expect(rows.value[0]?.pillars.backing).not.toHaveProperty("causeGapRefs");
    expect(rows.value[0]?.evidence).not.toHaveProperty("freshness");
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
        backing: { score: null, aggregationDisposition: "included", supportedComponentKeys: [], causeGapRefs: [], limitedEvidenceCauses: ["U"], evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
        exit: { score: null, aggregationDisposition: "included", supportedComponentKeys: [], causeGapRefs: [], limitedEvidenceCauses: ["U"], evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
        control: { score: null, aggregationDisposition: "included", supportedComponentKeys: [], causeGapRefs: [], limitedEvidenceCauses: ["U"], evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
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
      evidence: { level: nrCard.evidence.level },
      weakestPillar: null,
      bindingCapReason: null,
      mint: null,
    });
    expect(rows.value[0]?.pillars.backing.score).toBeNull();
    expect(buildV9SafetyTableRows(projectV9Table(response), response.safetyScoreIdentity)).toEqual(rows);
  });

  it("projects explicit V9 values into stable-table inputs", () => {
    const card = makeV9Card({
      id: "asset-shared",
      score: 61,
      grade: "C+",
      qualityScore: 62,
      pegAdjustedScore: 61,
      evidence: { level: "adequate", freshness: "current", reasons: [] },
      weakestPillar: { pillar: "backing", score: 60 },
    });
    const response = makeReportCardsV9Response({ cards: [card] });
    const table = buildStablecoinTableInputs({ reportCardsV9: response }).reportCards;
    expect(Object.keys(table ?? {})).toEqual(["asset-shared"]);
    expect(table?.["asset-shared"]).toMatchObject({
      score: 61,
      grade: "C+",
      riskBucket: "neutral",
      evidence: { level: "adequate" },
      weakestPillar: { pillar: "backing", score: 60 },
      bindingCapReason: null,
    });
    expect(buildStablecoinTableInputs({ reportCardsV9: projectV9Table(response) }).reportCards).toEqual(table);
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
          basket: [{ upstreamAssetId: "asset-a", score: 80, ratingStatus: 80 === null ? "not-rated" as const : "rated" as const, partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: 80 === null ? ["U" as const] : [], weight: 0.5, boundedUnknown: false }],
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
        backing: { score: null, aggregationDisposition: "included", supportedComponentKeys: [], causeGapRefs: [], limitedEvidenceCauses: ["U"], evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
        exit: { score: null, aggregationDisposition: "included", supportedComponentKeys: [], causeGapRefs: [], limitedEvidenceCauses: ["U"], evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
        control: { score: null, aggregationDisposition: "included", supportedComponentKeys: [], causeGapRefs: [], limitedEvidenceCauses: ["U"], evidenceLevel: "insufficient", freshness: "unknown", components: [], reasons: [] },
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

describe("published mint diagnostic consumer", () => {
  it("retains typed failures independently of an NR mint score and never invents missing process evidence", () => {
    const card = makeV9Card();
    const component = card.breakdowns!.control.components[0]!;
    const summary = { diagnostics: [makePublishedProcessDiagnostic({
      code: "operational-cap-unproved", gate: "H2", controlRef: null, pathId: null,
      classId: null, memberRef: null, field: "maxAnnualInterestGrowthPpm", evidenceRefIds: [],
    })] };
    card.breakdowns!.control.components = [{ ...component, kind: "mint", score: null }];
    card.breakdowns!.control.issuanceSummary = summary;
    expect(readV9CardMintComponent(card)).toBeNull();
    expect(readV9CardIssuanceSummary(card)?.diagnostics[0]).toMatchObject({ code: "operational-cap-unproved", count: 1, controlRefs: [null] });
    card.breakdowns!.control.issuanceSummary = undefined;
    expect(readV9CardIssuanceSummary(card)).toBeNull();
  });
});

function cohort() {
  return makeReportCardsV9Response({ cards: [
    makeV9Card({ id: "a-rated", score: 90 }),
    makeV9Card({ id: "b-nr", score: null, grade: "NR",
      nrReasons: [{ code: "unresolved-control-identity", message: "Control identity is unresolved.", field: null, origin: "asset" }] }),
    makeReportCardsV9PartialCard("exit", "B", { id: "c-partial" }),
    makeReportCardsV9PipelineGapCard("control", "A", { id: "d-gap" }),
  ] });
}

describe("compact score consumer equivalence", () => {
  it("accepts optional local exposure in full, table and detail readers without table emission", () => {
    const full = cohort();
    const exposure = { worstQuality: 60, coveredShare: 0.99,
      slices: [{ deploymentLabel: "Ethereum vault", share: 0.99, quality: 60 }], moreCount: 0 };
    full.cards[0]!.localAuthorityExposure = exposure;
    expect(ReportCardsV9CurrentResponseSchema.parse(full).cards[0]!.localAuthorityExposure).toEqual(exposure);
    const table = projectV9Table(full);
    expect(table.cards[0]).not.toHaveProperty("localAuthorityExposure");
    table.cards[0]!.localAuthorityExposure = exposure;
    expect(ReportCardsV9TableResponseSchema.parse(table).cards[0]!.localAuthorityExposure).toEqual(exposure);
    expect(ReportCardsV9DetailResponseSchema.parse(projectV9Detail(full, full.cards[0]!.id))
      .cards[0]!.localAuthorityExposure).toEqual(exposure);
    expect(ReportCardsV9TableResponseSchema.safeParse({ ...table,
      cards: table.cards.map((card, i) => i === 0 ? { ...card, localAuthorityExposure: { ...exposure, slices: Array(4).fill(exposure.slices[0]) } } : card),
    }).success).toBe(false);
  });
  it.each([
    { key: "backing" as const, cause: "C" as const, score: 35 },
    { key: "exit" as const, cause: "U" as const, score: 50 },
    { key: "control" as const, cause: "U" as const, score: 60 },
  ])("emits the $key assumption in table and neighborhood projections", ({ key, cause, score }) => {
    const card = makeV9Card({ pillars: makeV9Pillars({ backing: 80, exit: 82, control: 84, [key]: score }) });
    card.pillars[key].score = null;
    card.pillars[key].aggregationDisposition = "unavailable";
    card.pillars[key].supportedComponentKeys = [];
    card.pillars[key].limitedEvidenceCauses = [];
    card.scoreTrace.aggregation!.pricedUnknownPillars = [{ pillar: key, cause, score, causeGapRefs: [] }];
    card.scoreTrace.aggregation!.includedPillars = card.scoreTrace.aggregation!.includedPillars.filter(pillar => pillar !== key);
    card.scoreTrace.aggregation!.excludedPillars = [key];
    Object.assign(card.breakdowns![key], {
      aggregationDisposition: "unavailable", aggregationWeight: 0, evaluatedScore: null, publishedScore: null,
    });
    if (key === "backing") {
      card.breakdowns!.backing.groups = [];
      card.breakdowns!.backing.components = [];
    } else if (key === "exit") {
      card.breakdowns!.exit.primaryRoute = null;
      card.breakdowns!.exit.diversification = null;
      card.breakdowns!.exit.alternatives = [];
    } else {
      card.breakdowns!.control.components = [];
    }
    card.partialEvidence = { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: [key], causes: [], excludedComponentKeys: [], causeGapRefs: [] };
    const full = makeReportCardsV9Response({ cards: [card] });
    const expected = { score: null, aggregationDisposition: "unavailable" as const, pricedUnknown: { cause, score } };
    const table = projectV9Table(full);
    const detail = projectV9Detail(full, card.id);
    expect(table.cards[0]!.pillars[key]).toEqual(expected);
    expect(detail.neighborhood[0]!.ratingStatus).toBe(card.ratingStatus);
    expect(detail.neighborhood[0]!.pillars![key]).toEqual(expected);
    // Both deployed readers now admit the producer additions.
    table.cards[0]!.pillars[key] = expected;
    expect(ReportCardsV9TableResponseSchema.parse(table).cards[0]!.pillars[key]).toEqual(expected);
    detail.neighborhood[0]!.ratingStatus = card.ratingStatus;
    detail.neighborhood[0]!.pillars = table.cards[0]!.pillars;
    expect(ReportCardsV9DetailResponseSchema.parse(detail).neighborhood[0]!.pillars![key]).toEqual(expected);
    expect(projectDependencyGraph(full).nodes[0]!.pillars![key]).toEqual(expected);
  });
  // #1674: the scorer prices an A/B-excluded null pillar of a rated card; the
  // producer and both browser readers admit it on the canonical table schema.
  function tablesFor(cause: "A" | "B") {
    const old = projectV9Table(cohort());
    const full = cohort();
    full.cards[2] = makeReportCardsV9PricedExcludedCard(cause, { id: "c-partial" });
    expect(ReportCardsV9CurrentResponseSchema.safeParse(full).success).toBe(true);
    return { old, full, next: { ...old, cards: full.cards.map(projectV9TableCard) } };
  }
  it.each(["A", "B"] as const)("producer and browser readers admit old and cause-%s priced excluded tables", async (cause) => {
    const { old, full, next } = tablesFor(cause);
    expect(next.cards[2]!.pillars.exit).toEqual({ score: null, aggregationDisposition: "excluded-a-b", pricedUnknown: { cause: "U", score: 50 } });
    expect(projectV9Table(full)).toEqual(next);
    expect(ReportCardsV9TableResponseSchema.parse(next)).toEqual(next);
    const descriptorSchema = await resolveSchemaLike(FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9Table.schema);
    const identity = full.safetyScoreIdentity;
    for (const table of [old, next]) {
      expect(descriptorSchema!.safeParse(table).success).toBe(true);
      expect(buildV9SafetyTableRows(table, identity).status).toBe("available");
      expect(buildV9PortfolioProjection(table, identity, [{ coinId: "c-partial", amount: 1 }]).status).toBe("available");
    }
    const rows = buildV9SafetyTableRows(next, identity);
    expect(rows.status === "available" && rows.value.find(row => row.id === "c-partial")!.pillars.exit.pricedUnknown).toEqual({ cause: "U", score: 50 });
  });
  it("browser readers still reject priced unknowns on scored, included, defaulted or unrated pillars", async () => {
    const { next } = tablesFor("B");
    const descriptorSchema = await resolveSchemaLike(FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9Table.schema);
    const pricedUnknown = { cause: "U" as const, score: 50 };
    const variants = [
      { index: 0, pillar: { score: 90, aggregationDisposition: "included" as const, pricedUnknown } },
      { index: 0, pillar: { score: null, aggregationDisposition: "included" as const, pricedUnknown } },
      { index: 0, pillar: { score: null, pricedUnknown } },
      { index: 2, pillar: { score: 50, aggregationDisposition: "excluded-a-b" as const, pricedUnknown } },
      { index: 1, pillar: { score: null, aggregationDisposition: "excluded-a-b" as const, pricedUnknown } },
      { index: 3, pillar: { score: null, aggregationDisposition: "excluded-a-b" as const, pricedUnknown } },
    ];
    for (const { index, pillar } of variants) {
      const table = { ...next, cards: next.cards.map((card, i) => i === index ? { ...card, pillars: { ...card.pillars, exit: pillar } } : card) };
      expect(ReportCardsV9TableResponseSchema.safeParse(table).error?.issues.map(issue => issue.path))
        .toContainEqual(["cards", index, "pillars", "exit", "pricedUnknown"]);
      expect(descriptorSchema!.safeParse(table).success).toBe(false);
      expect(buildV9SafetyTableRows(table, next.safetyScoreIdentity)).toEqual({ status: "unavailable", reason: "invalid-v9-response" });
    }
  });
  it("preserves table cells, NR/partial/gap states, radars, aggregates, sorting and full-set counts", () => {
    const full = cohort();
    expect(ReportCardsV9CurrentResponseSchema.safeParse(full).success).toBe(true);
    const table = projectV9Table(full);
    const identity = full.safetyScoreIdentity;
    expect(buildV9SafetyTableRows(table, identity)).toEqual(buildV9SafetyTableRows(full, identity));
    const holdings = [{ coinId: "a-rated", amount: 100 }, { coinId: "c-partial", amount: 200 }, { coinId: "d-gap", amount: 300 }];
    expect(buildV9PortfolioProjection(table, identity, holdings)).toEqual(buildV9PortfolioProjection(full, identity, holdings));
    const mcap = new Map(full.cards.map((card, i) => [card.id, (i + 1) * 1000]));
    expect(buildV9GradeCounts(table.cards)).toEqual(buildV9GradeCounts(full.cards.map(card => ({ ...card, mint: null }))));
    expect(buildV9PillarAverages(table.cards)).toEqual(buildV9PillarAverages(full.cards.map(card => ({ ...card, mint: null }))));
    expect(buildV9HeadlineStats(table.cards, mcap)).toEqual(buildV9HeadlineStats(full.cards.map(card => ({ ...card, mint: null })), mcap));
    for (const sortKey of ["overall", "backing", "exit", "control", "mcap"] as const) {
      const filters = { gradeFilter: "all" as const, pegFilter: "all" as const, sortKey, mcapMap: mcap, pegTypeMap: new Map<string, string>() };
      expect(filterAndSortV9Cards(table.cards, filters).map(card => card.id)).toEqual(filterAndSortV9Cards(full.cards.map(card => ({ ...card, mint: null })), filters).map(card => card.id));
    }
    const series = (cards: typeof table.cards) => cards.map(card => ({ card, identity, color: "#123456" }));
    expect(buildV9RadarDataset(series(table.cards.slice(0, 1)))).toEqual(buildV9RadarDataset(series(full.cards.slice(0, 1).map(card => ({ ...card, mint: null })))));
    expect(table.cards.every(card => !("scoreTrace" in card) && !("breakdowns" in card))).toBe(true);
  });

  it("retains held display state and portfolio fail-close", () => {
    const full = cohort();
    full.publicationHealth = { ...full.publicationHealth, status: "held", heldSinceSec: full.updatedAt, reasons: [{ code: "dex-stale" }] };
    const table = projectV9Table(full);
    expect(table.publicationHealth).toEqual(full.publicationHealth);
    expect(buildV9PortfolioProjection(table, table.safetyScoreIdentity, [{ coinId: "a-rated", amount: 1 }])).toEqual({ status: "unavailable", reason: "v9-publication-held" });
  });

  it("closes both incident directions and common-mode membership without pulling unrelated cards", () => {
    const root = makeV9Card({ id: "a-root" });
    const upstream = makeV9Card({ id: "b-upstream" });
    const child = makeV9Card({ id: "c-child", dependencies: { ...root.dependencies, serial: [{ upstreamAssetId: root.id, score: root.score, blocked: false, ratingStatus: "rated", partialEvidence: null }], basket: [] } });
    root.dependencies = { ...root.dependencies, serial: [], basket: [{ upstreamAssetId: upstream.id, score: upstream.score, weight: 0.25, boundedUnknown: false, ratingStatus: "rated", partialEvidence: null }] };
    const full = makeReportCardsV9Response({ cards: [root, upstream, child, makeV9Card({ id: "d-common" }), makeV9Card({ id: "e-unrelated" })],
      commonModeGroups: [{ id: "chain:ethereum", kind: "chain", key: "ethereum", memberAssetIds: [root.id, "d-common"] }] });
    const detail = projectV9Detail(full, root.id);
    expect(detail.cards).toEqual([root]);
    expect(detail.neighborhood.map(card => card.id)).toEqual(["a-root", "b-upstream", "c-child", "d-common"]);
    expect(detail.dependencyGraph.edges).toEqual(full.dependencyGraph.edges);
    expect(detail.scope).toMatchObject({ complete: true, returnedCount: 4, expectedCount: 5, totalEdgeCount: 2 });
    expect(ReportCardsV9DetailResponseSchema.safeParse({ ...detail, neighborhood: detail.neighborhood.slice(0, 2) }).success).toBe(false);
    expect(ReportCardsV9TableResponseSchema.safeParse({ ...projectV9Table(full), cards: projectV9Table(full).cards.slice(0, 2) }).success).toBe(false);
  });

  it("includes sibling basket inputs needed for identical direct-exposure integrity verdicts", () => {
    const root = makeV9Card({ id: "a-root" });
    const sibling = makeV9Card({ id: "b-sibling" });
    const child = makeV9Card({ id: "c-child", dependencies: { ...root.dependencies, serial: [], basket: [
      { upstreamAssetId: root.id, weight: 0.7, score: root.score, boundedUnknown: false, ratingStatus: "rated", partialEvidence: null },
      { upstreamAssetId: sibling.id, weight: 0.7, score: sibling.score, boundedUnknown: false, ratingStatus: "rated", partialEvidence: null },
    ] } });
    const full = makeReportCardsV9Response({ cards: [root, sibling, child] });
    const detail = projectV9Detail(full, root.id);
    const mcap = new Map([[root.id, 100], [sibling.id, 100], [child.id, 100]]);
    expect(detail.dependencyGraph.edges).toEqual(full.dependencyGraph.edges);
    expect(buildDetailDependencyContext(root.id, detail.neighborhood, detail.dependencyGraph.edges, mcap, 100))
      .toEqual(buildDetailDependencyContext(root.id, full.cards, full.dependencyGraph.edges, mcap, 100));
  });

  it("retains original sparse foreign gap indices without rewriting card-local references", () => {
    const full = cohort();
    const card = full.cards.find(row => row.id === "c-partial")!;
    card.foreignCauseGapRefs = [2];
    card.partialEvidence!.causeGapRefs = [0, 1];
    full.foreignCauseGaps = ["upstream:gap:a", "upstream:gap:b", "upstream:gap:c"];
    const detail = projectV9Detail(full, card.id);
    expect(detail.foreignCauseGaps).toEqual({ "2": "upstream:gap:c" });
    expect(detail.cards[0].foreignCauseGapRefs).toEqual([2]);
    expect(detail.cards[0].partialEvidence?.causeGapRefs).toEqual([0, 1]);
    expect(ReportCardsV9DetailResponseSchema.safeParse({ ...detail, foreignCauseGaps: {} }).success).toBe(false);
  });

  it("uses independent endpoint and query identities for full, table and every selected coin", () => {
    const full = FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9;
    const table = FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9Table;
    const a = FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9Detail("usdc-circle");
    const b = FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9Detail("usdt-tether");
    expect(new Set([full.path, table.path, a.path, b.path]).size).toBe(4);
    expect(new Set([full.queryKey, table.queryKey, a.queryKey, b.queryKey].map(key => JSON.stringify(key))).size).toBe(4);
  });
});
