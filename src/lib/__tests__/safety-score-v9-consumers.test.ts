import { describe, expect, it } from "vitest";
import { internV9PublicWitnessTexts } from "@shared/lib/safety-score-v9/public-witness-texts";
import { projectV9Table as toTable, projectV9TableCard as toTableCard, projectV9Detail as toDetail } from "@shared/lib/report-cards-v9-projections";
import { ReportCardsV9DetailResponseSchema as DetailSchema, ReportCardsV9TableResponseSchema as TableSchema } from "@shared/types/report-cards-v9-projections";
import {
  buildV9PortfolioProjection as buildPortfolio, buildV9SafetyTableMap as buildMap, buildV9SafetyTableRows as buildRows,
  getV9GradeRiskBucket as riskBucket, resolveV9ConsumerResponse as resolveV9, readV9CardMintComponent as readMint, readV9CardIssuanceSummary as readIssuance,
} from "@/lib/safety-score-v9-consumers";
import { buildStablecoinTableInputs } from "@/lib/stablecoin-table-inputs";
import { makePublishedProcessDiagnostic } from "@shared/lib/__tests__/safety-score-v9-fixtures.test-support";
import { makeReportCardsV9ArchivedResponse as v9Archived, makeReportCardsV9Response as v9Res, makeV9Card as v9Card, makeV9Pillars } from "@/test/fixtures/safety-score-v9";
import { makeReportCardsV9PartialCard as partialCard, makeReportCardsV9PipelineGapCard as gapCard, makeReportCardsV9PricedExcludedCard as pricedExcludedCard } from "@shared/test-utils/report-cards-v9";
import { ReportCardsV9CurrentResponseSchema as CurrentSchema } from "@shared/types/report-cards-v9-current";
import { resolveSchemaLike } from "@shared/lib/schema-like";
import { buildV9RadarDataset } from "@/components/compare/radar-chart-v9";
import { buildV9GradeCounts, buildV9PillarAverages, buildV9HeadlineStats, filterAndSortV9Cards } from "@/app/safety-scores/v9-view-model";
import { FRONTEND_API_QUERY_DESCRIPTORS as DESCRIPTORS } from "../api-query-descriptors";
import { buildDetailDependencyContext as depContext } from "@/components/stablecoin-detail/dependency-context-model";
import { projectDependencyGraph } from "@shared/types/dependency-graph";

const unavail = (reason: string) => ({ status: "unavailable", reason });
const unwrap = <T,>(r: { status: "available"; value: T } | { status: "unavailable"; reason: string }): T => {
  expect(r.status).toBe("available");
  if (r.status !== "available") throw new Error(r.reason);
  return r.value;
};
const nrPillar = () => ({ score: null, aggregationDisposition: "included" as const, supportedComponentKeys: [], causeGapRefs: [], limitedEvidenceCauses: ["U" as const], evidenceLevel: "insufficient" as const, freshness: "unknown" as const, components: [], reasons: [] });
const nrCard = (ov: Parameters<typeof v9Card>[0] = {}) => v9Card({
  score: null, grade: "NR", qualityScore: null, pegMultiplier: null, pegAdjustedScore: null,
  pillars: { backing: nrPillar(), exit: nrPillar(), control: nrPillar() }, weakestPillar: null,
  nrReasons: [{ code: "missing-pillar", message: "Required pillar evidence is missing.", field: "backing", origin: "asset" }],
  evidence: { level: "insufficient", freshness: "unknown", reasons: [] }, ...ov,
});
const serialDep = (upstreamAssetId: string, score: number | null = 80) => ({ upstreamAssetId, score, ratingStatus: "rated" as const, partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: [], blocked: false });
const basketDep = (upstreamAssetId: string, weight: number, score: number | null = 80) => ({ upstreamAssetId, score, weight, boundedUnknown: false, ratingStatus: "rated" as const, partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: [] });
const deps = (serial: ReturnType<typeof serialDep>[] = [], basket: ReturnType<typeof basketDep>[] = []) => ({ serial, basket, cycleBlocked: false, reasonCodes: [] });
const hold = (...items: [string, number][]) => items.map(([coinId, amount]) => ({ coinId, amount }));
const resOf = (...cards: ReturnType<typeof v9Card>[]) => v9Res({ cards });
const cardId = (id: string, ov: Parameters<typeof v9Card>[0] = {}) => v9Card({ id, ...ov });
const isOk = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => s.safeParse(v).success;
const portfolio = (r: Parameters<typeof buildPortfolio>[0], holdings: Parameters<typeof buildPortfolio>[2], id = (r as { safetyScoreIdentity: Parameters<typeof buildPortfolio>[1] }).safetyScoreIdentity) => buildPortfolio(r, id, holdings);
const tableRows = (r: Parameters<typeof buildRows>[0], filter?: Parameters<typeof buildRows>[2], id = (r as { safetyScoreIdentity: Parameters<typeof buildRows>[1] }).safetyScoreIdentity) => buildRows(r, id, filter);

