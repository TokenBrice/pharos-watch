import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportCard, ReportCardGrade } from "@shared/types/report-cards";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { mockD1, type MockPreparedStatement } from "../../test-helpers/__shared/mock-d1";

vi.mock("../../lib/safety-score-history-v2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/safety-score-history-v2")>();
  return {
    ...actual,
    loadActiveV8SafetyScoreHistorySource: vi.fn(),
  };
});

vi.mock("../../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...actual,
    batchExecute: vi.fn(async (_db: D1Database, stmts: D1PreparedStatement[]) => stmts.length),
  };
});

vi.mock("../../lib/cron-logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/cron-logger")>();
  return {
    ...actual,
    recordCronFailure: vi.fn(),
  };
});

import { snapshotSafetyGradeHistory } from "../snapshot-safety-grade-history";
import { batchExecute } from "../../lib/db";
import { recordCronFailure } from "../../lib/cron-logger";
import {
  ActiveV8SafetyScoreHistorySourceInactiveError,
  loadActiveV8SafetyScoreHistorySource,
} from "../../lib/safety-score-history-v2";

const DIGEST = "a".repeat(64);
const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${"b".repeat(64)}`;
const MODEL_PUBLICATION_GENERATION_ID = "report-cards:8.17:1777770000";

function makeCard(id: string, grade: ReportCardGrade, score: number | null, isDefunct = false): ReportCard {
  const dim = { grade, score, detail: "ok" };
  return {
    id,
    name: `Coin ${id}`,
    symbol: `C${id}`,
    overallGrade: grade,
    overallScore: score,
    baseScore: null,
    dimensions: {
      pegStability: dim,
      liquidity: dim,
      resilience: dim,
      decentralization: dim,
      dependencyRisk: dim,
    },
    ratedDimensions: 5,
    rawInputs: {
      pegScore: null,
      activeDepeg: false,
      activeDepegBps: null,
      depegEventCount: 0,
      lastEventAt: null,
      liquidityScore: null,
      effectiveExitScore: null,
      redemptionBackstopScore: null,
      redemptionRouteFamily: null,
      redemptionModelConfidence: null,
      redemptionUsedForLiquidity: false,
      redemptionImmediateCapacityUsd: null,
      redemptionImmediateCapacityRatio: null,
      concentrationHhi: null,
      bluechipGrade: null,
      canBeBlacklisted: false,
      chainTier: "ethereum",
      deploymentModel: "single-chain",
      collateralQuality: "native",
      custodyModel: "onchain",
      governanceTier: "centralized",
      governanceQuality: "single-entity",
      dependencies: [],
      navToken: false,
      collateralFromLive: false,
      dependencyFromLive: false,
    },
    isDefunct,
  };
}

function makeV8HistoryRow(id: string, grade: ReportCardGrade, score: number | null, recordedAt: number) {
  return {
    history_id: `v8-${id}-${recordedAt}`,
    stablecoin_id: id,
    recorded_at: recordedAt,
    model: "v8" as const,
    identity_schema_version: 1,
    methodology_version: SAFETY_SCORE_METHODOLOGY_VERSION,
    policy_id: null,
    policy_digest: null,
    evaluation_build_digest: DIGEST,
    base_input_generation_id: BASE_INPUT_GENERATION_ID,
    model_publication_generation_id: MODEL_PUBLICATION_GENERATION_ID,
    transition_kind: "organic-grade-change" as const,
    grade,
    score,
    prev_grade: null,
    prev_score: null,
  };
}

function makeNonComparableV8HistoryRow(id: string) {
  return {
    ...makeV8HistoryRow(id, "A", 84, 1_777_770_000),
    history_id: `v8-prior-build-${id}`,
    evaluation_build_digest: "c".repeat(64),
  };
}

function mockSnapshot(
  cards: ReportCard[],
  overrides: Partial<{
    liquidityStale: boolean;
    redemptionStale: boolean;
  }> = {},
) {
  const liquidityStale = overrides.liquidityStale ?? false;
  const redemptionStale = overrides.redemptionStale ?? false;
  vi.mocked(loadActiveV8SafetyScoreHistorySource).mockResolvedValue({
    snapshot: {
      cards,
      methodology: {
        version: SAFETY_SCORE_METHODOLOGY_VERSION,
        weights: {
          pegStability: 0,
          liquidity: 0,
          resilience: 0,
          decentralization: 0,
          dependencyRisk: 0,
        },
        pegMultiplierExponent: 0,
        activeDepegSeveritySource: "open-event-peak",
        activeDepegCaps: {
          d: { thresholdBps: 1000, score: 49 },
          f: { thresholdBps: 2500, score: 39 },
        },
        thresholds: [],
      },
      dependencyGraph: { edges: [] },
      updatedAt: 1_777_770_000,
      liquidityStale,
      redemptionStale,
      inputFreshness: {
        dexLiquidity: { updatedAt: 1_777_770_000, ageSeconds: 0, stale: liquidityStale },
        redemptionBackstops: { updatedAt: 1_777_770_000, ageSeconds: 0, stale: redemptionStale },
      },
    },
    identity: {
      model: "v8",
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      evaluationBuildDigest: DIGEST,
      baseInputGenerationId: BASE_INPUT_GENERATION_ID,
      publicationGenerationId: MODEL_PUBLICATION_GENERATION_ID,
      schemaVersion: 1,
    },
    publishedAtSec: 1_777_770_000,
  });
}

describe("snapshotSafetyGradeHistory", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-05T12:34:56Z"));
    vi.mocked(batchExecute)
      .mockReset()
      .mockImplementation(async (_db, stmts) => stmts.length);
    vi.mocked(loadActiveV8SafetyScoreHistorySource).mockReset();
    vi.mocked(recordCronFailure).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not write grade history when dependency graph policy rejects the snapshot", async () => {
    vi.mocked(loadActiveV8SafetyScoreHistorySource).mockRejectedValue(
      new Error("Dependency graph rejected (live-scc-unresolved): a <-> b"),
    );
    const db = mockD1([]);

    const result = await snapshotSafetyGradeHistory(db);

    expect(result).toMatchObject({ status: "error", itemCount: 0 });
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({ reason: "active-model-source-unavailable" });
    expect(batchExecute).not.toHaveBeenCalled();
    expect(db.getHistory()).toEqual([]);
  });

  it("skips V8 history intentionally without recording a false failure when V9 is active", async () => {
    vi.mocked(loadActiveV8SafetyScoreHistorySource).mockRejectedValue(
      new ActiveV8SafetyScoreHistorySourceInactiveError(),
    );
    const db = mockD1([]);

    const result = await snapshotSafetyGradeHistory(db);

    expect(result).toEqual({
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "active-model-v9",
        expectedModel: "v9",
        historyWritesSkipped: true,
      }),
    });
    expect(recordCronFailure).not.toHaveBeenCalled();
    expect(batchExecute).not.toHaveBeenCalled();
    expect(db.getHistory()).toEqual([]);
  });

  it("seeds rows for live coins without overwriting the publisher-owned report-card cache", async () => {
    mockSnapshot([
      makeCard("usdt-tether", "B", 72),
      makeCard("usdc-circle", "A", 84),
      makeCard("dead-1", "F", 0, true),
    ]);

    const db = mockD1([{ match: "FROM safety_grade_history h", rows: [] }]);

    const result = await snapshotSafetyGradeHistory(db);

    expect(result.itemCount).toBe(2);
    expect(batchExecute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(batchExecute).mock.calls[0][1]).toHaveLength(4);

    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata.snapshotDay).toBe(Math.floor(Date.now() / 1000 / 86_400) * 86_400);
    expect(metadata.methodologyVersion).toBe(SAFETY_SCORE_METHODOLOGY_VERSION);
    expect(metadata.model).toBe("v8");
    expect(metadata.evaluationBuildDigest).toBe(DIGEST);
    expect(metadata.baseInputGenerationId).toBe(BASE_INPUT_GENERATION_ID);
    expect(metadata.modelPublicationGenerationId).toBe(MODEL_PUBLICATION_GENERATION_ID);
    expect(metadata.seeded).toBe(2);
    expect(metadata.v2RowsWritten).toBe(2);
    expect(metadata.changed).toBe(0);
    expect(metadata.skipped).toBe(0);
    expect(metadata.reportCardCacheOwner).toBe("publish-report-card-cache");
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"))).toBe(false);
  });

  it("inserts only transition rows when grades change", async () => {
    mockSnapshot([makeCard("usdt-tether", "B", 72), makeCard("usdc-circle", "B+", 77)]);

    const db = mockD1([
      {
        match: "FROM safety_grade_history h",
        rows: [
          { stablecoin_id: "usdt-tether", grade: "B", score: 71, recorded_at: 1_777_680_000 },
          { stablecoin_id: "usdc-circle", grade: "A", score: 83, recorded_at: 1_777_680_000 },
        ],
      },
      {
        match: "FROM safety_score_history_v2",
        rows: [
          makeV8HistoryRow("usdt-tether", "B", 71, 1_777_680_000),
          makeV8HistoryRow("usdc-circle", "A", 83, 1_777_680_000),
        ],
      },
    ]);

    const result = await snapshotSafetyGradeHistory(db);

    expect(result.itemCount).toBe(1);
    expect(batchExecute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(batchExecute).mock.calls[0][1]).toHaveLength(2);

    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata.seeded).toBe(0);
    expect(metadata.changed).toBe(1);
    expect(metadata.skipped).toBe(1);
    expect(metadata.reportCardCacheOwner).toBe("publish-report-card-cache");
  });

  it("is idempotent when all live grades are unchanged", async () => {
    mockSnapshot([makeCard("usdt-tether", "B", 72), makeCard("usdc-circle", "A", 84)]);

    const db = mockD1([
      {
        match: "FROM safety_grade_history h",
        rows: [
          { stablecoin_id: "usdt-tether", grade: "B", score: 72, recorded_at: 1_777_760_000 },
          { stablecoin_id: "usdc-circle", grade: "A", score: 84, recorded_at: 1_777_760_000 },
        ],
      },
      {
        match: "FROM safety_score_history_v2",
        rows: [
          makeV8HistoryRow("usdt-tether", "B", 72, 1_777_760_000),
          makeV8HistoryRow("usdc-circle", "A", 84, 1_777_760_000),
        ],
      },
    ]);

    const result = await snapshotSafetyGradeHistory(db);

    expect(result.itemCount).toBe(0);
    expect(batchExecute).not.toHaveBeenCalled();

    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata.seeded).toBe(0);
    expect(metadata.changed).toBe(0);
    expect(metadata.skipped).toBe(2);
    expect(metadata.reportCardCacheOwner).toBe("publish-report-card-cache");
  });

  it("suppresses grade-history writes when report-card inputs are degraded", async () => {
    mockSnapshot([makeCard("usdt-tether", "B", 72), makeCard("usdc-circle", "B+", 77)], { redemptionStale: true });

    const db = mockD1([
      {
        match: "FROM safety_grade_history h",
        rows: [{ stablecoin_id: "usdc-circle", grade: "A", score: 83, recorded_at: 1_777_680_000 }],
      },
    ]);

    const result = await snapshotSafetyGradeHistory(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(batchExecute).not.toHaveBeenCalled();

    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata.degradedReportCardInputs).toBe(true);
    expect(metadata.gradeHistorySuppressed).toBe(true);
    expect(metadata.seeded).toBe(0);
    expect(metadata.changed).toBe(0);
    expect(metadata.suppressedSeeds).toBe(1);
    expect(metadata.suppressedTransitions).toBe(1);
    expect(metadata.reportCardCacheOwner).toBe("publish-report-card-cache");
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"))).toBe(false);
  });

  it("writes a methodology boundary baseline for a healthy non-comparable V2 identity", async () => {
    mockSnapshot([makeCard("usdt-tether", "B", 72)]);
    const db = mockD1([
      { match: "FROM safety_grade_history h", rows: [{ stablecoin_id: "usdt-tether", grade: "A", score: 84, recorded_at: 1_777_760_000 }] },
      {
        match: "FROM safety_score_history_v2",
        rows: [makeNonComparableV8HistoryRow("usdt-tether")],
      },
    ]);

    const result = await snapshotSafetyGradeHistory(db);

    expect(result).toMatchObject({ itemCount: 1 });
    expect(result.status).toBeUndefined();
    expect(batchExecute).toHaveBeenCalledTimes(1);
    const statements = vi.mocked(batchExecute).mock.calls[0][1] as MockPreparedStatement[];
    expect(statements).toHaveLength(1);
    expect(statements[0].boundValues).toMatchObject({
      3: "v8",
      8: DIGEST,
      11: "methodology-boundary-baseline",
      12: "B",
      13: 72,
    });
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      identityHistorySuppressed: false,
      suppressedIdentityTransitions: 0,
      suppressedTransitions: 0,
      identityBoundaryBaselines: 1,
    });
  });

  it("suppresses a non-comparable V2 boundary while report-card inputs are degraded", async () => {
    mockSnapshot([makeCard("usdt-tether", "B", 72)], { redemptionStale: true });
    const db = mockD1([
      { match: "FROM safety_grade_history h", rows: [] },
      { match: "FROM safety_score_history_v2", rows: [makeNonComparableV8HistoryRow("usdt-tether")] },
    ]);

    const result = await snapshotSafetyGradeHistory(db);

    expect(result).toMatchObject({ status: "degraded", itemCount: 0 });
    expect(batchExecute).not.toHaveBeenCalled();
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      identityHistorySuppressed: true,
      suppressedIdentityTransitions: 1,
      suppressedTransitions: 1,
      identityBoundaryBaselines: 0,
    });
  });

  it("fails closed instead of baselining a latest V9 row into V8 history", async () => {
    mockSnapshot([makeCard("usdt-tether", "B", 72)]);
    const db = mockD1([
      { match: "FROM safety_grade_history h", rows: [] },
      {
        match: "FROM safety_score_history_v2",
        rows: [
          {
            history_id: "v9-boundary",
            stablecoin_id: "usdt-tether",
            recorded_at: 1_777_770_000,
            model: "v9",
            identity_schema_version: 1,
            methodology_version: "9.0",
            policy_id: "v9-rc-1",
            policy_digest: "c".repeat(64),
            evaluation_build_digest: "d".repeat(64),
            base_input_generation_id: BASE_INPUT_GENERATION_ID,
            model_publication_generation_id: "safety-score-v9:1",
            transition_kind: "methodology-boundary-baseline",
            grade: "A",
            score: 84,
            prev_grade: null,
            prev_score: null,
          },
        ],
      },
    ]);

    const result = await snapshotSafetyGradeHistory(db);

    expect(result).toMatchObject({ status: "degraded", itemCount: 0 });
    expect(batchExecute).not.toHaveBeenCalled();
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      identityHistorySuppressed: true,
      suppressedIdentityTransitions: 1,
      identityBoundaryBaselines: 0,
    });
  });

  it("writes a healthy legacy identity boundary without reporting suppression", async () => {
    mockSnapshot([makeCard("usdt-tether", "B", 72)]);
    const db = mockD1([
      {
        match: "FROM safety_grade_history h",
        rows: [{ stablecoin_id: "usdt-tether", grade: "A", score: 84, recorded_at: 1_777_760_000 }],
      },
      { match: "FROM safety_score_history_v2", rows: [] },
    ]);

    const result = await snapshotSafetyGradeHistory(db);

    expect(result).toMatchObject({ itemCount: 1 });
    expect(result.status).toBeUndefined();
    expect(batchExecute).toHaveBeenCalledTimes(1);
    const statements = vi.mocked(batchExecute).mock.calls[0][1] as MockPreparedStatement[];
    expect(statements).toHaveLength(1);
    expect(statements[0].boundValues[11]).toBe("methodology-boundary-baseline");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      identityHistorySuppressed: false,
      suppressedIdentityTransitions: 0,
      suppressedTransitions: 0,
      identityBoundaryBaselines: 1,
    });
  });

  it("fails closed and reports suppression for a malformed V2 identity", async () => {
    mockSnapshot([makeCard("usdt-tether", "B", 72)]);
    const malformed = {
      ...makeV8HistoryRow("usdt-tether", "A", 84, 1_777_770_000),
      evaluation_build_digest: "not-a-digest",
    };
    const db = mockD1([
      { match: "FROM safety_grade_history h", rows: [] },
      { match: "FROM safety_score_history_v2", rows: [malformed] },
    ]);

    const result = await snapshotSafetyGradeHistory(db);

    expect(result).toMatchObject({ status: "degraded", itemCount: 0 });
    expect(batchExecute).not.toHaveBeenCalled();
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      identityHistorySuppressed: true,
      suppressedIdentityTransitions: 1,
      suppressedTransitions: 0,
      identityBoundaryBaselines: 0,
    });
  });

  it("keeps organic V8 transitions comparable across refreshed input and publication generations", async () => {
    mockSnapshot([makeCard("usdt-tether", "B", 72)]);
    const db = mockD1([
      { match: "FROM safety_grade_history h", rows: [{ stablecoin_id: "usdt-tether", grade: "A", score: 84, recorded_at: 1_777_760_000 }] },
      {
        match: "FROM safety_score_history_v2",
        rows: [
          {
            history_id: "v8-previous-publication",
            stablecoin_id: "usdt-tether",
            recorded_at: 1_777_770_000,
            model: "v8",
            identity_schema_version: 1,
            methodology_version: SAFETY_SCORE_METHODOLOGY_VERSION,
            policy_id: null,
            policy_digest: null,
            evaluation_build_digest: DIGEST,
            base_input_generation_id: `report-cards-input:v1:${"c".repeat(64)}`,
            model_publication_generation_id: "report-cards:8.17:1777680000",
            transition_kind: "organic-grade-change",
            grade: "A",
            score: 84,
            prev_grade: "A-",
            prev_score: 80,
          },
        ],
      },
    ]);

    const result = await snapshotSafetyGradeHistory(db);

    expect(result).toMatchObject({ itemCount: 1 });
    expect(batchExecute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(batchExecute).mock.calls[0][1]).toHaveLength(2);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      changed: 1,
      identityHistorySuppressed: false,
      suppressedIdentityTransitions: 0,
    });
  });
});
