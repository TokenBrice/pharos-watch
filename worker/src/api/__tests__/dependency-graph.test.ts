import { makeReportCardsV9PipelineGapCard, makeReportCardsV9PartialCard } from "@shared/test-utils/report-cards-v9";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPublicApiAccess } from "@shared/lib/api-endpoints";
import { DependencyGraphResponseSchema, projectDependencyGraph } from "@shared/types/dependency-graph";
import { makeReportCardsV9Response, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { mockD1 } from "@shared/test-utils/mock-d1";

const mockLoadActiveSafetyScoreSource = vi.fn();
vi.mock("../../lib/safety-score-active-source", () => ({
  loadActiveSafetyScoreSource: mockLoadActiveSafetyScoreSource,
}));
// Load after the accepted-source mock has been installed.
const { handleDependencyGraph } = await import("../dependency-graph");

function fixturePublication() {
  return makeReportCardsV9Response({
    cards: [
      makeWorkerV9Card({ id: "child", supply: { circulatingUsdAtEvaluation: 0, asOfSec: 100, generationId: "supply-1" }, sharedBookId: "book-1", dependencyCoverage: [], dependencies: {
        serial: [{ upstreamAssetId: "parent", score: 80, ratingStatus: "rated", partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: [], blocked: false, dependencyType: "wrapper", wrapperForm: "pure", provenance: { source: "manual", evidenceAsOf: "2026-09-29", intermediary: null } }],
        basket: [],
        cycleBlocked: false,
        reasonCodes: [],
        roles: [{ edgeKey: "role-1", exposureKey: "exposure-1", riskEventKey: "event-1", upstreamAssetId: "parent", role: "exit-dependency", weight: 0.4, targetPillar: "exit",        inheritedDimensions: [], unavailableDimensions: [], score: 80, ratingStatus: "rated", partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: [], boundedUnknown: false, cycleBlocked: false, evidenceRefIds: [], failureDomains: [] }],
      } }),
      makeWorkerV9Card({ id: "parent", score: null, supply: undefined, sharedBookId: undefined, dependencyCoverage: undefined }),
    ],
    commonModeGroups: [{ id: "reserve-issuer:shared", kind: "reserve-issuer", key: "shared", memberAssetIds: ["child", "parent"] }],
  });
}

describe("dependency graph projection", () => {
  beforeEach(() => mockLoadActiveSafetyScoreSource.mockReset());

  it("projects graph v2 with distinct technical null and rated partial nodes", async () => {
    const snapshot = makeReportCardsV9Response({ cards: [
      makeReportCardsV9PipelineGapCard("control", "A", { id: "gap" }),
      makeWorkerV9Card({ id: "nr", score: null }),
      makeReportCardsV9PartialCard("exit", "B", { id: "partial" }),
    ] });
    mockLoadActiveSafetyScoreSource.mockResolvedValue({ kind: "v9", snapshot });
    const body = DependencyGraphResponseSchema.parse(await (await handleDependencyGraph(mockD1([]))).json());
    expect(body.schemaVersion).toBe(2);
    expect(body.nodes.find((node) => node.id === "gap")).toMatchObject({ grade: null, score: null, ratingStatus: "pipeline-gap" });
    expect(body.nodes.find((node) => node.id === "nr")).toMatchObject({ grade: "NR", score: null, ratingStatus: "not-rated" });
    expect(body.nodes.find((node) => node.id === "partial")).toMatchObject({
      ratingStatus: "rated", partialEvidence: { excludedPillars: ["exit"], causes: ["B"] },
    });
  });

  it("preserves accepted edges and publication-bound zero, null, role and coverage facts", async () => {
    const snapshot = fixturePublication();
    mockLoadActiveSafetyScoreSource.mockResolvedValue({ kind: "v9", snapshot });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(snapshot.updatedAt * 1000);
    const response = await handleDependencyGraph(mockD1([]));
    vi.useRealTimers();
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Safety-Score-Status")).toBe("current");
    const body = DependencyGraphResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ publicationGenerationId: snapshot.safetyScoreIdentity.publicationGenerationId, methodologyVersion: snapshot.methodology.version, asOfSec: snapshot.asOfSec, updatedAt: snapshot.updatedAt });
    expect(body.commonModeGroups).toEqual(snapshot.commonModeGroups);
    expect(body.nodes.map(({ pillars: _pillars, ...node }) => node)).toEqual([
      { id: "child", grade: snapshot.cards[0]!.grade, ratingStatus: "rated", partialEvidence: null, score: 80, circulatingUsdAtEvaluation: 0, supplyAsOfSec: 100, sharedBookId: "book-1", roles: [{ upstreamAssetId: "parent", economicRole: "exit-dependency", weight: 0.4 }], dependencyCoverageCount: 0 },
      { id: "parent", grade: "NR", ratingStatus: "not-rated", partialEvidence: null, score: null, circulatingUsdAtEvaluation: null, supplyAsOfSec: null, sharedBookId: null, roles: [], dependencyCoverageCount: null },
    ]);
    expect(body.nodes[0]!.pillars).toMatchObject({
      backing: { score: snapshot.cards[0]!.pillars.backing.score },
      exit: { score: snapshot.cards[0]!.pillars.exit.score },
      control: { score: snapshot.cards[0]!.pillars.control.score },
    });
    expect(body.edges).toEqual(snapshot.dependencyGraph.edges);
    expect(body).not.toHaveProperty("cards");
  });

  it("resolves common-mode deployment adjustment prices without exposing evaluator detail", () => {
    const snapshot = fixturePublication();
    const card = snapshot.cards[0]!;
    card.scoreTrace.deploymentRisk.adjustments = [{
      signalKey: "signal-1", sourceSignalKeys: ["signal-1"], exposureKey: "exposure-1",
      riskEventKey: "event-1", failureDomainKey: "mint-control:shared",
      nominalExposureShare: 0.4, exposureShare: 0.4, exposedScore: 80,
      scoreBefore: 80, scoreAfter: 72, adjustmentPoints: 8, modeledLossPoints: 8,
      reason: "Reviewed deployment adjustment",
    }];
    snapshot.commonModeGroups![0]!.pricedEffects = [{ assetId: "child", capIndices: [], deploymentAdjustmentIndices: [0] }];
    const before = structuredClone(snapshot);
    const body = DependencyGraphResponseSchema.parse(projectDependencyGraph(snapshot));
    expect(body.commonModeGroups![0]!.pricedEffects).toEqual([{
      assetId: "child", capIndices: [], deploymentAdjustmentIndices: [0],
      resolvedCaps: [],
      resolvedAdjustments: [{ scoreBefore: 80, scoreAfter: 72, adjustmentPoints: 8 }],
    }]);
    expect(snapshot).toEqual(before);
  });

  it.each(["missing-card", "missing-indices"] as const)("marks %s references unresolved without inventing a price or dropping other prices", (missing) => {
    const snapshot = fixturePublication();
    snapshot.cards[0]!.scoreTrace.deploymentRisk.adjustments = [{
      signalKey: "signal-1", sourceSignalKeys: ["signal-1"], exposureKey: "exposure-1",
      riskEventKey: "event-1", failureDomainKey: "mint-control:shared",
      nominalExposureShare: 0.4, exposureShare: 0.4, exposedScore: 80,
      scoreBefore: 80, scoreAfter: 72, adjustmentPoints: 8, modeledLossPoints: 8,
      reason: "Reviewed deployment adjustment",
    }];
    snapshot.commonModeGroups![0]!.pricedEffects = [
      { assetId: "child", capIndices: [], deploymentAdjustmentIndices: [0] },
      { assetId: "parent", capIndices: [], deploymentAdjustmentIndices: [0] },
    ];
    if (missing === "missing-card") snapshot.cards = snapshot.cards.filter((card) => card.id !== "parent");
    const body = DependencyGraphResponseSchema.parse(projectDependencyGraph(snapshot));
    expect(body.commonModeGroups![0]!.pricedEffects).toEqual([
      { assetId: "child", capIndices: [], deploymentAdjustmentIndices: [0], resolvedCaps: [], resolvedAdjustments: [{ scoreBefore: 80, scoreAfter: 72, adjustmentPoints: 8 }] },
      { assetId: "parent", capIndices: [], deploymentAdjustmentIndices: [0], resolvedCaps: [], resolvedAdjustments: [], referencesUnresolved: true },
    ]);
  });

  it("omits only unresolved entries within a partly resolved effect", () => {
    const snapshot = fixturePublication();
    snapshot.commonModeGroups![0]!.pricedEffects = [{ assetId: "child", capIndices: [0, 2], deploymentAdjustmentIndices: [1] }];
    const body = DependencyGraphResponseSchema.parse(projectDependencyGraph(snapshot));
    expect(body.commonModeGroups![0]!.pricedEffects![0]).toEqual({
      assetId: "child", capIndices: [0, 2], deploymentAdjustmentIndices: [1],
      resolvedCaps: [],
      resolvedAdjustments: [], referencesUnresolved: true,
    });
  });

  it("serves the held accepted generation without caching and retains hold reasons", async () => {
    const current = fixturePublication();
    const snapshot = { ...current, publicationHealth: { ...current.publicationHealth, status: "held" as const, attemptedAtSec: current.updatedAt + 1800, heldSinceSec: current.updatedAt + 1800, reasons: [{ code: "dex-stale" as const }] } };
    mockLoadActiveSafetyScoreSource.mockResolvedValue({ kind: "v9", snapshot });
    const response = await handleDependencyGraph(mockD1([]));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Safety-Score-Status")).toBe("held");
    const body = DependencyGraphResponseSchema.parse(await response.json());
    expect(body.publicationStatus).toBe("held");
    expect(body.publicationHealth).toEqual(snapshot.publicationHealth);
    expect(body.publicationGenerationId).toBe(current.safetyScoreIdentity.publicationGenerationId);
    expect(body.edges).toEqual(current.dependencyGraph.edges);
  });

  it("fails closed without an accepted publication", async () => {
    mockLoadActiveSafetyScoreSource.mockResolvedValue({ kind: "error", detail: "Canonical Safety Score V9 publication is unavailable" });
    const response = await handleDependencyGraph(mockD1([]));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "Canonical Safety Score V9 publication is unavailable" });
    expect(getPublicApiAccess("/api/dependency-graph/v1")).toBe("exempt");
  });
});
