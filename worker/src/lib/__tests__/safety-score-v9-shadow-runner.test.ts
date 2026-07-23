import { createReportCardRawInputs } from "@shared/lib/report-card-raw-inputs";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import type { ReportCard } from "@shared/types/report-cards";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReportCardsFixedInput } from "../report-cards-fixed-input";

const mockLoadDaily = vi.fn();
const mockPersistState = vi.fn();
const mockLoadReviewDispositions = vi.fn();
const mockLoadReviewCarries = vi.fn();

vi.mock("../safety-score-v9-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../safety-score-v9-store")>();
  return {
    ...actual,
    loadSafetyScoreV9ShadowDaily: mockLoadDaily,
    persistSafetyScoreV9ShadowState: mockPersistState,
  };
});

vi.mock("../safety-score-v9-movement-reviews", () => ({
  loadSafetyScoreV9MovementReviewDispositions: mockLoadReviewDispositions,
  loadSafetyScoreV9MovementReviewCarries: mockLoadReviewCarries,
}));

const {
  SAFETY_SCORE_V9_SHADOW_DAILY_START_OFFSET_SEC,
  SAFETY_SCORE_V9_SHADOW_REFRESH_INTERVAL_SEC,
  runSafetyScoreV9ShadowAfterV8Publication,
} = await import("../safety-score-v9-shadow-runner");

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

function input(clockSec = CLOCK_SEC) {
  return {
    db: {} as D1Database,
    fixedInput: exactFixedInput(clockSec),
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
    nowSec: clockSec + 10,
  };
}

