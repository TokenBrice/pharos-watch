import { makeReportCardsV9PartialCard } from "@shared/test-utils/report-cards-v9";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import type { CollectorContext } from "../daily-digest/collectors-shared";
import { makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

const mockLoadActiveSafetyScoreSource = vi.fn();
const mockLoadSafetyScoreV9PublicationAttempt = vi.fn();
const mockFetchLatestSafetyScoreHistoryV2Rows = vi.fn();
const mockGetCache = vi.fn();
const mockSetCache = vi.fn();
const mockDeleteCache = vi.fn();

vi.mock("../../lib/safety-score-active-source", () => ({
  loadActiveSafetyScoreSource: mockLoadActiveSafetyScoreSource,
}));
vi.mock("../../lib/safety-score-v9/publication-store", () => ({
  loadSafetyScoreV9PublicationAttempt:
    mockLoadSafetyScoreV9PublicationAttempt,
}));
vi.mock("../../lib/db-cache", () => ({
  getCache: mockGetCache,
  setCache: mockSetCache,
  deleteCache: mockDeleteCache,
}));
vi.mock("../../lib/safety-score-history-v2", async (importOriginal) => ({
  ...await importOriginal<
    typeof import("../../lib/safety-score-history-v2")
  >(),
  fetchLatestSafetyScoreHistoryV2Rows:
    mockFetchLatestSafetyScoreHistoryV2Rows,
}));

const { snapshotSafetyGradeHistory } = await import(
  "../snapshot-safety-grade-history"
);

describe("snapshotSafetyGradeHistory", () => {
  beforeEach(() => {
    mockLoadActiveSafetyScoreSource.mockReset();
    mockLoadSafetyScoreV9PublicationAttempt
      .mockReset()
      .mockResolvedValue(null);
    mockFetchLatestSafetyScoreHistoryV2Rows
      .mockReset()
      .mockResolvedValue([]);
    mockGetCache.mockReset().mockResolvedValue(null);
    mockSetCache.mockReset().mockResolvedValue(undefined);
    mockDeleteCache.mockReset().mockResolvedValue(undefined);
  });

  it("preserves the last grade across an asset pipeline gap without seeding NR or F", async () => {
    const current = makeReportCardsV9Response({
      updatedAt: Math.floor(Date.now() / 1000),
      cards: [makeWorkerV9Card({ id: "usdc-circle", grade: "A", score: 90 })],
    });
    const { db, sqlite } = fixtures.open();
    mockLoadActiveSafetyScoreSource.mockResolvedValue({ kind: "v9", snapshot: current });
    await snapshotSafetyGradeHistory(db);
    const previousRows = sqlite.prepare("SELECT * FROM safety_score_history_v2").all();
    mockFetchLatestSafetyScoreHistoryV2Rows.mockResolvedValue(previousRows);
    const gap = makeReportCardsV9PipelineGapCard("control", "A", { id: "usdc-circle" });
    const unseededGap = makeReportCardsV9PipelineGapCard(null, "A", { id: "usdt-tether" });
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "v9", snapshot: makeReportCardsV9Response({ updatedAt: current.updatedAt, cards: [gap, unseededGap] }),
    });
    expect(await snapshotSafetyGradeHistory(db)).toMatchObject({ itemCount: 0 });
    expect(sqlite.prepare("SELECT * FROM safety_score_history_v2").all()).toEqual(previousRows);
  });

  it("skips history writes while the canonical V9 publication is held", async () => {
    const current = makeReportCardsV9Response();
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "held",
      reason: "v9-publication-held",
      detail: "Canonical Safety Score V9 ratings are held at the last verified snapshot",
      snapshot: makeReportCardsV9Response({
        publicationHealth: {
          ...current.publicationHealth,
          status: "held",
          attemptedAtSec: current.updatedAt + 1_800,
          heldSinceSec: current.updatedAt + 1_800,
          reasons: [{ code: "dex-stale" }],
        },
      }),
    });

    const result = await snapshotSafetyGradeHistory({} as D1Database);

    expect(result).toMatchObject({ status: "degraded", itemCount: 0 });
    expect(result.metadata).toContain("v9-publication-held");
  });

  it("skips history writes while the current V9 publication is stale", async () => {
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "v9",
      snapshot: makeReportCardsV9Response({ updatedAt: 1 }),
    });

    const result = await snapshotSafetyGradeHistory({} as D1Database);

    expect(result).toEqual({
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "v9-publication-stale",
        historyWritesSkipped: true,
      }),
    });
  });

  it("fails closed when V9 is unavailable", async () => {
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "error",
      reason: "v9-snapshot-unavailable",
      snapshot: null,
      detail: "missing",
    });

    const result = await snapshotSafetyGradeHistory({} as D1Database);

    expect(result).toMatchObject({ status: "error", itemCount: 0 });
  });

  it("does not record an affected NR as an organic grade transition", async () => {
    const current = makeReportCardsV9Response({
      updatedAt: Math.floor(Date.now() / 1000),
      cards: [
        makeWorkerV9Card({
          score: null,
          grade: "NR",
        }),
      ],
    });
    const card = current.cards[0]!;
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "v9",
      snapshot: current,
    });
    mockLoadSafetyScoreV9PublicationAttempt.mockResolvedValue({
      schemaVersion: 1,
      attemptedAtSec: current.updatedAt,
      outcome: "published-partial",
      publicationGenerationId:
        current.safetyScoreIdentity.publicationGenerationId,
      quarantines: [
        {
          assetId: card.id,
          code: "fact-build-failed",
          message: "fixture quarantine",
        },
      ],
      affectedAssetIds: [card.id],
    });
    const all = vi.fn().mockResolvedValue({
      results: [
        {
          stablecoin_id: card.id,
          grade: "A",
          score: 85,
          recorded_at: current.updatedAt - 86_400,
        },
      ],
    });
    const db = makeNoopD1({
      prepare: vi.fn(() => ({ all })),
    });

    const result = await snapshotSafetyGradeHistory(db);

    expect(result).toMatchObject({
      status: "degraded",
      itemCount: 0,
    });
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      suppressedTransitions: 1,
      gradeHistorySuppressed: true,
    });
    expect(mockSetCache).toHaveBeenCalledWith(
      expect.anything(),
      "safety-score-history:v2:operationally-affected",
      JSON.stringify([card.id]),
      undefined,
    );
  });

  it("suppresses the first clean recovery transition and clears its marker", async () => {
    const current = makeReportCardsV9Response({
      updatedAt: Math.floor(Date.now() / 1000),
      cards: [makeWorkerV9Card({ grade: "A", score: 85 })],
    });
    const card = current.cards[0]!;
    const identity = current.safetyScoreIdentity;
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "v9",
      snapshot: current,
    });
    mockLoadSafetyScoreV9PublicationAttempt.mockResolvedValue({
      schemaVersion: 1,
      attemptedAtSec: current.updatedAt,
      outcome: "published-clean",
      publicationGenerationId: identity.publicationGenerationId,
      quarantines: [],
      affectedAssetIds: [],
    });
    mockGetCache.mockResolvedValue({
      value: JSON.stringify([card.id]),
      updatedAt: current.updatedAt - 1_800,
    });
    mockFetchLatestSafetyScoreHistoryV2Rows.mockResolvedValue([
      {
        history_id: "history:alpha",
        stablecoin_id: card.id,
        recorded_at: current.updatedAt - 86_400,
        model: identity.model,
        identity_schema_version: identity.schemaVersion,
        methodology_version: identity.methodologyVersion,
        policy_id: identity.policyId,
        policy_digest: identity.policyDigest,
        evaluation_build_digest:
          identity.evaluationBuildDigest,
        base_input_generation_id:
          identity.baseInputGenerationId,
        model_publication_generation_id:
          identity.publicationGenerationId,
        transition_kind: "organic-grade-change",
        grade: "B",
        score: 75,
        prev_grade: "A",
        prev_score: 85,
      },
    ]);
    const all = vi.fn().mockResolvedValue({ results: [] });
    const db = makeNoopD1({
      prepare: vi.fn(() => ({ all })),
    });

    const result = await snapshotSafetyGradeHistory(db);

    expect(result).toMatchObject({
      status: "degraded",
      itemCount: 0,
    });
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      suppressedTransitions: 1,
      gradeHistorySuppressed: true,
    });
    expect(mockDeleteCache).toHaveBeenCalledWith(
      db,
      "safety-score-history:v2:operationally-affected",
    );
  });

  /**
   * 9.07 native-input boundary. The writer keys comparability on the
   * *publication* identity; the capture's `model: "v9-input"` identity never
   * reaches it, because `safetyScoreHistoryIdentityFromV2Row` reconstructs the
   * predecessor from V2 row columns and no column carries the input model. So
   * moving the producer to the native capture cannot manufacture a boundary or
   * an organic transition on its own.
   */
  it("does not treat the native-input projection change as a history boundary", async () => {
    const current = makeReportCardsV9Response({
      updatedAt: Math.floor(Date.now() / 1000),
      cards: [
        makeWorkerV9Card({ id: "usdc-circle", grade: "A", score: 85 }),
        makeWorkerV9Card({ id: "usdt-tether", grade: "B", score: 72 }),
      ],
    });
    const identity = current.safetyScoreIdentity;
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "v9",
      snapshot: current,
    });
    // The predecessor row was written by the pre-cutover producer: the same V9
    // publication identity, but a different base-input generation id, which is
    // exactly what a projection change moves.
    mockFetchLatestSafetyScoreHistoryV2Rows.mockResolvedValue(
      current.cards.map((card, index) => ({
        history_id: `history:${card.id}`,
        stablecoin_id: card.id,
        recorded_at: current.updatedAt - 86_400,
        model: identity.model,
        identity_schema_version: identity.schemaVersion,
        methodology_version: identity.methodologyVersion,
        policy_id: identity.policyId,
        policy_digest: identity.policyDigest,
        evaluation_build_digest: identity.evaluationBuildDigest,
        base_input_generation_id: `report-cards-input:v1:${String(index).repeat(64).slice(0, 64)}`,
        model_publication_generation_id: `${identity.publicationGenerationId}-previous`,
        transition_kind: "initial-baseline",
        grade: card.grade,
        score: card.score,
        prev_grade: null,
        prev_score: null,
      })),
    );
    const all = vi.fn().mockResolvedValue({ results: [] });
    const db = makeNoopD1({ prepare: vi.fn(() => ({ all })) });

    const result = await snapshotSafetyGradeHistory(db);

    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      skipped: 2,
      changed: 0,
      identityBoundaryBaselines: 0,
      suppressedIdentityTransitions: 0,
      v2RowsWritten: 0,
    });
  });

  /**
   * The counter-case that keeps the assertion above honest: the evaluation
   * build IS part of publication-identity comparability, so the 9.07 deploy —
   * which rotates `evaluationBuildDigest` because the V8 engine deletion
   * changed pinned files — writes one boundary baseline per asset instead of
   * organic transitions.
   */
  it("writes a boundary baseline when the evaluation build rotates", async () => {
    const current = makeReportCardsV9Response({
      updatedAt: Math.floor(Date.now() / 1000),
      cards: [makeWorkerV9Card({ id: "usdc-circle", grade: "A", score: 85 })],
    });
    const identity = current.safetyScoreIdentity;
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "v9",
      snapshot: current,
    });
    mockFetchLatestSafetyScoreHistoryV2Rows.mockResolvedValue([
      {
        history_id: "history:usdc-circle",
        stablecoin_id: "usdc-circle",
        recorded_at: current.updatedAt - 86_400,
        model: identity.model,
        identity_schema_version: identity.schemaVersion,
        methodology_version: identity.methodologyVersion,
        policy_id: identity.policyId,
        policy_digest: identity.policyDigest,
        evaluation_build_digest: "c".repeat(64),
        base_input_generation_id: identity.baseInputGenerationId,
        model_publication_generation_id: `${identity.publicationGenerationId}-previous`,
        transition_kind: "initial-baseline",
        grade: "B",
        score: 72,
        prev_grade: null,
        prev_score: null,
      },
    ]);
    const { db, sqlite } = fixtures.open();

    const result = await snapshotSafetyGradeHistory(db);

    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      changed: 0,
      identityBoundaryBaselines: 1,
      skipped: 0,
    });
    expect(sqlite.prepare("SELECT stablecoin_id, transition_kind, evaluation_build_digest, model_publication_generation_id, prev_grade FROM safety_score_history_v2").all()).toEqual([{
      stablecoin_id: "usdc-circle",
      transition_kind: "methodology-boundary-baseline",
      evaluation_build_digest: identity.evaluationBuildDigest,
      model_publication_generation_id: identity.publicationGenerationId,
      prev_grade: null,
    }]);
  });

  it("stores an initial baseline with no predecessor", async () => {
    const current = makeReportCardsV9Response({
      updatedAt: Math.floor(Date.now() / 1000),
      cards: [makeWorkerV9Card({ id: "usdc-circle", grade: "A", score: 85 })],
    });
    mockLoadActiveSafetyScoreSource.mockResolvedValue({ kind: "v9", snapshot: current });
    const { db, sqlite } = fixtures.open();
    await snapshotSafetyGradeHistory(db);
    expect(sqlite.prepare("SELECT stablecoin_id, grade, score, prev_grade, prev_score, transition_kind FROM safety_score_history_v2").all()).toEqual([{
      stablecoin_id: "usdc-circle", grade: "A", score: 85,
      prev_grade: null, prev_score: null, transition_kind: "initial-baseline",
    }]);
  });

  it("stores comparable grade transitions but ignores score-only changes", async () => {
    const current = makeReportCardsV9Response({
      updatedAt: Math.floor(Date.now() / 1000),
      cards: [
        makeWorkerV9Card({ id: "usdc-circle", grade: "A", score: 85 }),
        makeWorkerV9Card({ id: "usdt-tether", grade: "B", score: 74 }),
      ],
    });
    mockLoadActiveSafetyScoreSource.mockResolvedValue({ kind: "v9", snapshot: current });
    const identity = current.safetyScoreIdentity;
    mockFetchLatestSafetyScoreHistoryV2Rows.mockResolvedValue(current.cards.map((card) => ({
      history_id: `previous:${card.id}`, stablecoin_id: card.id,
      recorded_at: current.updatedAt - 86400,
      model: identity.model, identity_schema_version: identity.schemaVersion,
      methodology_version: identity.methodologyVersion, policy_id: identity.policyId,
      policy_digest: identity.policyDigest, evaluation_build_digest: identity.evaluationBuildDigest,
      base_input_generation_id: identity.baseInputGenerationId,
      model_publication_generation_id: identity.publicationGenerationId,
      transition_kind: "initial-baseline", grade: "B", score: 72, prev_grade: null, prev_score: null,
    })));
    const { db, sqlite } = fixtures.open();
    await snapshotSafetyGradeHistory(db);
    expect(sqlite.prepare("SELECT stablecoin_id, grade, score, prev_grade, prev_score, transition_kind FROM safety_score_history_v2").all()).toEqual([{
      stablecoin_id: "usdc-circle", grade: "A", score: 85,
      prev_grade: "B", prev_score: 72, transition_kind: "organic-grade-change",
    }]);
  });

  it.each(["generation-mismatch", "malformed-marker"])("fails closed for %s", async (fault) => {
    const current = makeReportCardsV9Response({ updatedAt: Math.floor(Date.now() / 1000) });
    mockLoadActiveSafetyScoreSource.mockResolvedValue({ kind: "v9", snapshot: current });
    if (fault === "generation-mismatch") {
      mockLoadSafetyScoreV9PublicationAttempt.mockResolvedValue({
        outcome: "published-clean", publicationGenerationId: "another-generation",
      });
    } else {
      mockGetCache.mockResolvedValue({ value: JSON.stringify([42]), updatedAt: current.updatedAt });
    }
    const { db, sqlite } = fixtures.open();
    expect(await snapshotSafetyGradeHistory(db)).toMatchObject({ status: "error", itemCount: 0 });
    expect(sqlite.prepare("SELECT * FROM safety_score_history_v2").all()).toEqual([]);
    expect(mockDeleteCache).not.toHaveBeenCalled();
    expect(mockSetCache).not.toHaveBeenCalled();
  });

  it("preserves the affected marker when a clean asset's history write fails", async () => {
    const current = makeReportCardsV9Response({
      updatedAt: Math.floor(Date.now() / 1000),
      cards: [makeWorkerV9Card({ id: "usdc-circle", grade: "A", score: 85 })],
    });
    mockLoadActiveSafetyScoreSource.mockResolvedValue({ kind: "v9", snapshot: current });
    mockGetCache.mockResolvedValue({ value: JSON.stringify(["usdt-tether"]), updatedAt: current.updatedAt });
    const { db, sqlite } = fixtures.open();
    sqlite.exec("CREATE TRIGGER fail_history BEFORE INSERT ON safety_score_history_v2 BEGIN SELECT RAISE(ABORT, 'history unavailable'); END");
    await expect(snapshotSafetyGradeHistory(db)).rejects.toThrow("history unavailable");
    expect(mockDeleteCache).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT * FROM safety_score_history_v2").all()).toEqual([]);
  });
});

