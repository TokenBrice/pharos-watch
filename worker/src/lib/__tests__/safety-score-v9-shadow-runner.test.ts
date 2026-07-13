import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { createReportCardRawInputs } from "@shared/lib/report-card-raw-inputs";
import type { ReportCard } from "@shared/types/report-cards";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReportCardsFixedInput } from "../report-cards-fixed-input";

const mockLoadHistory = vi.fn();
const mockPersistState = vi.fn();
const mockLoadReviewDispositions = vi.fn();

vi.mock("../safety-score-v9-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../safety-score-v9-store")>();
  return {
    ...actual,
    loadSafetyScoreV9ShadowHistory: mockLoadHistory,
    persistSafetyScoreV9ShadowState: mockPersistState,
  };
});

vi.mock("../safety-score-v9-movement-reviews", () => ({
  loadSafetyScoreV9MovementReviewDispositions: mockLoadReviewDispositions,
}));

const { runSafetyScoreV9ShadowAfterV8Publication } = await import("../safety-score-v9-shadow-runner");
const { parseSafetyScoreV9ReplayArtifact } = await import("../safety-score-v9-store");

const CLOCK_SEC = 2_000_000_000;
const SOURCE_GENERATION = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${CLOCK_SEC}`;
const UTC_DAY = new Date(CLOCK_SEC * 1_000).toISOString().slice(0, 10);

function exactFixedInput() {
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds: ["usdc-circle"],
    capturedAt: new Date(CLOCK_SEC * 1_000).toISOString(),
    sourceGeneration: SOURCE_GENERATION,
    dexGenerationId: `dex-liquidity-${CLOCK_SEC - 100}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "registry:fixture",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: CLOCK_SEC,
    updatedAt: CLOCK_SEC,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: CLOCK_SEC - 100, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    dexLiqMap: {
      "usdc-circle": {
        liquidityScore: 90,
        concentrationHhi: 0.5,
        poolCount: 1,
        chainCount: 1,
        coverageClass: "primary",
        coverageConfidence: 1,
        liquidityEvidenceClass: "measured",
        hasMeasuredLiquidityEvidence: true,
        effectiveTvlUsd: 1_000_000,
        balanceMeasuredTvlUsd: 1_000_000,
        organicMeasuredTvlUsd: 1_000_000,
        methodologyVersion: "dex:fixture-v1",
        updatedAt: CLOCK_SEC - 100,
      },
    },
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: { "usdc-circle": false },
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {
      "usdc-circle": {
        ethereum: {
          current: 10_000_000,
          circulatingPrevDay: 10_000_000,
          circulatingPrevWeek: 10_000_000,
          circulatingPrevMonth: 10_000_000,
        },
      },
    },
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

function v8Card(): ReportCard {
  const dimension = { grade: "A" as const, score: 90, detail: "fixture" };
  return {
    id: "usdc-circle",
    name: "USD Coin",
    symbol: "USDC",
    overallGrade: "A",
    overallScore: 90,
    baseScore: 90,
    overallCapped: false,
    dimensions: {
      pegStability: dimension,
      liquidity: dimension,
      resilience: dimension,
      decentralization: dimension,
      dependencyRisk: dimension,
    },
    ratedDimensions: 5,
    rawInputs: createReportCardRawInputs({ canBeBlacklisted: true }),
    isDefunct: false,
  };
}

function input() {
  return {
    db: {} as D1Database,
    fixedInput: exactFixedInput(),
    v8Cards: [v8Card()],
    v8Publication: {
      generationId: SOURCE_GENERATION,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      expectedCount: 1,
      scoredCount: 1,
      notRatedCount: 0,
      notRatedIds: [],
    },
    v8MethodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    nowSec: CLOCK_SEC + 10,
  };
}