describe("V9 safety consumer projections", () => {
  it("requires resolved witness text at the independent consumer parser boundary", () => {
    const semantic = v9Res(), reason = { code: "unresolved-control-identity" as const, message: "The independently scoped incident disposition remains unknown.", path: "control:incidentState" };
    semantic.cards[0]!.evidence.reasons = [reason];
    semantic.cards[0]!.pillars.control.reasons = [reason];
    const wire = { ...semantic, cards: semantic.cards.map((c) => internV9PublicWitnessTexts(c)) };
    expect(resolveV9(wire, semantic.safetyScoreIdentity)).toEqual(unavail("invalid-v9-response"));
    expect(resolveV9(semantic, semantic.safetyScoreIdentity)).toEqual({ status: "available", identity: semantic.safetyScoreIdentity, value: semantic });
  });

  it("preserves technical gap nulls and excludes them from grade risk buckets", () => {
    const res = resOf(gapCard("control", "A"));
    expect(tableRows(res)).toMatchObject({ status: "available", value: [{ grade: null, score: null, ratingStatus: "pipeline-gap", riskBucket: null }] });
    for (const f of ["safe", "neutral", "risky", "unavailable"] as const) expect(tableRows(res, f)).toMatchObject({ status: "available", value: [] });
  });

  it("uses known-only score and per-pillar USD denominators for partial portfolios", () => {
    const known = partialCard("exit", "B", { id: "partial" });
    expect(portfolio(resOf(gapCard(null, "A", { id: "gap" }), known), hold(["partial", 100], ["gap", 300]))).toMatchObject({
      status: "available",
      value: {
        score: known.score, assetGrade: null, partialEvidence: true, pillars: { backing: 80, exit: null, control: 80 },
        coverageUsd: { total: 400, score: 100, pillars: { backing: 100, exit: 0, control: 100 }, excludedIds: { score: ["gap"], pillars: { backing: ["gap"], exit: ["partial", "gap"], control: ["gap"] } } },
      },
    });
  });

  it("aggregates pillars whose optional aggregationDisposition is absent (defaults to included)", () => {
    const base = cardId("implicit");
    const pillars = Object.fromEntries((["backing", "exit", "control"] as const).map((k) => { const { aggregationDisposition: _o, ...rest } = base.pillars[k]; return [k, rest]; })) as typeof base.pillars;
    expect(portfolio(resOf({ ...base, pillars }), hold(["implicit", 10]))).toMatchObject({
      status: "available", value: { pillars: { backing: base.pillars.backing.score, exit: base.pillars.exit.score, control: base.pillars.control.score } },
    });
  });

  it("returns null portfolio aggregates when no holding has a score", () => {
    const c = gapCard(null, "B");
    expect(portfolio(resOf(c), hold([c.id, 50]))).toMatchObject({
      status: "available", value: { score: null, pillars: { backing: null, exit: null, control: null }, coverageUsd: { total: 50, score: 0, pillars: { backing: 0, exit: 0, control: 0 } } },
    });
  });

  it("requires a complete exact identity and rejects independently changed canonical identity dimensions", () => {
    const res = v9Res(), id = res.safetyScoreIdentity;
    expect(resolveV9(res, id).status).toBe("available");
    expect(resolveV9({ ...res, safetyScoreIdentity: undefined }, { ...id, publicationGenerationId: "v9-publication-2" })).toEqual(unavail("invalid-v9-response"));
    for (const [field, value] of Object.entries({ methodologyVersion: "9.1", policyId: "another-policy", policyDigest: "e".repeat(64), evaluationBuildDigest: "f".repeat(64), baseInputGenerationId: `report-cards-input:v1:${"1".repeat(64)}`, publicationGenerationId: "another-publication" })) {
      expect(resolveV9(res, { ...id, [field]: value }), field).toEqual(unavail("identity-mismatch"));
    }
    for (const m of [{ model: "v8" }, { schemaVersion: 2 }]) expect(resolveV9({ ...res, safetyScoreIdentity: { ...id, ...m } }, id)).toEqual(unavail("invalid-v9-response"));
  });

  it("rejects held publications, empty positive portfolios, and positive holdings with no published card", () => {
    const held = v9Res();
    held.publicationHealth = { ...held.publicationHealth, status: "held", heldSinceSec: held.updatedAt, reasons: [{ code: "dex-stale" }] };
    expect(portfolio(held, hold(["usdc-circle", 100]))).toEqual(unavail("v9-publication-held"));

    const res = v9Res(), ignored = hold(["missing-zero", 0], ["missing-negative", -10]);
    for (const h of [[], ignored]) expect(portfolio(res, h)).toEqual(unavail("portfolio-empty"));
    expect(portfolio(res, [...ignored, ...hold(["usdc-circle", 100])])).toMatchObject({ status: "available", value: { score: 80, pillars: { backing: 80, exit: 82, control: 84 } } });
    expect(portfolio(res, hold(["usdc-circle", 100], ["missing", 1]))).toEqual(unavail("portfolio-card-unavailable"));
  });

  it("attributes full serial exposure only to held dependents", () => {
    const dep = (id: string) => cardId(id, { dependencies: deps([serialDep("upstream")]) });
    expect(unwrap(portfolio(resOf(dep("held"), dep("unheld"), cardId("upstream")), hold(["held", 375]))).dependencyExposure)
      .toEqual([{ upstreamAssetId: "upstream", dependentAssetId: "held", kind: "serial", materiality: "serial", exposureUsd: 375 }]);
  });

  it("keeps unknown basket shares unavailable, never $0, in the compact table projection", () => {
    const res = resOf(...["held", "unheld", "up-half", "up-null", "up-serial", "up-zero"].map((id) => cardId(id)));
    const table = toTable(res);
    const edge = (from: string, to: string, kind: "serial" | "basket", weight: number | null) => ({
      from, to, kind, weight, upstreamScore: 80,
      materiality: kind === "serial" ? "serial" as const : weight === null ? "basket-bounded-unknown" as const : "basket-weighted" as const,
    });
    table.dependencyGraph = { edges: [edge("up-half", "held", "basket", 0.5), edge("up-half", "unheld", "basket", 0.5), edge("up-null", "held", "basket", null), edge("up-serial", "held", "serial", null), edge("up-zero", "held", "basket", 0)] };
    expect(isOk(TableSchema, table)).toBe(true);
    const out = unwrap(portfolio(table, hold(["held", 300])));
    expect(out.dependencyExposure.map((r) => [r.upstreamAssetId, r.exposureUsd])).toEqual([["up-half", 150], ["up-null", null], ["up-serial", 300], ["up-zero", 0]]);
    const base = unwrap(portfolio(toTable(res), hold(["held", 300])));
    expect([out.score, out.pillars]).toEqual([base.score, base.pillars]);
  });

  it("rejects historical report versions, admits report9 table projections, and distinguishes report9/report8 open-evidence", () => {
    const base = v9Res();
    expect(resolveV9({ ...base, schemaVersion: 3 }, base.safetyScoreIdentity)).toEqual(unavail("invalid-v9-response"));
    expect(buildMap({ ...toTable(base), schemaVersion: 9 }, base.safetyScoreIdentity).status).toBe("available");

    const r9 = v9Res({ openEvidence: { semantics: "open-question-v1", totals: { questions: 0, open: 0, issuer: 0, documentation: 0, obligations: 0 }, owners: [], reasons: [], documentation: { questions: 0, datums: 0, facts: 0, reasons: [] }, issuer: { questions: 0, assets: 0, oldestReviewedAtSec: null, newestReviewedAtSec: null }, byCard: [] } });
    const out = unwrap(resolveV9(r9, r9.safetyScoreIdentity));
    expect([out.schemaVersion, out.openEvidence?.semantics, out.openEvidenceUnavailableReason, out.cards]).toEqual([9, "open-question-v1", null, r9.cards]);

    const r8 = v9Archived(), arch = unwrap(resolveV9(r8, r8.safetyScoreIdentity));
    expect([arch.openEvidence, arch.openEvidenceUnavailableReason]).toEqual([null, "publication-predates-open-evidence"]);

    const { openEvidence: _oe, openEvidenceUnavailableReason: _oer, ...pairless } = r9;
    expect(resolveV9(pairless, r9.safetyScoreIdentity)).toEqual(unavail("invalid-v9-response"));
    expect(resolveV9({ ...r9, schemaVersion: 10 }, r9.safetyScoreIdentity)).toEqual(unavail("invalid-v9-response"));
  });

  it("uses explicit V9 grade classes and three-pillar table rows", () => {
    for (const [g, b] of [["B-", "safe"], ["C+", "neutral"], ["C", "neutral"], ["C-", "neutral"], ["D", "risky"], ["NR", "unavailable"]] as const) expect(riskBucket(g)).toBe(b);
    const res = resOf(cardId("asset-a", { score: 61, grade: "C+", qualityScore: 62, pegAdjustedScore: 61 }), cardId("asset-b", { score: 88, grade: "A+", qualityScore: 90, pegAdjustedScore: 88 }));
    const rows = unwrap(tableRows(res));
    expect(rows.map((r) => [r.id, r.riskBucket])).toEqual([["asset-b", "safe"], ["asset-a", "neutral"]]);
    expect(rows[0]).toHaveProperty("pillars.backing");
    expect(rows[0]).not.toHaveProperty("dimensions");
  });

  it("preserves evidence, weakest-pillar, binding-cap, and mint summaries in table rows", () => {
    const cap = { kind: "parent", limit: 80, source: "parent" as const, reason: "The required parent limits the published score.", binding: true };
    const card = cardId("asset-summary", { evidence: { level: "insufficient", freshness: "stale", reasons: [] }, caps: [cap], bindingCap: cap, dependencies: deps([serialDep("required-parent")]) });
    const res = resOf(card, cardId("required-parent")), raw = tableRows(res), rows = unwrap(raw);
    expect(rows[0]).toMatchObject({
      id: card.id, score: card.score, grade: card.grade,
      pillars: { backing: { score: card.pillars.backing.score, aggregationDisposition: card.pillars.backing.aggregationDisposition }, exit: { score: card.pillars.exit.score, aggregationDisposition: card.pillars.exit.aggregationDisposition }, control: { score: card.pillars.control.score, aggregationDisposition: card.pillars.control.aggregationDisposition } },
      evidence: { level: card.evidence.level }, weakestPillar: card.weakestPillar, bindingCapReason: cap.reason, mint: { score: card.pillars.control.score, posture: "distributed" },
    });
    expect(tableRows(toTable(res))).toEqual(raw);
    expect(rows[0]?.pillars.backing).not.toHaveProperty("causeGapRefs");
    expect(rows[0]?.evidence).not.toHaveProperty("freshness");
  });

  it("keeps NR, insufficient evidence, and absent breakdowns fail-closed", () => {
    const card = nrCard({ id: "asset-nr", breakdowns: null }), res = resOf(card), raw = tableRows(res), rows = unwrap(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ score: null, grade: "NR", evidence: { level: card.evidence.level }, weakestPillar: null, bindingCapReason: null, mint: null });
    expect(rows[0]?.pillars.backing.score).toBeNull();
    expect(tableRows(toTable(res))).toEqual(raw);
  });

  it("projects explicit V9 values into stable-table inputs", () => {
    const card = cardId("asset-shared", { score: 61, grade: "C+", qualityScore: 62, pegAdjustedScore: 61, evidence: { level: "adequate", freshness: "current", reasons: [] }, weakestPillar: { pillar: "backing", score: 60 } });
    const res = resOf(card), table = buildStablecoinTableInputs({ reportCardsV9: res }).reportCards;
    expect(Object.keys(table ?? {})).toEqual(["asset-shared"]);
    expect(table?.["asset-shared"]).toMatchObject({ score: 61, grade: "C+", riskBucket: "neutral", evidence: { level: "adequate" }, weakestPillar: { pillar: "backing", score: 60 }, bindingCapReason: null });
    expect(buildStablecoinTableInputs({ reportCardsV9: toTable(res) }).reportCards).toEqual(table);
  });

  it("builds a three-pillar portfolio aggregate without inventing an asset grade", () => {
    const res = resOf(cardId("asset-a", { score: 80, grade: "A-", qualityScore: 82, pegAdjustedScore: 80 }), cardId("asset-b", { score: 90, grade: "A+", qualityScore: 92, pegAdjustedScore: 90, dependencies: deps([], [basketDep("asset-a", 0.5)]) }));
    expect(portfolio(res, hold(["asset-a", 100], ["asset-b", 300]))).toMatchObject({
      status: "available", value: { aggregateLabel: "weighted-safety-aggregate", score: 88, assetGrade: null, pillars: { backing: 88, exit: 90, control: 92 }, dependencyExposure: [{ upstreamAssetId: "asset-a", dependentAssetId: "asset-b", kind: "basket", exposureUsd: 150 }] },
    });
  });

  it("fails closed for NR portfolios and mismatched publication identities", () => {
    const c = nrCard();
    expect(portfolio(resOf(c), hold([c.id, 1]))).toEqual(unavail("portfolio-card-not-rated"));
    const res = v9Res(), wrongId = { ...res.safetyScoreIdentity, publicationGenerationId: "v9-publication-other" };
    expect([buildMap(res, wrongId), buildRows(res, wrongId)]).toEqual([unavail("identity-mismatch"), unavail("identity-mismatch")]);
  });
});