describe("digest grade availability", () => {
  it("excludes technical gaps from grade cohorts and transitions while retaining partial-rated metadata", async () => {
    // Load after the source/history mock bindings initialize, as the history entrypoint does.
    const { collectSafetyScores, collectGradeTransitions } = await import("../daily-digest/collectors-risk");
    const nowSec = Math.floor(Date.now() / 1000);
    const snapshot = makeReportCardsV9Response({
      updatedAt: nowSec,
      cards: [
        makeReportCardsV9PipelineGapCard("control", "A", { id: "gap" }),
        makeReportCardsV9PartialCard("exit", "B", { id: "partial" }),
      ],
    });
    mockLoadActiveSafetyScoreSource.mockResolvedValue({ kind: "v9", snapshot });
    const assets = [makeAsset({ id: "gap", symbol: "GAP", circulating: { peggedUSD: 20_000_000 } }),
      makeAsset({ id: "partial", symbol: "PARTIAL", circulating: { peggedUSD: 20_000_000 } })];
    const identity = snapshot.safetyScoreIdentity;
    const ctx: CollectorContext = {
      db: mockD1([
        { match: "GROUP BY recorded_at", rows: [] },
        { match: "ORDER BY ABS", rows: [{
          history_id: "prior-gap-change", stablecoin_id: "gap", recorded_at: nowSec - 3600,
          model: identity.model, identity_schema_version: identity.schemaVersion,
          methodology_version: identity.methodologyVersion, policy_id: identity.policyId,
          policy_digest: identity.policyDigest, evaluation_build_digest: identity.evaluationBuildDigest,
          base_input_generation_id: identity.baseInputGenerationId, model_publication_generation_id: identity.publicationGenerationId,
          transition_kind: "organic-grade-change", grade: "F", score: 20, prev_grade: "A", prev_score: 90,
        }] },
      ], { requireMatch: true }),
      trackedStablecoinAssets: assets, trackedStablecoinIds: new Set(assets.map((asset) => asset.id)),
      coreAggregateStablecoinAssets: assets, coreAggregateStablecoinIds: new Set(assets.map((asset) => asset.id)),
      stablecoinAssetById: new Map(assets.map((asset) => [asset.id, asset])),
      mcapById: new Map(assets.map((asset) => [asset.id, 20_000_000])),
      stablecoinsCacheIsFresh: true, nowSec, todayTs: nowSec, yesterdayTs: nowSec - 86400,
    };
    const collected = await collectSafetyScores(ctx, new Set(["GAP", "PARTIAL"]));
    expect(collected.degradedReasons).toEqual([]);
    expect(collected.value.safetyGrades?.map((row) => row.id)).toEqual(["partial"]);
    expect(collected.value.safetyScores?.mentionedCoins).toEqual([
      expect.objectContaining({ symbol: "PARTIAL", ratingStatus: "rated", partialEvidence: {
        reasonCode: "partial-evidence-pipeline-gap", excludedPillars: ["exit"], causes: ["B"],
      } }),
    ]);
    expect(collected.value.safetyScores?.model === "v9" ? collected.value.safetyScores.gradeDistribution : null).not.toHaveProperty("NR");
    const transitions = await collectGradeTransitions(ctx, collected.value.safetyGrades, collected.value.safetyIdentity);
    expect(transitions).toEqual({ value: undefined, degradedReasons: [] });
  });
});