describe("Safety Score V9 shadow runner", () => {
  beforeEach(() => {
    mockLoadHistory.mockReset();
    mockPersistState.mockReset();
    mockLoadReviewDispositions.mockReset();
    mockLoadHistory.mockResolvedValue([]);
    mockPersistState.mockResolvedValue(undefined);
    mockLoadReviewDispositions.mockResolvedValue({});
  });

  it("retains one exact-generation candidate with only locally verifiable daily floors", async () => {
    const result = await runSafetyScoreV9ShadowAfterV8Publication(input());

    expect(result).toMatchObject({
      status: "published",
      utcDay: UTC_DAY,
      qualifying: false,
    });
    if (result.status !== "published") throw new Error("Expected published shadow result");
    expect(result.qualificationBlockers).toEqual([
      "coverage-floor-failed",
      "unresolved-critical-movement",
    ]);
    expect(mockPersistState).toHaveBeenCalledTimes(1);
    const persisted = mockPersistState.mock.calls[0]![1];
    expect(persisted.envelope.candidate.baseInputGenerationId).toBe(input().fixedInput.baseInputGenerationId);
    expect(persisted.diff.v8Identity.baseInputGenerationId).toBe(input().fixedInput.baseInputGenerationId);
    expect(persisted.artifacts.map((artifact: { kind: string }) => artifact.kind)).toEqual([
      "base-input",
      "fact-set",
      "policy",
      "evaluation-build",
      "result",
    ]);
    const resultArtifact = persisted.artifacts.find((artifact: { kind: string }) => artifact.kind === "result");
    const retainedResult = await parseSafetyScoreV9ReplayArtifact<{
      schemaVersion: number;
      envelopeCore: unknown;
    }>(resultArtifact);
    expect(retainedResult.value).toMatchObject({
      schemaVersion: 2,
      envelopeCore: {
        compilerFactSchemaDigest: persisted.envelope.compilerFactSchemaDigest,
        producerCapabilityDigest: persisted.envelope.producerCapabilityDigest,
        coverage: persisted.envelope.coverage,
      },
    });
    expect(persisted.day.projection.expectedScheduledAttemptIds).toEqual([
      `safety-score-v9-shadow:scheduled:${UTC_DAY}`,
    ]);
  });

  it("does not create another scheduled attempt after the UTC day is recorded", async () => {
    await runSafetyScoreV9ShadowAfterV8Publication(input());
    const persistedDay = mockPersistState.mock.calls[0]![1].day;
    mockLoadHistory.mockResolvedValue([persistedDay]);
    mockPersistState.mockClear();

    const result = await runSafetyScoreV9ShadowAfterV8Publication(input());

    expect(result).toEqual({
      status: "skipped",
      attemptId: `safety-score-v9-shadow:scheduled:${UTC_DAY}`,
      utcDay: UTC_DAY,
      reason: "attempt-already-recorded",
      qualifying: false,
    });
    expect(mockPersistState).not.toHaveBeenCalled();
  });

  it("loads durable semantic reviews before sealing unresolved movement coverage", async () => {
    mockLoadReviewDispositions.mockImplementation(
      (_db: D1Database, reviewKeys: readonly string[]) =>
        Promise.resolve(Object.fromEntries(reviewKeys.map((key) => [key, "intended-methodology-change"]))),
    );

    const result = await runSafetyScoreV9ShadowAfterV8Publication(input());

    expect(result).toMatchObject({ status: "published", pendingReviewCount: 0 });
    if (result.status !== "published") throw new Error("Expected published shadow result");
    expect(result.qualificationBlockers).not.toContain("unresolved-critical-movement");
    expect(mockLoadReviewDispositions).toHaveBeenCalledTimes(1);
    const persisted = mockPersistState.mock.calls[0]![1];
    expect(persisted.diff.cards[0]?.review).toMatchObject({
      status: "classified",
      disposition: "intended-methodology-change",
    });
  });

  it.each(["producer-data-gap", "defect"] as const)(
    "keeps a reviewed %s movement release-blocking",
    async (disposition) => {
      mockLoadReviewDispositions.mockImplementation(
        (_db: D1Database, reviewKeys: readonly string[]) =>
          Promise.resolve(Object.fromEntries(reviewKeys.map((key) => [key, disposition]))),
      );

      const result = await runSafetyScoreV9ShadowAfterV8Publication(input());

      expect(result).toMatchObject({ status: "published", pendingReviewCount: 0 });
      if (result.status !== "published") throw new Error("Expected published shadow result");
      expect(result.qualificationBlockers).toContain("unresolved-critical-movement");
      const persisted = mockPersistState.mock.calls[0]![1];
      expect(persisted.envelope.coverage.unresolvedCriticalMovementIds).toEqual(["usdc-circle"]);
      expect(persisted.diff.cards[0]?.review).toMatchObject({ status: "classified", disposition });
    },
  );

  it("retains an explicit sealed release-candidate ID for a future counted window", async () => {
    const result = await runSafetyScoreV9ShadowAfterV8Publication({
      ...input(),
      releaseCandidateId: "v9-rc-3",
    });

    expect(result).toMatchObject({ status: "published", candidateId: "v9-rc-3" });
    expect(mockPersistState.mock.calls[0]![1].envelope.candidate.candidateId).toBe("v9-rc-3");
  });

  it("returns a shadow-write failure without throwing when D1 retention fails", async () => {
    mockPersistState.mockRejectedValue(new Error("D1 unavailable"));

    await expect(runSafetyScoreV9ShadowAfterV8Publication(input())).resolves.toMatchObject({
      status: "failed",
      stage: "shadow-write",
      message: "D1 unavailable",
    });
    expect(mockPersistState).toHaveBeenCalledTimes(2);
  });
});