describe("published mint diagnostic and native mint selection consumers", () => {
  it("retains typed failures independently of an NR mint score and never invents missing process evidence", () => {
    const card = v9Card(), ctrl = card.breakdowns!.control;
    ctrl.components = [{ ...ctrl.components[0]!, kind: "mint", score: null }];
    ctrl.issuanceSummary = { diagnostics: [makePublishedProcessDiagnostic({ code: "operational-cap-unproved", gate: "H2", controlRef: null, pathId: null, classId: null, memberRef: null, field: "maxAnnualInterestGrowthPpm", evidenceRefIds: [] })] };
    expect(readMint(card)).toBeNull();
    expect(readIssuance(card)?.diagnostics[0]).toMatchObject({ code: "operational-cap-unproved", count: 1, controlRefs: [null] });
    ctrl.issuanceSummary = undefined;
    expect(readIssuance(card)).toBeNull();
  });

  it("reads only the asset's native mint row, never a bridged-token or deployment mint that sorts first", () => {
    const card = cardId("bold-like"), ctrl = card.breakdowns!.control, base = ctrl.components.find((r) => r.kind === "mint")!;
    ctrl.components = [
      { ...base, key: "mint:bridge:bridge-meta:bold-liquity:15850c94dda1beb8ac25", label: "Arbitrum bridged-token mint", posture: "unbounded-adverse", score: 60, binding: false },
      { ...base, key: "mint:deployment:mint-meta:bold-liquity:e2381c0e", label: "Ethereum mint authority", posture: "concentrated-admin", score: 75, binding: false },
    ];
    expect([readMint(card), toTableCard(card).mint]).toEqual([null, null]);
    ctrl.components.push({ ...base, key: "mint", label: "Native mint authority", posture: "unbounded-reconciled", score: 80, binding: true });
    expect([readMint(card), toTableCard(card).mint]).toEqual([{ score: 80, posture: "unbounded-reconciled" }, { score: 80, posture: "unbounded-reconciled" }]);
  });
});

