import { describe, expect, it } from "vitest";
import { projectV9Table, projectV9Detail } from "@shared/lib/report-cards-v9-projections";
import { ReportCardsV9DetailResponseSchema, ReportCardsV9TableResponseSchema } from "@shared/types/report-cards-v9-projections";
import { ReportCardsV9CurrentResponseSchema } from "@shared/types/report-cards-v9";
import { makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { makeReportCardsV9Response, makeV9Card, makeV9Pillars } from "@/test/fixtures/safety-score-v9";
import { buildV9SafetyTableRows, buildV9PortfolioProjection } from "../safety-score-v9-consumers";
import { buildV9RadarDataset } from "@/components/radar-chart-v9";
import { buildV9GradeCounts, buildV9PillarAverages, buildV9HeadlineStats, filterAndSortV9Cards } from "@/app/safety-scores/v9-view-model";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "../api-query-descriptors";
import { buildDetailDependencyContext } from "@/components/stablecoin-detail/dependency-context-model";
import { projectDependencyGraph } from "@shared/types/dependency-graph";

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
