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
const { getSafetyScoreV9LocalArtifactBundleArtifacts, parseSafetyScoreV9ReplayArtifact } =
  await import("../safety-score-v9-store");

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

const V9_EVALUATION_TEST_TIMEOUT_MS = 30_000;

describe("Safety Score V9 shadow runner", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    mockLoadHistory.mockReset();
    mockPersistState.mockReset();
    mockLoadReviewDispositions.mockReset();
    mockLoadHistory.mockResolvedValue([]);
    mockPersistState.mockResolvedValue(undefined);
    mockLoadReviewDispositions.mockResolvedValue({});
  });

  it("persists one exact-generation daily summary without routine replay artifacts", async () => {
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
    expect(persisted.artifacts).toHaveLength(0);
    expect(persisted.localArtifactBundle).toBeUndefined();
    expect(persisted.envelope.replayArtifacts).toHaveLength(0);
    expect(persisted.daily).toMatchObject({
      utcDay: UTC_DAY,
      attemptCounts: { successful: 1, failed: 0 },
      selectedRun: {
        identity: { baseInputGenerationId: input().fixedInput.baseInputGenerationId },
        archiveSelectionReasons: [],
      },
    });
    expect(persisted.daily.selectedRun.artifactKeys).toHaveLength(0);
  });

  it("retains all exact replay inputs only for an explicitly selected anomaly", async () => {
    await runSafetyScoreV9ShadowAfterV8Publication({
      ...input(),
      archiveSelectionReasons: ["anomaly"],
    });

    const persisted = mockPersistState.mock.calls[0]![1];
    expect(persisted.artifacts).toBeUndefined();
    const artifacts = getSafetyScoreV9LocalArtifactBundleArtifacts(persisted.localArtifactBundle);
    expect(artifacts.map((artifact) => artifact.kind)).toEqual([
      "base-input",
      "fact-set",
      "policy",
      "evaluation-build",
      "result",
    ]);
    const resultArtifact = artifacts.find((artifact) => artifact.kind === "result");
    if (!resultArtifact) throw new Error("Expected a retained result artifact");
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

  it("bounds automatic qualifying selections and requires explicit anomaly retention", async () => {
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

    const longHistory = Array.from({ length: 27 }, (_, index) => {
      const day = new Date(Date.parse(`${startDay}T00:00:00.000Z`) + index * 86_400_000).toISOString().slice(0, 10);
      const selected = qualifyingDay(day);
      if (day === "2033-05-18") selected.selectedRun.archiveSelectionReasons = ["final"];
      return selected;
    });
    expect(
      selectSafetyScoreV9ShadowArchiveReasons({
        history: longHistory,
        current: qualifyingDay("2033-06-01"),
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
    expect(selectSafetyScoreV9ShadowArchiveReasons({ history: [], current: nextAnomaly })).toEqual([]);
    expect(
      selectSafetyScoreV9ShadowArchiveReasons({
        history: [],
        current: nextAnomaly,
        requested: ["anomaly"],
      }),
    ).toEqual(["anomaly"]);
    expect(() =>
      selectSafetyScoreV9ShadowArchiveReasons({ history: [], current: first, requested: ["anomaly"] }),
    ).toThrow("must be selected from a non-qualifying run");
    expect(() =>
      selectSafetyScoreV9ShadowArchiveReasons({
        history,
        current: finalDay,
        requested: ["final"] as unknown as ["anomaly"],
      }),
    ).toThrow("may be selected explicitly");
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

  it("fires the day's first attempt inside the preregistered start window and pins it against refreshes", async () => {
    const dayStartSec = Math.floor(CLOCK_SEC / 86_400) * 86_400;
    const inWindowClockSec = dayStartSec + SAFETY_SCORE_V9_SHADOW_DAILY_START_OFFSET_SEC + 300;
    const first = await runSafetyScoreV9ShadowAfterV8Publication({
      ...input(),
      fixedInput: exactFixedInput(inWindowClockSec),
      nowSec: inWindowClockSec + 10,
    });

    expect(first).toMatchObject({ status: "published", utcDay: UTC_DAY });
    const firstPersisted = mockPersistState.mock.calls[0]![1];
    const latencyFloor = firstPersisted.envelope.coverage.coverageFloors.find(
      (floor: { id: string }) => floor.id === "scheduled-start-latency",
    );
    expect(latencyFloor).toMatchObject({ status: "pass", observed: 310 });
    const firstDaily = firstPersisted.daily;
    expect(firstDaily.selectedRun.selectedAtSec).toBe(inWindowClockSec + 10);

    // A later same-day refresh keeps the in-window selection and updates only
    // the daily metadata; the retained latest envelope/diff stay bound to the
    // pinned run.
    const refreshClockSec = inWindowClockSec + 3 * 3_600 + 60;
    mockLoadHistory.mockResolvedValue([firstDaily]);
    mockPersistState.mockClear();
    const refreshed = await runSafetyScoreV9ShadowAfterV8Publication({
      ...input(),
      fixedInput: exactFixedInput(refreshClockSec),
      nowSec: refreshClockSec + 10,
    });

    expect(refreshed).toMatchObject({ status: "published", archiveSelectionReasons: [] });
    if (refreshed.status !== "published") throw new Error("Expected published shadow result");
    expect(refreshed.qualifying).toBe(firstDaily.selectedRun.qualification.qualifies);
    expect(refreshed.qualificationBlockers).toEqual(firstDaily.selectedRun.qualification.blockers);
    expect(mockPersistState).toHaveBeenCalledTimes(1);
    const persistedRefresh = mockPersistState.mock.calls[0]![1];
    expect(persistedRefresh.envelope).toBeUndefined();
    expect(persistedRefresh.diff).toBeUndefined();
    expect(persistedRefresh.localArtifactBundle).toBeUndefined();
    expect(persistedRefresh.daily.selectedRun).toEqual(firstDaily.selectedRun);
    expect(persistedRefresh.daily.attemptCounts).toEqual({ successful: 2, failed: 0 });
    expect(persistedRefresh.daily.updatedAtSec).toBe(refreshClockSec + 10);

    // The refresh throttle measures from the latest success, not the pinned
    // selection: a call minutes after the pinned refresh still skips.
    const soonClockSec = refreshClockSec + 15 * 60;
    mockLoadHistory.mockResolvedValue([persistedRefresh.daily]);
    mockPersistState.mockClear();
    const skipped = await runSafetyScoreV9ShadowAfterV8Publication({
      ...input(),
      fixedInput: exactFixedInput(soonClockSec),
      nowSec: soonClockSec + 10,
    });

    expect(skipped).toMatchObject({ status: "skipped", reason: "successful-run-already-selected" });
    expect(mockPersistState).not.toHaveBeenCalled();
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
