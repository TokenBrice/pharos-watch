import { createReportCardRawInputs } from "@shared/lib/report-card-raw-inputs";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import type { ReportCard } from "@shared/types/report-cards";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReportCardsFixedInput } from "../report-cards-fixed-input";
import {
  buildSafetyScoreV9PegProvenanceSummary,
  projectSafetyScoreV9PegSummary,
} from "../safety-score-v9-peg-provenance";

const { mockAssessPublication } = vi.hoisted(() => ({
  mockAssessPublication: vi.fn(),
}));
const mockLoadDaily = vi.fn();
const mockLoadEnvelope = vi.fn();
const mockLoadPublicationHealth = vi.fn();
const mockPersistState = vi.fn();
const mockLoadReviewDispositions = vi.fn();
const mockLoadReviewCarries = vi.fn();

vi.mock("../safety-score-v9-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../safety-score-v9-store")>();
  return {
    ...actual,
    loadLatestSafetyScoreV9ShadowEnvelope: mockLoadEnvelope,
    loadSafetyScoreV9PublicationHealth: mockLoadPublicationHealth,
    loadSafetyScoreV9ShadowDaily: mockLoadDaily,
    persistSafetyScoreV9ShadowState: mockPersistState,
  };
});

vi.mock("../safety-score-v9-movement-reviews", () => ({
  loadSafetyScoreV9MovementReviewDispositions: mockLoadReviewDispositions,
  loadSafetyScoreV9MovementReviewCarries: mockLoadReviewCarries,
}));

vi.mock("../safety-score-v9-publication-assessment", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../safety-score-v9-publication-assessment")
  >();
  return {
    ...actual,
    assessV9Publication: mockAssessPublication,
  };
});

const {
  SAFETY_SCORE_V9_SHADOW_DAILY_START_OFFSET_SEC,
  SAFETY_SCORE_V9_SHADOW_REFRESH_INTERVAL_SEC,
  runSafetyScoreV9ShadowAfterV8Publication,
} = await import("../safety-score-v9-shadow-runner");

