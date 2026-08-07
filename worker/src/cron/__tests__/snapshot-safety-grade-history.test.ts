import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";

const mockLoadActiveSafetyScoreSource = vi.fn();
const mockLoadSafetyScoreV9PublicationAttempt = vi.fn();
const mockFetchLatestSafetyScoreHistoryV2Rows = vi.fn();
const mockGetCache = vi.fn();
const mockSetCache = vi.fn();
const mockDeleteCache = vi.fn();

vi.mock("../../lib/safety-score-active-source", () => ({
  loadActiveSafetyScoreSource: mockLoadActiveSafetyScoreSource,
}));
vi.mock("../../lib/safety-score-v9-publication-store", () => ({
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

  it("skips history writes while the canonical V9 publication is held", async () => {
    const current = makeReportCardsV9Response();
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "v9",
      expectedModel: "v9",
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
      expectedModel: "v9",
      snapshot: makeReportCardsV9Response({ updatedAt: 1 }),
    });

    const result = await snapshotSafetyGradeHistory({} as D1Database);

    expect(result).toEqual({
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "v9-publication-stale",
        expectedModel: "v9",
        historyWritesSkipped: true,
      }),
    });
  });

  it("fails closed when V9 is unavailable", async () => {
    mockLoadActiveSafetyScoreSource.mockResolvedValue({
      kind: "error",
      expectedModel: "v9",
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
      expectedModel: "v9",
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
    const db = {
      prepare: vi.fn(() => ({ all })),
    } as unknown as D1Database;

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
      expectedModel: "v9",
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
    const db = {
      prepare: vi.fn(() => ({ all })),
    } as unknown as D1Database;

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
      expectedModel: "v9",
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
    const db = { prepare: vi.fn(() => ({ all })) } as unknown as D1Database;

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
      expectedModel: "v9",
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
    const all = vi.fn().mockResolvedValue({ results: [] });
    const bind = vi.fn(() => ({ statement: true }));
    const batch = vi.fn().mockResolvedValue([]);
    const db = {
      prepare: vi.fn(() => ({ all, bind })),
      batch,
    } as unknown as D1Database;

    const result = await snapshotSafetyGradeHistory(db);

    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      changed: 0,
      identityBoundaryBaselines: 1,
      skipped: 0,
    });
    expect(batch).toHaveBeenCalledTimes(1);
  });
});
