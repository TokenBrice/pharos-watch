import { buildReportCardsV9DependencyGraph, type ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import { internV9PublicWitnessTexts } from "@shared/lib/safety-score-v9/public-witness-texts";

/**
 * The unavailable case stays a real end-to-end read against an empty schema;
 * the current/held projection is driven through this override so both arms of
 * the one canonical loader are covered in one place.
 */
const mocks = vi.hoisted(() => ({
  snapshotOverride: null as null | (() => Promise<ReportCardsV9CurrentResponse>),
}));

vi.mock("../report-cards-v9-cache", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../report-cards-v9-cache")>();
  return {
    ...actual,
    loadPublishedReportCardsV9Snapshot: (db: D1Database, signal?: AbortSignal) =>
      mocks.snapshotOverride
        ? mocks.snapshotOverride()
        : actual.loadPublishedReportCardsV9Snapshot(db, signal),
  };
});

const { loadActiveSafetyScoreSource } = await import(
  "../safety-score-active-source"
);

function heldSnapshot(): ReportCardsV9CurrentResponse {
  const current = makeReportCardsV9Response();
  return makeReportCardsV9Response({
    publicationHealth: {
      ...current.publicationHealth,
      status: "held",
      attemptedAtSec: current.updatedAt + 1_800,
      heldSinceSec: current.updatedAt + 1_800,
      reasons: [{ code: "dex-stale" }],
    },
  });
}

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

describe("active Safety Score source", () => {
  beforeEach(() => {
    mocks.snapshotOverride = null;
  });

  it("fails closed without falling back to V8", async () => {
    const { db } = fixtures.open();

    await expect(loadActiveSafetyScoreSource(db)).resolves.toEqual({
      kind: "error",
      reason: "v9-snapshot-unavailable",
      snapshot: null,
      detail: "Canonical Safety Score V9 publication is unavailable",
    });
  });

  it.each(["current", "held"] as const)("resolves %s witness text before digest consumers receive it", async (status) => {
    const semantic = status === "current" ? makeReportCardsV9Response() : heldSnapshot();
    const reason = { code: "unresolved-control-identity" as const, message: "The independently scoped incident disposition remains unknown.", path: "control:incidentState" };
    semantic.cards[0]!.evidence.reasons = [reason];
    semantic.cards[0]!.pillars.control.reasons = [reason];
    const wire = { ...semantic, cards: semantic.cards.map((card) => internV9PublicWitnessTexts(card)) };
    mocks.snapshotOverride = async () => wire;
    const result = await loadActiveSafetyScoreSource({} as D1Database);
    expect(result.kind).toBe(status === "current" ? "v9" : "held");
    expect(result.snapshot).toEqual(semantic);
  });

  it("re-projects the dependency graph from decoded cards", async () => {
    const semantic = makeReportCardsV9Response();
    const label = "Staked vault share used as collateral intermediary";
    const provenance = { source: "live-reserve" as const, evidenceAsOf: "2026-10-11", intermediary: { kind: "vault-share" as const, label, verified: true } };
    const dependency = { score: 80, ratingStatus: "rated" as const, partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: [], provenance };
    semantic.cards[0]!.dependencies = {
      ...semantic.cards[0]!.dependencies,
      serial: [{ ...dependency, upstreamAssetId: "parent", blocked: false, dependencyType: "wrapper", wrapperForm: "strategy-vault" }],
      basket: [{ ...dependency, upstreamAssetId: "other", weight: 0.5, boundedUnknown: false, dependencyType: "collateral", wrapperForm: null }],
    } as typeof semantic.cards[0]["dependencies"];
    const cards = semantic.cards.map((card) => internV9PublicWitnessTexts(card));
    const wire = { ...semantic, cards, dependencyGraph: buildReportCardsV9DependencyGraph(cards) };
    expect(JSON.stringify(wire.dependencyGraph)).not.toContain(label);
    mocks.snapshotOverride = async () => wire;

    const result = await loadActiveSafetyScoreSource({} as D1Database);
    expect(result.snapshot?.dependencyGraph).toEqual(buildReportCardsV9DependencyGraph(semantic.cards));
    expect(result.snapshot?.dependencyGraph.edges.map((edge) => edge.provenance?.intermediary?.label)).toEqual([label, label]);
  });

  it("reports a held publication as its own state and keeps the snapshot", async () => {
    const snapshot = heldSnapshot();
    mocks.snapshotOverride = async () => snapshot;

    await expect(
      loadActiveSafetyScoreSource({} as D1Database),
    ).resolves.toEqual({
      kind: "held",
      reason: "v9-publication-held",
      detail:
        "Canonical Safety Score V9 ratings are held at the last verified snapshot",
      snapshot,
    });
  });
});