const CLOCK_SEC = 2_000_000_000;
const TRACKING_START_SEC = CLOCK_SEC - 365 * 86_400;
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
    v9PublicationInputHealth: {
      dex: {
        state: "current",
        generationId: `dex-liquidity-${clockSec - 100}`,
        updatedAtSec: clockSec - 100,
      },
      redemption: {
        state: "not-applicable",
        generationId: null,
        updatedAtSec: null,
      },
      liveReserves: { state: "available" },
    },
    pegDataById: {
      "usdc-circle": {
        id: "usdc-circle",
        symbol: "USDC",
        name: "USD Coin",
        pegType: "peggedUSD",
        pegCurrency: "USD",
        governance: "centralized",
        currentDeviationBps: 0,
        pegScore: 100,
        pegPct: 100,
        severityScore: 100,
        spreadPenalty: 0,
        eventCount: 0,
        worstDeviationBps: null,
        activeDepeg: false,
        lastEventAt: null,
        trackingSpanDays: 365,
        historyCoverage: {
          startedAt: TRACKING_START_SEC,
          source: "first-observation",
          status: "verified",
        },
        methodologyVersion: "peg-score:fixture-v1",
      },
    },
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
      generationId: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${clockSec}`,
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
    mockLoadEnvelope.mockReset();
    mockLoadPublicationHealth.mockReset();
    mockPersistState.mockReset();
    mockLoadReviewDispositions.mockReset();
    mockLoadReviewCarries.mockReset();
    mockAssessPublication.mockReset();
    mockLoadDaily.mockResolvedValue(null);
    mockLoadEnvelope.mockResolvedValue(null);
    mockLoadPublicationHealth.mockResolvedValue(null);
    mockPersistState.mockResolvedValue(undefined);
    mockLoadReviewDispositions.mockResolvedValue({});
    mockLoadReviewCarries.mockResolvedValue({});
    mockAssessPublication.mockImplementation(({ inputHealth }) =>
      inputHealth.dex.state === "stale"
        ? { decision: "hold", reasons: [{ code: "dex-stale" }] }
        : { decision: "accept", reasons: [] },
    );
  });

  it("uses the 30-minute calibration refresh cadence", () => {
    expect(SAFETY_SCORE_V9_SHADOW_REFRESH_INTERVAL_SEC).toBe(30 * 60);
  });

  it("persists one current canonical observation without release artifacts", async () => {
    const result = await runSafetyScoreV9ShadowAfterV8Publication(input());

    expect(result).toMatchObject({ status: "published", utcDay: UTC_DAY });
    expect(mockPersistState).toHaveBeenCalledTimes(1);
    const persisted = mockPersistState.mock.calls[0]![1];
    expect(Object.keys(persisted).sort()).toEqual([
      "daily",
      "diff",
      "envelope",
      "exactInput",
      "publicationClockSec",
      "publicationHealth",
      "signal",
    ]);
    expect(persisted.exactInput.key).toBe(
      "report-cards:v9-fixed-input:exact",
    );
    expect(persisted.publicationHealth).toMatchObject({
      status: "current",
      attemptedAtSec: CLOCK_SEC,
    });
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

  it("holds stale DEX input without writing canonical state or exact input, then recovers", async () => {
    const heldInput = input();
    heldInput.fixedInput = {
      ...heldInput.fixedInput,
      v9PublicationInputHealth: {
        ...heldInput.fixedInput.v9PublicationInputHealth,
        dex: {
          ...heldInput.fixedInput.v9PublicationInputHealth.dex,
          state: "stale",
        },
      },
    };

    const held = await runSafetyScoreV9ShadowAfterV8Publication(heldInput);
    expect(held).toMatchObject({
      status: "held",
      utcDay: UTC_DAY,
      reasons: [{ code: "dex-stale" }],
    });
    const persistedHold = mockPersistState.mock.calls[0]![1];
    expect(Object.keys(persistedHold).sort()).toEqual([
      "daily",
      "publicationClockSec",
      "publicationHealth",
      "signal",
    ]);
    expect(persistedHold.daily).toMatchObject({
      attemptCounts: { successful: 0, failed: 1 },
      latestError: { stage: "publication-gate" },
    });
    expect(persistedHold.publicationHealth).toMatchObject({
      status: "held",
      heldSinceSec: CLOCK_SEC,
      attemptedAtSec: CLOCK_SEC,
    });

    mockLoadDaily.mockResolvedValue(persistedHold.daily);
    mockLoadPublicationHealth.mockResolvedValue(
      persistedHold.publicationHealth,
    );
    mockPersistState.mockClear();
    const recovery = await runSafetyScoreV9ShadowAfterV8Publication(
      input(CLOCK_SEC + SAFETY_SCORE_V9_SHADOW_REFRESH_INTERVAL_SEC),
    );
    expect(recovery).toMatchObject({ status: "published" });
    expect(mockPersistState.mock.calls[0]![1].publicationHealth).toMatchObject({
      status: "current",
      heldSinceSec: null,
      reasons: [],
    });

    const recoveredState = mockPersistState.mock.calls[0]![1];
    mockLoadDaily.mockResolvedValue(recoveredState.daily);
    mockLoadPublicationHealth.mockResolvedValue(
      recoveredState.publicationHealth,
    );
    mockPersistState.mockClear();
    const laterClock =
      CLOCK_SEC + 2 * SAFETY_SCORE_V9_SHADOW_REFRESH_INTERVAL_SEC;
    const laterFailureInput = input(laterClock);
    laterFailureInput.fixedInput = {
      ...laterFailureInput.fixedInput,
      v9PublicationInputHealth: {
        ...laterFailureInput.fixedInput.v9PublicationInputHealth,
        dex: {
          ...laterFailureInput.fixedInput.v9PublicationInputHealth.dex,
          state: "stale",
        },
      },
    };

    await expect(
      runSafetyScoreV9ShadowAfterV8Publication(laterFailureInput),
    ).resolves.toMatchObject({
      status: "held",
      reasons: [{ code: "dex-stale" }],
    });
    expect(mockPersistState.mock.calls[0]![1].publicationHealth).toMatchObject({
      status: "held",
      heldSinceSec: laterClock,
      attemptedAtSec: laterClock,
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

  it("rejects authoritative V8 changes during V9-only preparation", async () => {
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

  it("accepts score-neutral peg provenance without changing candidate bytes", async () => {
    await runSafetyScoreV9ShadowAfterV8Publication(input());
    const baseCandidate = mockPersistState.mock.calls[0]![1].envelope.candidate;
    mockPersistState.mockClear();

    const result = await runSafetyScoreV9ShadowAfterV8Publication({
      ...input(),
      prepareFixedInput: async (fixedInput) => ({
        ...fixedInput,
        pegProvenanceById: {
          "usdc-circle": buildSafetyScoreV9PegProvenanceSummary({
            assetId: "usdc-circle",
            events: [],
            trackingStartSec: TRACKING_START_SEC,
            clockSec: fixedInput.clockSec,
            expectedLegacyInclusive: projectSafetyScoreV9PegSummary(
              fixedInput.pegDataById["usdc-circle"]!,
            ),
          }),
        },
      }),
    });

    expect(result).toMatchObject({ status: "published" });
    const diagnosticCandidate = mockPersistState.mock.calls[0]![1].envelope.candidate;
    expect(JSON.stringify(diagnosticCandidate)).toBe(JSON.stringify(baseCandidate));
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

  it("replaces the same-day canonical observation after two caller slots despite scheduler jitter", async () => {
    const dayStartSec = Math.floor(CLOCK_SEC / 86_400) * 86_400;
    const firstClockSec = dayStartSec + SAFETY_SCORE_V9_SHADOW_DAILY_START_OFFSET_SEC + 300;
    await runSafetyScoreV9ShadowAfterV8Publication(input(firstClockSec));
    const first = mockPersistState.mock.calls[0]![1];

    const refreshClockSec = firstClockSec + SAFETY_SCORE_V9_SHADOW_REFRESH_INTERVAL_SEC;
    mockLoadDaily.mockResolvedValue(first.daily);
    mockPersistState.mockClear();
    const refreshInput = input(refreshClockSec);
    refreshInput.nowSec = refreshClockSec + 1;
    const result = await runSafetyScoreV9ShadowAfterV8Publication(refreshInput);

    expect(result).toMatchObject({ status: "published" });
    const refreshed = mockPersistState.mock.calls[0]![1];
    expect(refreshed.daily.attemptCounts).toEqual({ successful: 2, failed: 0 });
    expect(refreshed.daily.selectedRun.selectedAtSec).toBe(refreshClockSec + 1);
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
