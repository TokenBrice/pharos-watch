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

const {
  SAFETY_SCORE_V9_SHADOW_DAILY_START_OFFSET_SEC,
  runSafetyScoreV9ShadowAfterV8Publication,
  selectSafetyScoreV9ShadowArchiveReasons,
} = await import("../safety-score-v9-shadow-runner");
const { buildSafetyScoreV9ReplayArtifact, parseSafetyScoreV9ReplayArtifact } = await import("../safety-score-v9-store");
const { verifySafetyScoreV9ArchivedReplays } = await import("../../../scripts/check-safety-score-v9-shadow-gate");

const CLOCK_SEC = 2_000_000_000;
const SOURCE_GENERATION = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${CLOCK_SEC}`;
const UTC_DAY = new Date(CLOCK_SEC * 1_000).toISOString().slice(0, 10);

function exactFixedInput(clockSec = CLOCK_SEC) {
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds: ["usdc-circle"],
    capturedAt: new Date(clockSec * 1_000).toISOString(),
    sourceGeneration: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${clockSec}`,
    dexGenerationId: `dex-liquidity-${clockSec - 100}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "registry:fixture",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec,
    updatedAt: clockSec,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: clockSec - 100, ageSeconds: 100, stale: false },
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
        updatedAt: clockSec - 100,
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

  it("persists one exact-generation daily summary and archives its first distinct anomaly", async () => {
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
      "unresolved-release-blocker",
    ]);
    expect(mockPersistState).toHaveBeenCalledTimes(1);
    const persisted = mockPersistState.mock.calls[0]![1];
    expect(persisted.envelope.candidate.baseInputGenerationId).toBe(input().fixedInput.baseInputGenerationId);
    expect(persisted.diff.v8Identity.baseInputGenerationId).toBe(input().fixedInput.baseInputGenerationId);
    expect(persisted.diff.thresholds.downstream.map((threshold: { id: string }) => threshold.id)).toEqual(
      expect.arrayContaining([
        "depeg-resolver:mean-reversion-high",
        "depeg-resolver:mean-reversion-moderate",
        "selector:safety-recommendation",
        "yield:eligibility",
      ]),
    );
    expect(persisted.artifacts).toHaveLength(5);
    expect(persisted.envelope.replayArtifacts).toHaveLength(5);
    expect(persisted.daily).toMatchObject({
      utcDay: UTC_DAY,
      attemptCounts: { successful: 1, failed: 0 },
      selectedRun: {
        identity: { baseInputGenerationId: input().fixedInput.baseInputGenerationId },
        archiveSelectionReasons: ["anomaly"],
      },
    });
    expect(persisted.daily.selectedRun.artifactKeys).toHaveLength(5);
    await expect(
      verifySafetyScoreV9ArchivedReplays({ summaries: [persisted.daily], artifacts: persisted.artifacts }),
    ).resolves.toMatchObject({
      replays: [
        {
          utcDay: UTC_DAY,
          status: "passed",
          replayedResultDigest: persisted.daily.selectedRun.identity.resultDigest,
        },
      ],
    });

    const tamperedArtifacts = structuredClone(persisted.artifacts);
    tamperedArtifacts[0].payload = `!${tamperedArtifacts[0].payload.slice(1)}`;
    await expect(
      verifySafetyScoreV9ArchivedReplays({ summaries: [persisted.daily], artifacts: tamperedArtifacts }),
    ).resolves.toMatchObject({ replays: [{ status: "failed" }] });

    const resultArtifactIndex = persisted.artifacts.findIndex(
      (artifact: { kind: string }) => artifact.kind === "result",
    );
    const resultArtifact = persisted.artifacts[resultArtifactIndex];
    if (!resultArtifact) throw new Error("Expected retained result artifact");
    const parsedResult = await parseSafetyScoreV9ReplayArtifact<{
      schemaVersion: 2;
      evaluatedSet: unknown;
      candidate: { resultDigest: string };
      envelopeCore: {
        consumerThresholdRegistryDigest: string;
      };
    }>(resultArtifact);
    const semanticallyTamperedResult = await buildSafetyScoreV9ReplayArtifact({
      kind: "result",
      identity: parsedResult.value.candidate.resultDigest,
      value: {
        ...parsedResult.value,
        envelopeCore: {
          ...parsedResult.value.envelopeCore,
          consumerThresholdRegistryDigest: "f".repeat(64),
        },
      },
      createdAtSec: resultArtifact.createdAtSec,
      verifiedAtSec: resultArtifact.verifiedAtSec,
    });
    const semanticallyTamperedDaily = structuredClone(persisted.daily);
    semanticallyTamperedDaily.selectedRun.artifactKeys = semanticallyTamperedDaily.selectedRun.artifactKeys
      .map((key: string) => (key === resultArtifact.artifactKey ? semanticallyTamperedResult.artifactKey : key))
      .sort();
    const semanticallyTamperedArtifacts = structuredClone(persisted.artifacts);
    semanticallyTamperedArtifacts[resultArtifactIndex] = semanticallyTamperedResult;
    await expect(
      verifySafetyScoreV9ArchivedReplays({
        summaries: [semanticallyTamperedDaily],
        artifacts: semanticallyTamperedArtifacts,
      }),
    ).resolves.toMatchObject({ replays: [{ status: "failed" }] });
  });

  it("retains all exact replay inputs only for an explicitly selected anomaly", async () => {
    await runSafetyScoreV9ShadowAfterV8Publication({
      ...input(),
      archiveSelectionReasons: ["anomaly"],
    });

    const persisted = mockPersistState.mock.calls[0]![1];
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
        releaseCoveragePolicyDigest: persisted.envelope.releaseCoveragePolicyDigest,
        consumerThresholdRegistryDigest: persisted.envelope.consumerThresholdRegistryDigest,
        coverage: persisted.envelope.coverage,
      },
    });
    expect(persisted.daily.selectedRun.archiveSelectionReasons).toEqual(["anomaly"]);
    expect(persisted.daily.selectedRun.artifactKeys).toHaveLength(5);
  });

  it("bounds automatic first, final, and anomaly selections to window transitions", async () => {
    await runSafetyScoreV9ShadowAfterV8Publication(input());
    const anomalyDay = mockPersistState.mock.calls[0]![1].daily;
    const qualifyingDay = (utcDay: string) => ({
      ...structuredClone(anomalyDay),
      utcDay,
      selectedRun: {
        ...structuredClone(anomalyDay.selectedRun),
        selectedAtSec: Date.parse(`${utcDay}T00:15:00.000Z`) / 1_000,
        coverage: {
          ...structuredClone(anomalyDay.selectedRun.coverage),
          coverageFloors: anomalyDay.selectedRun.coverage.coverageFloors.map((floor: { status: "fail" | "pass" }) => ({
            ...floor,
            status: "pass" as const,
          })),
          unresolvedCriticalMovementIds: [],
        },
        movement: { ...structuredClone(anomalyDay.selectedRun.movement), pendingReviewCount: 0 },
        qualification: { qualifies: true, blockers: [] },
        archiveSelectionReasons: [],
        artifactKeys: [],
      },
    });
    const startDay = "2033-05-05";
    const first = qualifyingDay(startDay);
    expect(selectSafetyScoreV9ShadowArchiveReasons({ history: [], current: first })).toEqual(["first"]);
    const previousCandidate = qualifyingDay("2033-05-04");
    previousCandidate.selectedRun.identity.candidateId = "previous-release-candidate";
    expect(selectSafetyScoreV9ShadowArchiveReasons({ history: [previousCandidate], current: first })).toEqual([
      "first",
    ]);

    const history = Array.from({ length: 13 }, (_, index) => {
      const day = new Date(Date.parse(`${startDay}T00:00:00.000Z`) + index * 86_400_000).toISOString().slice(0, 10);
      return qualifyingDay(day);
    });
    const finalDay = qualifyingDay("2033-05-18");
    expect(selectSafetyScoreV9ShadowArchiveReasons({ history, current: finalDay })).toEqual(["final"]);
    expect(
      selectSafetyScoreV9ShadowArchiveReasons({
        history: [qualifyingDay("2033-05-17")],
        current: finalDay,
      }),
    ).toEqual([]);

    const nextAnomaly = {
      ...structuredClone(anomalyDay),
      utcDay: "2033-05-19",
      selectedRun: {
        ...structuredClone(anomalyDay.selectedRun),
        selectedAtSec: Date.parse("2033-05-19T00:15:00.000Z") / 1_000,
      },
    };
    const previousAnomaly = {
      ...structuredClone(anomalyDay),
      utcDay: "2033-05-18",
      selectedRun: {
        ...structuredClone(anomalyDay.selectedRun),
        selectedAtSec: Date.parse("2033-05-18T00:15:00.000Z") / 1_000,
      },
    };
    expect(selectSafetyScoreV9ShadowArchiveReasons({ history: [], current: nextAnomaly })).toEqual(["anomaly"]);
    expect(selectSafetyScoreV9ShadowArchiveReasons({ history: [previousAnomaly], current: nextAnomaly })).toEqual([]);
    previousAnomaly.selectedRun.identity.candidateId = "previous-anomaly-candidate";
    expect(selectSafetyScoreV9ShadowArchiveReasons({ history: [previousAnomaly], current: nextAnomaly })).toEqual([
      "anomaly",
    ]);
  });

  it("skips later calls only after the UTC day has a selected success", async () => {
    await runSafetyScoreV9ShadowAfterV8Publication(input());
    const persistedDay = mockPersistState.mock.calls[0]![1].daily;
    mockLoadHistory.mockResolvedValue([persistedDay]);
    mockPersistState.mockClear();

    const result = await runSafetyScoreV9ShadowAfterV8Publication(input());

    expect(result).toEqual({
      status: "skipped",
      attemptId: `safety-score-v9-shadow:${UTC_DAY}:2`,
      utcDay: UTC_DAY,
      reason: "successful-run-already-selected",
      qualifying: false,
    });
    expect(mockPersistState).not.toHaveBeenCalled();
  });

  it("waits until the post-producer daily selection point without recording an attempt", async () => {
    const dayStartSec = Math.floor(CLOCK_SEC / 86_400) * 86_400;
    const earlyClockSec = dayStartSec + 15 * 60;
    const result = await runSafetyScoreV9ShadowAfterV8Publication({
      ...input(),
      fixedInput: exactFixedInput(earlyClockSec),
      nowSec: earlyClockSec + 10,
    });

    expect(result).toEqual({
      status: "skipped",
      attemptId: `safety-score-v9-shadow:${UTC_DAY}:1`,
      utcDay: UTC_DAY,
      reason: "waiting-for-score-bearing-producers",
      scheduledForSec: dayStartSec + SAFETY_SCORE_V9_SHADOW_DAILY_START_OFFSET_SEC,
    });
    expect(mockPersistState).not.toHaveBeenCalled();
    expect(mockLoadReviewDispositions).not.toHaveBeenCalled();
  });

  it("retries a failed run on the same UTC day and increments compact counters", async () => {
    mockLoadReviewDispositions.mockRejectedValueOnce(new Error("review store unavailable"));
    await expect(runSafetyScoreV9ShadowAfterV8Publication(input())).resolves.toMatchObject({ status: "failed" });
    const failedDaily = mockPersistState.mock.calls[0]![1].daily;
    expect(failedDaily.attemptCounts).toEqual({ successful: 0, failed: 1 });

    mockLoadHistory.mockResolvedValue([failedDaily]);
    mockLoadReviewDispositions.mockResolvedValue({});
    mockPersistState.mockClear();
    const result = await runSafetyScoreV9ShadowAfterV8Publication(input());

    expect(result).toMatchObject({ status: "published", attemptId: `safety-score-v9-shadow:${UTC_DAY}:2` });
    expect(mockPersistState.mock.calls[0]![1].daily.attemptCounts).toEqual({ successful: 1, failed: 1 });
  });

  it("loads durable semantic reviews before sealing unresolved movement coverage", async () => {
    mockLoadReviewDispositions.mockImplementation((_db: D1Database, reviewKeys: readonly string[]) =>
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
      mockLoadReviewDispositions.mockImplementation((_db: D1Database, reviewKeys: readonly string[]) =>
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
