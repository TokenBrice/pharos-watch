import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportCard, ReportCardGrade } from "@shared/types/report-cards";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

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

import { snapshotSafetyGradeHistory } from "../snapshot-safety-grade-history";
import { batchExecute } from "../../lib/db";
import { loadActiveV8SafetyScoreHistorySource } from "../../lib/safety-score-history-v2";

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
      policyId: null,
      policyDigest: null,
      evaluationBuildDigest: DIGEST,
      baseInputGenerationId: BASE_INPUT_GENERATION_ID,
      modelPublicationGenerationId: MODEL_PUBLICATION_GENERATION_ID,
      publicationEpoch: 0,
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
});
