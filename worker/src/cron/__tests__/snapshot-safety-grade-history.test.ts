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
});
