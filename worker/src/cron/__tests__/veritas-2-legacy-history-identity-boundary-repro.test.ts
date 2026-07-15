import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import type { ReportCard, ReportCardGrade } from "@shared/types/report-cards";
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
    batchExecute: vi.fn(async (_db: D1Database, statements: D1PreparedStatement[]) => statements.length),
  };
});

import { snapshotSafetyGradeHistory } from "../snapshot-safety-grade-history";
import { batchExecute } from "../../lib/db";
import { loadActiveV8SafetyScoreHistorySource } from "../../lib/safety-score-history-v2";

const CURRENT_BUILD_DIGEST = "a".repeat(64);
const CURRENT_BASE_INPUT_GENERATION = `report-cards-input:v1:${"b".repeat(64)}`;
const CURRENT_PUBLICATION_GENERATION = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:1777770000`;

function reportCard(id: string, grade: ReportCardGrade, score: number): ReportCard {
  const dimension = { grade, score, detail: "fixture" };
  return {
    id,
    name: "Identity Boundary Coin",
    symbol: "IBC",
    overallGrade: grade,
    overallScore: score,
    baseScore: null,
    dimensions: {
      pegStability: dimension,
      liquidity: dimension,
      resilience: dimension,
      decentralization: dimension,
      dependencyRisk: dimension,
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
    isDefunct: false,
  };
}

function mockCurrentSnapshot(): void {
  vi.mocked(loadActiveV8SafetyScoreHistorySource).mockResolvedValue({
    snapshot: {
      cards: [reportCard("usdt-tether", "B", 72)],
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
          d: { thresholdBps: 1_000, score: 49 },
          f: { thresholdBps: 2_500, score: 39 },
        },
        thresholds: [],
      },
      dependencyGraph: { edges: [] },
      updatedAt: 1_777_770_000,
      liquidityStale: false,
      redemptionStale: false,
      inputFreshness: {
        dexLiquidity: { updatedAt: 1_777_770_000, ageSeconds: 0, stale: false },
        redemptionBackstops: { updatedAt: 1_777_770_000, ageSeconds: 0, stale: false },
      },
    },
    identity: {
      model: "v8",
      schemaVersion: 1,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      evaluationBuildDigest: CURRENT_BUILD_DIGEST,
      baseInputGenerationId: CURRENT_BASE_INPUT_GENERATION,
      publicationGenerationId: CURRENT_PUBLICATION_GENERATION,
    },
    publishedAtSec: 1_777_770_000,
  });
}

describe("VERITAS-II finding: legacy-only history crosses an unverified identity boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-05T12:34:56Z"));
    vi.mocked(batchExecute)
      .mockReset()
      .mockImplementation(async (_db, statements) => statements.length);
    vi.mocked(loadActiveV8SafetyScoreHistorySource).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("suppresses or baselines an 8.16 predecessor instead of writing an 8.17 organic change", async () => {
    mockCurrentSnapshot();
    const db = mockD1([
      {
        match: "FROM safety_grade_history h",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            grade: "A",
            score: 84,
            recorded_at: 1_777_680_000,
            methodology_version: "8.16",
          },
        ],
      },
      { match: "FROM safety_score_history_v2", rows: [] },
    ]);

    const result = await snapshotSafetyGradeHistory(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as { suppressedIdentityTransitions?: number };
    const statements = vi.mocked(batchExecute).mock.calls[0]?.[1] ?? [];
    const transitions = statements
      .map((statement) => statement as MockPreparedStatement)
      .filter((statement) => statement.sql.includes("INSERT INTO safety_score_history_v2"))
      .map((statement) => statement.boundValues[11]);
    const boundaryWritten = transitions.some((transition) =>
      ["methodology-boundary-baseline", "rollback-baseline", "restoration-baseline"].includes(String(transition)),
    );

    expect(transitions).not.toContain("organic-grade-change");
    expect((metadata.suppressedIdentityTransitions ?? 0) > 0 || boundaryWritten).toBe(true);
  });
});