const cohort = () => resOf(
  cardId("a-rated", { score: 90 }),
  cardId("b-nr", { score: null, grade: "NR", nrReasons: [{ code: "unresolved-control-identity", message: "Control identity is unresolved.", field: null, origin: "asset" }] }),
  partialCard("exit", "B", { id: "c-partial" }),
  gapCard("control", "A", { id: "d-gap" }),
);

describe("compact score consumer equivalence", () => {
  it("accepts optional local exposure in full, table and detail readers without table emission", () => {
    const full = cohort(), exposure = { worstQuality: 60, coveredShare: 0.99, slices: [{ deploymentLabel: "Ethereum vault", share: 0.99, quality: 60 }], moreCount: 0 };
    full.cards[0]!.localAuthorityExposure = exposure;
    expect(CurrentSchema.parse(full).cards[0]!.localAuthorityExposure).toEqual(exposure);
    const table = toTable(full);
    expect(table.cards[0]).not.toHaveProperty("localAuthorityExposure");
    table.cards[0]!.localAuthorityExposure = exposure;
    expect(TableSchema.parse(table).cards[0]!.localAuthorityExposure).toEqual(exposure);
    expect(DetailSchema.parse(toDetail(full, full.cards[0]!.id)).cards[0]!.localAuthorityExposure).toEqual(exposure);
    expect(isOk(TableSchema, { ...table, cards: table.cards.map((c, i) => i === 0 ? { ...c, localAuthorityExposure: { ...exposure, slices: Array(4).fill(exposure.slices[0]) } } : c) })).toBe(false);
  });

  it.each([["backing", "C", 35], ["exit", "U", 50], ["control", "U", 60]] as const)(
    "emits the %s assumption in table and neighborhood projections",
    (key, cause, score) => {
      const card = v9Card({ pillars: makeV9Pillars({ backing: 80, exit: 82, control: 84, [key]: score }) }), agg = card.scoreTrace.aggregation!, b = card.breakdowns!;
      Object.assign(card.pillars[key], { score: null, aggregationDisposition: "unavailable", supportedComponentKeys: [], limitedEvidenceCauses: [] });
      agg.pricedUnknownPillars = [{ pillar: key, cause, score, causeGapRefs: [] }];
      agg.includedPillars = agg.includedPillars.filter((p) => p !== key);
      agg.excludedPillars = [key];
      Object.assign(b[key], { aggregationDisposition: "unavailable", aggregationWeight: 0, evaluatedScore: null, publishedScore: null });
      if (key === "backing") Object.assign(b.backing, { groups: [], components: [] });
      else if (key === "exit") Object.assign(b.exit, { primaryRoute: null, diversification: null, alternatives: [] });
      else b.control.components = [];
      card.partialEvidence = { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: [key], causes: [], excludedComponentKeys: [], causeGapRefs: [] };
      const full = resOf(card), expected = { score: null, aggregationDisposition: "unavailable" as const, pricedUnknown: { cause, score } };
      const [table, detail] = [toTable(full), toDetail(full, card.id)];
      expect([table.cards[0]!.pillars[key], detail.neighborhood[0]!.ratingStatus, detail.neighborhood[0]!.pillars![key]]).toEqual([expected, card.ratingStatus, expected]);
      table.cards[0]!.pillars[key] = expected;
      expect(TableSchema.parse(table).cards[0]!.pillars[key]).toEqual(expected);
      detail.neighborhood[0]!.ratingStatus = card.ratingStatus;
      detail.neighborhood[0]!.pillars = table.cards[0]!.pillars;
      expect(DetailSchema.parse(detail).neighborhood[0]!.pillars![key]).toEqual(expected);
      expect(projectDependencyGraph(full).nodes[0]!.pillars![key]).toEqual(expected);
    },
  );

  function tablesFor(cause: "A" | "B") {
    const [old, full] = [toTable(cohort()), cohort()];
    full.cards[2] = pricedExcludedCard(cause, { id: "c-partial" });
    expect(isOk(CurrentSchema, full)).toBe(true);
    return { old, full, next: { ...old, cards: full.cards.map(toTableCard) } };
  }

  it.each(["A", "B"] as const)("producer and browser readers admit old and cause-%s priced excluded tables", async (cause) => {
    const { old, full, next } = tablesFor(cause), pu = { cause: "U", score: 50 };
    expect(next.cards[2]!.pillars.exit).toEqual({ score: null, aggregationDisposition: "excluded-a-b", pricedUnknown: pu });
    expect([toTable(full), TableSchema.parse(next)]).toEqual([next, next]);
    const schema = await resolveSchemaLike(DESCRIPTORS.reportCardsV9Table.schema);
    for (const t of [old, next]) expect([isOk(schema!, t), tableRows(t).status, portfolio(t, hold(["c-partial", 1])).status]).toEqual([true, "available", "available"]);
    expect(unwrap(tableRows(next)).find((r) => r.id === "c-partial")!.pillars.exit.pricedUnknown).toEqual(pu);
  });

  it("browser readers still reject priced unknowns on scored, included, defaulted or unrated pillars", async () => {
    const { next } = tablesFor("B"), schema = await resolveSchemaLike(DESCRIPTORS.reportCardsV9Table.schema), pu = { cause: "U" as const, score: 50 };
    for (const [index, score, disp] of [[0, 90, "included"], [0, null, "included"], [0, null, undefined], [2, 50, "excluded-a-b"], [1, null, "excluded-a-b"], [3, null, "excluded-a-b"]] as const) {
      const pillar = { score, ...(disp ? { aggregationDisposition: disp } : {}), pricedUnknown: pu };
      const table = { ...next, cards: next.cards.map((c, i) => i === index ? { ...c, pillars: { ...c.pillars, exit: pillar } } : c) };
      expect(TableSchema.safeParse(table).error?.issues.map((i) => i.path)).toContainEqual(["cards", index, "pillars", "exit", "pricedUnknown"]);
      expect([isOk(schema!, table), tableRows(table)]).toEqual([false, unavail("invalid-v9-response")]);
    }
  });

  it("preserves table cells, NR/partial/gap states, radars, aggregates, sorting and full-set counts", () => {
    const full = cohort();
    expect(isOk(CurrentSchema, full)).toBe(true);
    const table = toTable(full), id = full.safetyScoreIdentity, fullCards = full.cards.map((c) => ({ ...c, mint: null }));
    expect(tableRows(table)).toEqual(tableRows(full));
    const holdings = hold(["a-rated", 100], ["c-partial", 200], ["d-gap", 300]);
    expect(portfolio(table, holdings)).toEqual(portfolio(full, holdings));
    const mcap = new Map(full.cards.map((c, i) => [c.id, (i + 1) * 1000]));
    expect(buildV9GradeCounts(table.cards)).toEqual(buildV9GradeCounts(fullCards));
    expect(buildV9PillarAverages(table.cards)).toEqual(buildV9PillarAverages(fullCards));
    expect(buildV9HeadlineStats(table.cards, mcap)).toEqual(buildV9HeadlineStats(fullCards, mcap));
    for (const sortKey of ["overall", "backing", "exit", "control", "mcap"] as const) {
      const f = { gradeFilter: "all" as const, pegFilter: "all" as const, sortKey, mcapMap: mcap, pegTypeMap: new Map<string, string>() };
      expect(filterAndSortV9Cards(table.cards, f).map((c) => c.id)).toEqual(filterAndSortV9Cards(fullCards, f).map((c) => c.id));
    }
    const series = (cards: typeof table.cards) => cards.map((card) => ({ card, identity: id, color: "#123456" }));
    expect(buildV9RadarDataset(series(table.cards.slice(0, 1)))).toEqual(buildV9RadarDataset(series(fullCards.slice(0, 1))));
    expect(table.cards.every((c) => !("scoreTrace" in c) && !("breakdowns" in c))).toBe(true);
  });

  it("retains held display state and portfolio fail-close", () => {
    const full = cohort();
    full.publicationHealth = { ...full.publicationHealth, status: "held", heldSinceSec: full.updatedAt, reasons: [{ code: "dex-stale" }] };
    const table = toTable(full);
    expect([table.publicationHealth, portfolio(table, hold(["a-rated", 1]))]).toEqual([full.publicationHealth, unavail("v9-publication-held")]);
  });

  it("closes both incident directions and common-mode membership without pulling unrelated cards", () => {
    const [root, upstream] = [cardId("a-root"), cardId("b-upstream")];
    const child = cardId("c-child", { dependencies: deps([serialDep(root.id, root.score)]) });
    root.dependencies = deps([], [basketDep(upstream.id, 0.25, upstream.score)]);
    const full = v9Res({ cards: [root, upstream, child, cardId("d-common"), cardId("e-unrelated")], commonModeGroups: [{ id: "chain:ethereum", kind: "chain", key: "ethereum", memberAssetIds: [root.id, "d-common"] }] });
    const detail = toDetail(full, root.id);
    expect([detail.cards, detail.neighborhood.map((c) => c.id), detail.dependencyGraph.edges]).toEqual([[root], ["a-root", "b-upstream", "c-child", "d-common"], full.dependencyGraph.edges]);
    expect(detail.scope).toMatchObject({ complete: true, returnedCount: 4, expectedCount: 5, totalEdgeCount: 2 });
    expect([isOk(DetailSchema, { ...detail, neighborhood: detail.neighborhood.slice(0, 2) }), isOk(TableSchema, { ...toTable(full), cards: toTable(full).cards.slice(0, 2) })]).toEqual([false, false]);
  });

  it("includes sibling basket inputs needed for identical direct-exposure integrity verdicts", () => {
    const [root, sibling] = [cardId("a-root"), cardId("b-sibling")];
    const child = cardId("c-child", { dependencies: deps([], [basketDep(root.id, 0.7, root.score), basketDep(sibling.id, 0.7, sibling.score)]) });
    const full = resOf(root, sibling, child), detail = toDetail(full, root.id), mcap = new Map([[root.id, 100], [sibling.id, 100], [child.id, 100]]);
    expect(detail.dependencyGraph.edges).toEqual(full.dependencyGraph.edges);
    expect(depContext(root.id, detail.neighborhood, detail.dependencyGraph.edges, mcap, 100)).toEqual(depContext(root.id, full.cards, detail.dependencyGraph.edges, mcap, 100));
  });

  it("retains original sparse foreign gap indices without rewriting card-local references", () => {
    const full = cohort(), card = full.cards.find((r) => r.id === "c-partial")!;
    card.foreignCauseGapRefs = [2];
    card.partialEvidence!.causeGapRefs = [0, 1];
    full.foreignCauseGaps = ["upstream:gap:a", "upstream:gap:b", "upstream:gap:c"];
    const detail = toDetail(full, card.id);
    expect([detail.foreignCauseGaps, detail.cards[0].foreignCauseGapRefs, detail.cards[0].partialEvidence?.causeGapRefs]).toEqual([{ "2": "upstream:gap:c" }, [2], [0, 1]]);
    expect(isOk(DetailSchema, { ...detail, foreignCauseGaps: {} })).toBe(false);
  });

  it("uses independent endpoint and query identities for full, table and every selected coin", () => {
    const entries = [DESCRIPTORS.reportCardsV9, DESCRIPTORS.reportCardsV9Table, DESCRIPTORS.reportCardsV9Detail("usdc-circle"), DESCRIPTORS.reportCardsV9Detail("usdt-tether")];
    expect([new Set(entries.map((e) => e.path)).size, new Set(entries.map((e) => JSON.stringify(e.queryKey))).size]).toEqual([4, 4]);
  });
});