describe("Safety Score V9 shadow runner", { timeout: 30_000 }, () => {
  beforeEach(() => {
    mockLoadDaily.mockReset();
    mockPersistState.mockReset();
    mockLoadReviewDispositions.mockReset();
    mockLoadReviewCarries.mockReset();
    mockLoadDaily.mockResolvedValue(null);
    mockPersistState.mockResolvedValue(undefined);
    mockLoadReviewDispositions.mockResolvedValue({});
    mockLoadReviewCarries.mockResolvedValue({});
  });

  it("uses the 30-minute calibration refresh cadence", () => {
    expect(SAFETY_SCORE_V9_SHADOW_REFRESH_INTERVAL_SEC).toBe(30 * 60);
  });

  it("persists one current canonical observation without release artifacts", async () => {
    const result = await runSafetyScoreV9ShadowAfterV8Publication(input());

    expect(result).toMatchObject({ status: "published", utcDay: UTC_DAY });
    expect(mockPersistState).toHaveBeenCalledTimes(1);
    const persisted = mockPersistState.mock.calls[0]![1];
    expect(Object.keys(persisted).sort()).toEqual(["daily", "diff", "envelope", "signal"]);
    expect(persisted.envelope.candidate.baseInputGenerationId).toBe(input().fixedInput.baseInputGenerationId);
    expect(persisted.envelope.replayArtifacts).toEqual([]);
    expect(persisted.envelope.coverage.unresolvedReleaseBlockers).toEqual([]);
    expect(
      persisted.envelope.coverage.coverageFloors.find(
        (floor: { id: string }) => floor.id === "ratified-release-coverage",
      ),
    ).toMatchObject({ status: "pass", required: "retired" });
    expect(
      persisted.envelope.coverage.coverageFloors.find(
        (floor: { id: string }) => floor.id === "scheduled-start-latency",
      ),
    ).toMatchObject({ status: "pass", required: "retired" });
    expect(persisted.daily).toMatchObject({
      utcDay: UTC_DAY,
      attemptCounts: { successful: 1, failed: 0 },
      selectedRun: { archiveSelectionReasons: [], artifactKeys: [] },
    });
  });

  it("skips until the bounded refresh interval elapses", async () => {
    const prepareFixedInput = vi.fn(async (fixedInput: unknown) => fixedInput);
    await runSafetyScoreV9ShadowAfterV8Publication({ ...input(), prepareFixedInput });
    mockLoadDaily.mockResolvedValue(mockPersistState.mock.calls[0]![1].daily);
    mockPersistState.mockClear();

    await expect(
      runSafetyScoreV9ShadowAfterV8Publication({ ...input(), prepareFixedInput }),
    ).resolves.toEqual({
      status: "skipped",
      attemptId: `safety-score-v9-shadow:${UTC_DAY}:2`,
      utcDay: UTC_DAY,
      reason: "refresh-interval-not-elapsed",
    });
    expect(prepareFixedInput).toHaveBeenCalledTimes(1);
    expect(mockPersistState).not.toHaveBeenCalled();
  });

  it("allows only V9 supply attribution to change during shadow preparation", async () => {
    const result = await runSafetyScoreV9ShadowAfterV8Publication({
      ...input(),
      prepareFixedInput: async (fixedInput) => ({
        ...fixedInput,
        capturedAt: "2026-07-24T00:00:00.000Z",
      }),
    });

    expect(result).toMatchObject({
      status: "failed",
      stage: "v9-enrichment",
      message: "Safety Score v9 preparation changed the authoritative V8 fixed input",
    });
  });

  it("waits until the post-producer daily observation point", async () => {
    const dayStartSec = Math.floor(CLOCK_SEC / 86_400) * 86_400;
    const earlyClockSec = dayStartSec + 15 * 60;

    await expect(runSafetyScoreV9ShadowAfterV8Publication(input(earlyClockSec))).resolves.toEqual({
      status: "skipped",
      attemptId: `safety-score-v9-shadow:${UTC_DAY}:1`,
      utcDay: UTC_DAY,
      reason: "waiting-for-score-bearing-producers",
      scheduledForSec: dayStartSec + SAFETY_SCORE_V9_SHADOW_DAILY_START_OFFSET_SEC,
    });
    expect(mockPersistState).not.toHaveBeenCalled();
  });

  it("replaces the same-day canonical observation after the refresh interval", async () => {
    const dayStartSec = Math.floor(CLOCK_SEC / 86_400) * 86_400;
    const firstClockSec = dayStartSec + SAFETY_SCORE_V9_SHADOW_DAILY_START_OFFSET_SEC + 300;
    await runSafetyScoreV9ShadowAfterV8Publication(input(firstClockSec));
    const first = mockPersistState.mock.calls[0]![1];

    const refreshClockSec = firstClockSec + SAFETY_SCORE_V9_SHADOW_REFRESH_INTERVAL_SEC + 60;
    mockLoadDaily.mockResolvedValue(first.daily);
    mockPersistState.mockClear();
    const result = await runSafetyScoreV9ShadowAfterV8Publication(input(refreshClockSec));

    expect(result).toMatchObject({ status: "published" });
    const refreshed = mockPersistState.mock.calls[0]![1];
    expect(refreshed.daily.attemptCounts).toEqual({ successful: 2, failed: 0 });
    expect(refreshed.daily.selectedRun.selectedAtSec).toBe(refreshClockSec + 10);
    expect(refreshed.daily.selectedRun.qualification).toEqual(first.daily.selectedRun.qualification);
    expect(refreshed.envelope).toBeDefined();
    expect(refreshed.diff).toBeDefined();
    expect(refreshed.envelope.candidate.publicationGenerationId).not.toBe(
      first.envelope.candidate.publicationGenerationId,
    );
  });

  it("retries a failed same-day observation and increments compact counters", async () => {
    mockLoadReviewDispositions.mockRejectedValueOnce(new Error("review store unavailable"));
    await expect(runSafetyScoreV9ShadowAfterV8Publication(input())).resolves.toMatchObject({ status: "failed" });
    const failedDaily = mockPersistState.mock.calls[0]![1].daily;
    expect(failedDaily.attemptCounts).toEqual({ successful: 0, failed: 1 });

    mockLoadDaily.mockResolvedValue(failedDaily);
    mockLoadReviewDispositions.mockResolvedValue({});
    mockPersistState.mockClear();
    await expect(runSafetyScoreV9ShadowAfterV8Publication(input())).resolves.toMatchObject({
      status: "published",
      attemptId: `safety-score-v9-shadow:${UTC_DAY}:2`,
    });
    expect(mockPersistState.mock.calls[0]![1].daily.attemptCounts).toEqual({ successful: 1, failed: 1 });
  });

  it.each(["producer-data-gap", "defect"] as const)(
    "keeps reviewed %s movement as advisory evidence",
    async (disposition) => {
      mockLoadReviewDispositions.mockImplementation((_db: D1Database, reviewKeys: readonly string[]) =>
        Promise.resolve(Object.fromEntries(reviewKeys.map((key) => [key, disposition]))),
      );

      await expect(runSafetyScoreV9ShadowAfterV8Publication(input())).resolves.toMatchObject({
        status: "published",
        pendingReviewCount: 0,
      });
      const persisted = mockPersistState.mock.calls[0]![1];
      expect(persisted.envelope.coverage.unresolvedCriticalMovementIds).toEqual(["usdc-circle"]);
      expect(persisted.daily.selectedRun.qualification.blockers).not.toContain("unresolved-critical-movement");
      expect(persisted.diff.cards[0]?.review).toMatchObject({ status: "classified", disposition });
    },
  );

  it("retains a carried movement disposition in the canonical diff", async () => {
    await runSafetyScoreV9ShadowAfterV8Publication(input());
    const initialCard = mockPersistState.mock.calls[0]![1].diff.cards[0]!;
    expect(initialCard.review.status).toBe("pending");
    expect(initialCard.review.classKey).not.toBeNull();

    const carriedReviewKey = "9".repeat(64);
    mockPersistState.mockClear();
    mockLoadReviewCarries.mockImplementation((_db: D1Database, classKeys: readonly string[]) =>
      Promise.resolve(
        Object.fromEntries(
          classKeys.map((classKey) => [
            classKey,
            {
              reviewKey: carriedReviewKey,
              disposition: "intended-methodology-change",
              reviewedV8Score: initialCard.v8?.score ?? null,
              reviewedV9Score: initialCard.v9?.score ?? null,
            },
          ]),
        ),
      ),
    );

    await expect(runSafetyScoreV9ShadowAfterV8Publication(input())).resolves.toMatchObject({
      status: "published",
      pendingReviewCount: 0,
    });
    const persisted = mockPersistState.mock.calls[0]![1];
    expect(persisted.envelope.coverage.unresolvedCriticalMovementIds).toEqual([]);
    expect(persisted.diff.cards[0]?.review).toMatchObject({
      status: "classified",
      disposition: "intended-methodology-change",
      carriedFrom: { reviewKey: carriedReviewKey },
    });
  });

  it("returns a shadow-write failure without unwinding V8 publication", async () => {
    mockPersistState.mockRejectedValue(new Error("D1 unavailable"));

    await expect(runSafetyScoreV9ShadowAfterV8Publication(input())).resolves.toMatchObject({
      status: "failed",
      stage: "shadow-write",
      message: "D1 unavailable",
    });
    expect(mockPersistState).toHaveBeenCalledTimes(2);
  });
});
