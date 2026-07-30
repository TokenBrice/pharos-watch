import { describe, expect, it } from "vitest";
import type { DdrHorizon, DdrHorizonCell } from "../../../types/depeg-resolver";
import {
  DDRR_REVIEWER_VERSION,
  DdrrRowSchema,
  type DdrrActualEventInput,
  type DdrrAssessmentInput,
  type DdrrV2CoverageInput,
  type DdrrV2InvalidatedPredictionInput,
} from "../index";
import {
  buildDdrrCoverageRow,
  deriveActualOutcome,
  reviewDdrrV2Rows,
  reviewDepegResolverAssessment,
  summarizeDdrrRows,
} from "../index";

const STARTED_AT = 90_000;
const LOCKED_AT = STARTED_AT + 24 * 3_600;
const ELIGIBLE_AT = LOCKED_AT;
const PUBLISHED_AT = LOCKED_AT + 300;
const REVIEWED_AT = LOCKED_AT + 10_000;

function horizonCell(horizon: DdrHorizon, overrides: Partial<DdrHorizonCell> = {}): DdrHorizonCell {
  return {
    horizon,
    state: "benchmarked",
    probability: 0.5,
    probabilityDisplay: "45-55%",
    probabilityInterval: { lower: 0.45, upper: 0.55 },
    rawAtRisk: 30,
    uniqueCoins: 10,
    intervalClosures: 15,
    intervalNonClosures: 15,
    ...overrides,
  };
}

function assessment(overrides: Partial<DdrrAssessmentInput> = {}): DdrrAssessmentInput {
  return {
    eventId: 1,
    currentEventId: 1,
    incidentKey: "ddr2:fixture00000000000000000000000000",
    publicPredictionId: 101,
    assessmentId: 201,
    stablecoinId: "fixture-usd",
    symbol: "FXUSD",
    name: "Fixture USD",
    pegCurrency: "USD",
    governance: "decentralized",
    direction: "below",
    startedAt: STARTED_AT,
    eligibleAt: ELIGIBLE_AT,
    lockedAt: LOCKED_AT,
    publishedAt: PUBLISHED_AT,
    publicationSnapshotToken: "snap-1",
    assessedAt: LOCKED_AT,
    eventAgeSec: LOCKED_AT - STARTED_AT,
    checkpoint: "public_prediction",
    methodologyVersion: "2.0",
    predictionMethodologyVersion: "2.0",
    predictionPolicyVersion: "sticky-24h-v1",
    resolutionTier: "recovery_likely",
    durationSuppressed: false,
    durationSuppressedReason: null,
    predictedRemainingSec: 3_600,
    iqrRemainingSec: [1_800, 7_200],
    horizonCells: [horizonCell("6h"), horizonCell("24h"), horizonCell("7d"), horizonCell("30d")],
    stratum: "below - moderate - robust - USD",
    factors: [],
    ...overrides,
  };
}

function actualEvent(overrides: Partial<DdrrActualEventInput> = {}): DdrrActualEventInput {
  return {
    eventId: 1,
    currentEventId: 1,
    startedAt: STARTED_AT,
    endedAt: LOCKED_AT + 3_600,
    recoveryPrice: 1,
    stablecoinStatus: "active",
    terminalObserved: null,
    terminalEvidenceAt: null,
    terminalEvidenceInterval: null,
    terminalEvidencePrecision: null,
    ...overrides,
  };
}

function coverage(overrides: Partial<DdrrV2CoverageInput> = {}): DdrrV2CoverageInput {
  return {
    eventId: 500,
    currentEventId: 500,
    incidentKey: "ddr2:coverage0000000000000000000000000",
    stablecoinId: "coverage-usd",
    symbol: "COV",
    name: "Coverage USD",
    pegCurrency: "USD",
    governance: "centralized",
    direction: "below",
    startedAt: STARTED_AT,
    eligibleAt: ELIGIBLE_AT,
    sourceEventState: "recovered",
    predictionState: "resolved_before_prediction",
    actualEndedAt: ELIGIBLE_AT - 1,
    coverageCause: "pre_lock_recovered",
    operationalCoverageCause: null,
    outcomeQualityState: "classified",
    ...overrides,
  };
}

function invalidated(overrides: Partial<DdrrV2InvalidatedPredictionInput> = {}): DdrrV2InvalidatedPredictionInput {
  const erratum = {
    id: 1,
    state: "invalidated" as const,
    publicPredictionId: 901,
    incidentKey: "ddr2:invalid00000000000000000000000000",
    eventId: 900,
    assessmentId: 902,
    reason: "event_identity_error" as const,
    createdAt: REVIEWED_AT,
    operatorNote: "source event repaired",
    rowHashBefore: "old-hash",
    replacementAssessmentId: null,
    replacementRowHash: null,
    createdBy: "ddrr-test",
  };
  return {
    eventId: 900,
    currentEventId: 900,
    incidentKey: "ddr2:invalid00000000000000000000000000",
    stablecoinId: "invalid-usd",
    symbol: "INV",
    name: "Invalid USD",
    pegCurrency: "USD",
    governance: "decentralized",
    direction: "below",
    startedAt: STARTED_AT,
    eligibleAt: ELIGIBLE_AT,
    publicPredictionId: 901,
    assessmentId: 902,
    predictionMethodologyVersion: "2.0",
    predictionPolicyVersion: "sticky-24h-v1",
    lockedAt: LOCKED_AT,
    publishedAt: PUBLISHED_AT,
    publicationSnapshotToken: "snap-invalid",
    originalKind: "no_call",
    originalOutcome: {
      lockedAt: LOCKED_AT,
      eventAgeAtLockSec: LOCKED_AT - STARTED_AT,
      missingReasons: ["insufficient_signal"],
      relatedContext: {
        dewsBand: null,
        dewsScore: null,
        liquidityScore: null,
        safetyGrade: null,
        safetyScore: null,
        supplyChange7dPct: null,
        supplyChange30dPct: null,
        mintSurge: null,
      },
    },
    latestErratum: erratum,
    errataCount: 1,
    errataHistory: [erratum],
    ...overrides,
  };
}

describe("DDRR row contract", () => {
  it("bumps the public reviewer version and emits discriminated prediction rows", () => {
    const row = reviewDepegResolverAssessment(assessment(), actualEvent(), REVIEWED_AT);

    expect(DDRR_REVIEWER_VERSION).toBe("ddr-reviewer-v4");
    expect(row.kind).toBe("prediction_review");
    expect(row.predictionState).toBe("frozen");
    expect(row.lockedAt).toBe(LOCKED_AT);
    expect(row.actual.kind).toBe("recovered");
    expect(DdrrRowSchema.parse(row)).toEqual(row);
  });

  it("emits coverage and invalidated rows that satisfy the public schema", () => {
    const { rows } = reviewDdrrV2Rows({
      coverageRows: [coverage()],
      invalidatedPredictions: [invalidated()],
      nowSec: REVIEWED_AT,
    });

    expect(rows.map((row) => row.kind)).toEqual(["coverage", "invalidated_prediction"]);
    expect(rows.map((row) => DdrrRowSchema.parse(row))).toEqual(rows);
  });

  it("carries additive auto-repair and split lineage through review rows", () => {
    const reviewRow = reviewDepegResolverAssessment(
      assessment({
        lineage: {
          autoRepaired: true,
          repairSources: ["ddr-worker:auto-sealed-tail"],
        },
      }),
      actualEvent(),
      REVIEWED_AT,
    );
    const { rows } = reviewDdrrV2Rows({
      coverageRows: [coverage({ lineage: { parentIncidentKey: "ddr2:parent" } })],
      invalidatedPredictions: [invalidated({
        lineage: {
          autoRepaired: true,
          repairSources: ["ddr-worker:repair-task-runner-v1"],
          parentIncidentKey: "ddr2:parent",
        },
      })],
      nowSec: REVIEWED_AT,
    });

    expect(reviewRow.lineage).toEqual({
      autoRepaired: true,
      repairSources: ["ddr-worker:auto-sealed-tail"],
    });
    expect(rows[0]?.lineage).toEqual({ parentIncidentKey: "ddr2:parent" });
    expect(rows[1]?.lineage).toEqual({
      autoRepaired: true,
      repairSources: ["ddr-worker:repair-task-runner-v1"],
      parentIncidentKey: "ddr2:parent",
    });
    expect(DdrrRowSchema.parse(reviewRow)).toEqual(reviewRow);
    expect(rows.map((row) => DdrrRowSchema.parse(row))).toEqual(rows);
  });
});

describe("DDRR scoring", () => {
  it.each([
    ["malformed_assessment_timestamp", { lockedAt: Number.NaN }, actualEvent()],
    ["assessment_before_event_start", { lockedAt: STARTED_AT - 1 }, actualEvent()],
    ["source_event_missing", {}, null],
    ["event_id_mismatch", {}, actualEvent({ eventId: 2 })],
    ["malformed_event_start", {}, actualEvent({ startedAt: Number.NaN })],
    ["malformed_event_end", {}, actualEvent({ endedAt: Number.NaN })],
    ["malformed_recovery_price", {}, actualEvent({ endedAt: LOCKED_AT + 100, recoveryPrice: 0 })],
    ["recovery_price_without_event_end", {}, actualEvent({ endedAt: null, recoveryPrice: 1 })],
    ["event_end_before_event_start", {}, actualEvent({ endedAt: STARTED_AT - 1, recoveryPrice: null })],
    ["event_end_before_review_anchor", {}, actualEvent({ endedAt: LOCKED_AT - 1, recoveryPrice: 1 })],
  ])("pins data issue reason %s", (reason, assessmentOverrides, eventInput) => {
    const outcome = deriveActualOutcome(
      assessment(assessmentOverrides as Partial<DdrrAssessmentInput>),
      eventInput,
    );

    expect(outcome.dataIssueReason).toBe(reason);
  });

  it("classifies orphan-closed source rows as visible data issues, not terminal wins", () => {
    const row = reviewDepegResolverAssessment(
      assessment(),
      actualEvent({ endedAt: LOCKED_AT + 3_600, recoveryPrice: null, stablecoinStatus: "active" }),
      REVIEWED_AT,
    );

    expect(row.actual.kind).toBe("orphan_closed");
    expect(row.actual.actualEndedAt).toBe(LOCKED_AT + 3_600);
    expect(row.verdictReview).toBe("data_issue");
    expect(row.durationReview).toBe("data_issue");
  });

  it("computes duration errors from lockedAt instead of an earlier diagnostic assessment time", () => {
    const row = reviewDepegResolverAssessment(
      assessment({
        assessedAt: STARTED_AT + 3_600,
        lockedAt: LOCKED_AT,
        predictedRemainingSec: 3_600,
        iqrRemainingSec: [1_800, 7_200],
      }),
      actualEvent({ endedAt: LOCKED_AT + 4_000, recoveryPrice: 1 }),
      REVIEWED_AT,
    );

    expect(row.actualRemainingSec).toBe(4_000);
    expect(row.signedDurationErrorSec).toBe(400);
    expect(row.absoluteDurationErrorSec).toBe(400);
    expect(row.durationReview).toBe("inside_band");
  });

  it("treats event endings before lockedAt as duration data issues", () => {
    const row = reviewDepegResolverAssessment(
      assessment({ assessedAt: STARTED_AT + 3_600, lockedAt: LOCKED_AT }),
      actualEvent({ endedAt: LOCKED_AT - 1, recoveryPrice: 1 }),
      REVIEWED_AT,
    );

    expect(row.actual.kind).toBe("data_issue");
    expect(row.durationReview).toBe("data_issue");
    expect(row.actualRemainingSec).toBeNull();
  });

  it("scores terminal outcomes for verdict but leaves duration unscored", () => {
    const row = reviewDepegResolverAssessment(
      assessment({ resolutionTier: "recovery_unlikely" }),
      actualEvent({ endedAt: null, recoveryPrice: null, stablecoinStatus: "frozen" }),
      REVIEWED_AT,
    );

    expect(row.actual.kind).toBe("terminal");
    expect(row.verdictReview).toBe("correct_terminal");
    expect(row.durationReview).toBe("duration_unscored");
  });

  it("lets terminal evidence at or before recovery time take outcome precedence", () => {
    const row = reviewDepegResolverAssessment(
      assessment({ resolutionTier: "recovery_unlikely" }),
      actualEvent({
        endedAt: LOCKED_AT + 4_000,
        recoveryPrice: 1,
        terminalObserved: true,
        terminalEvidenceAt: LOCKED_AT + 3_000,
      }),
      REVIEWED_AT,
    );

    expect(row.actual.kind).toBe("terminal");
    expect(row.verdictReview).toBe("correct_terminal");
    expect(row.durationReview).toBe("duration_unscored");
  });

  it("does not treat overlapping coarse terminal evidence as settled before recovery", () => {
    const row = reviewDepegResolverAssessment(
      assessment({ resolutionTier: "recovery_likely" }),
      actualEvent({
        endedAt: LOCKED_AT + 4_000,
        recoveryPrice: 1,
        terminalObserved: true,
        terminalEvidenceAt: LOCKED_AT + 3_000,
        terminalEvidenceInterval: { start: LOCKED_AT + 3_000, end: LOCKED_AT + 5_000 },
        terminalEvidencePrecision: "day",
      }),
      REVIEWED_AT,
    );

    expect(row.actual.kind).toBe("recovered");
    expect(row.verdictReview).toBe("correct_recoverable");
    expect(row.durationReview).not.toBe("duration_unscored");
    expect(row.actualRemainingSec).toBe(4_000);
  });

  it("reviews horizons as hit, miss, pending, or unscored from lock-time horizons", () => {
    const hit = reviewDepegResolverAssessment(
      assessment({ horizonCells: [horizonCell("6h")] }),
      actualEvent({ endedAt: LOCKED_AT + 3_600, recoveryPrice: 1 }),
      REVIEWED_AT,
    );
    expect(hit.horizonReviews[0]).toMatchObject({
      horizon: "6h",
      result: "hit",
      horizonElapsed: true,
      resolvedWithinHorizon: true,
    });

    const miss = reviewDepegResolverAssessment(
      assessment({ horizonCells: [horizonCell("6h")] }),
      actualEvent({ endedAt: null, recoveryPrice: null }),
      LOCKED_AT + 7 * 3_600,
    );
    expect(miss.horizonReviews[0]).toMatchObject({
      horizon: "6h",
      result: "miss",
      horizonElapsed: true,
      resolvedWithinHorizon: false,
    });

    const pending = reviewDepegResolverAssessment(
      assessment({ horizonCells: [horizonCell("6h")] }),
      actualEvent({ endedAt: null, recoveryPrice: null }),
      LOCKED_AT + 3_600,
    );
    expect(pending.horizonReviews[0]).toMatchObject({
      horizon: "6h",
      result: "pending",
      horizonElapsed: false,
      resolvedWithinHorizon: false,
    });

    const unscored = reviewDepegResolverAssessment(
      assessment({
        horizonCells: [horizonCell("6h", { state: "unsupported", probability: null, probabilityDisplay: null })],
      }),
      actualEvent({ endedAt: LOCKED_AT + 3_600, recoveryPrice: 1 }),
      REVIEWED_AT,
    );
    expect(unscored.horizonReviews[0]).toMatchObject({
      horizon: "6h",
      result: "unscored",
      horizonElapsed: true,
      resolvedWithinHorizon: true,
    });
  });
});

describe("DDRR coverage metrics", () => {
  it("excludes no-calls and coverage rows from accuracy denominators", () => {
    const { summary } = reviewDdrrV2Rows({
      assessments: [
        assessment({ eventId: 1, incidentKey: "ddr2:pred1", resolutionTier: "recovery_likely" }),
        assessment({ eventId: 2, incidentKey: "ddr2:pred2", resolutionTier: "recovery_unlikely" }),
      ],
      noCalls: [
        assessment({
          eventId: 3,
          incidentKey: "ddr2:nocall",
          resolutionTier: "insufficient_signal",
          durationSuppressed: true,
          durationSuppressedReason: "insufficient_signal",
          predictedRemainingSec: null,
          iqrRemainingSec: null,
        }),
      ],
      coverageRows: [coverage({ incidentKey: "ddr2:resolved", predictionState: "resolved_before_prediction" })],
      actualEventsById: new Map([
        [1, actualEvent({ eventId: 1, endedAt: LOCKED_AT + 100, recoveryPrice: 1 })],
        [2, actualEvent({ eventId: 2, endedAt: LOCKED_AT + 100, recoveryPrice: 1 })],
        [3, actualEvent({ eventId: 3, endedAt: LOCKED_AT + 100, recoveryPrice: 1 })],
      ]),
      nowSec: REVIEWED_AT,
    });

    expect(summary.headline.lockedPredictionCount).toBe(2);
    expect(summary.headline.noCallCount).toBe(1);
    expect(summary.headline.resolvedBeforePredictionCount).toBe(1);
    expect(summary.headline.recoveryLikelihoodScoredCount).toBe(2);
    expect(summary.headline.recoveryLikelihoodAccuracyPct).toBe(0.5);
    expect(summary.headline.predictionRatePct).toBe(2 / 3);
  });

  it("uses denominator-safe percentages for empty policy universes", () => {
    const summary = summarizeDdrrRows([]);

    expect(summary.headline.policyUniverseIncidentCount).toBe(0);
    expect(summary.headline.predictionRatePct).toBeNull();
    expect(summary.headline.stateAssignedPct).toBeNull();
    expect(summary.headline.invalidatedPct).toBeNull();
  });

  it("calibrates horizon probabilities against scored duration outcomes", () => {
    const calibrationRows = [
      reviewDepegResolverAssessment(
        assessment({ horizonCells: [horizonCell("6h", { probability: 0.2 })] }),
        actualEvent({ endedAt: LOCKED_AT + 3 * 3_600, recoveryPrice: 1 }),
        LOCKED_AT + 24 * 3_600,
      ),
      reviewDepegResolverAssessment(
        assessment({ horizonCells: [horizonCell("6h", { probability: 0.6 })] }),
        actualEvent({ endedAt: LOCKED_AT + 12 * 3_600, recoveryPrice: 1 }),
        LOCKED_AT + 24 * 3_600,
      ),
      reviewDepegResolverAssessment(
        assessment({ horizonCells: [horizonCell("6h", { probability: 0.9 })] }),
        actualEvent({ endedAt: LOCKED_AT + 3 * 3_600, recoveryPrice: 1 }),
        LOCKED_AT + 24 * 3_600,
      ),
    ];

    const calibration = summarizeDdrrRows(calibrationRows).headline.horizonCalibration;
    const sixHour = calibration.find((row) => row.horizon === "6h");

    expect(sixHour).toMatchObject({
      scored: 3,
      meanPredictedProbability: expect.closeTo(1.7 / 3),
      realizedClosureShare: expect.closeTo(2 / 3),
      biasPp: expect.closeTo(-10),
      zScore: expect.closeTo(0.3 / 0.7),
    });
    expect(calibration.find((row) => row.horizon === "24h")).toEqual({
      horizon: "24h",
      scored: 0,
      meanPredictedProbability: null,
      realizedClosureShare: null,
      biasPp: null,
      zScore: null,
    });
  });

  it("uses current policy as the headline once it has enough scored rows", () => {
    const currentRows = Array.from({ length: 20 }, (_, index) =>
      reviewDepegResolverAssessment(
        assessment({ eventId: index + 1, incidentKey: `ddr2:current-${index}`, publicPredictionId: index + 1 }),
        actualEvent({ eventId: index + 1, endedAt: LOCKED_AT + 3_600, recoveryPrice: 1 }),
        REVIEWED_AT,
      ),
    );
    const oldRows = Array.from({ length: 20 }, (_, index) =>
      reviewDepegResolverAssessment(
        assessment({
          eventId: 100 + index,
          incidentKey: `ddr2:old-${index}`,
          publicPredictionId: 100 + index,
          predictionPolicyVersion: "legacy-policy",
          resolutionTier: "recovery_unlikely",
        }),
        actualEvent({ eventId: 100 + index, endedAt: LOCKED_AT + 3_600, recoveryPrice: 1 }),
        REVIEWED_AT,
      ),
    );

    const summary = summarizeDdrrRows([...oldRows, ...currentRows]);

    expect(summary.headlineScope).toBe("current_policy");
    expect(summary.headline.recoveryLikelihoodScoredCount).toBe(20);
    expect(summary.headline.recoveryLikelihoodAccuracyPct).toBe(1);
  });

  it("accounts for missed-lock coverage debt without scoring it as accuracy", () => {
    const row = buildDdrrCoverageRow(
      coverage({
        incidentKey: "ddr2:missed",
        predictionState: "missed_lock_recovered",
        coverageCause: "lock_missed",
        operationalCoverageCause: "lock_missed",
        actualEndedAt: ELIGIBLE_AT,
      }),
    );
    const summary = summarizeDdrrRows([row]);

    expect(summary.headline.missedLockRecoveredCount).toBe(1);
    expect(summary.headline.missedNoPredictionCount).toBe(1);
    expect(summary.headline.missedOperationalLockCount).toBe(1);
    expect(summary.headline.recoveryLikelihoodScoredCount).toBe(0);
    expect(summary.headline.operationalMissRatePct).toBe(1);
  });

  it("counts publication retry and failure separately from scored predictions", () => {
    const { summary } = reviewDdrrV2Rows({
      coverageRows: [
        coverage({
          incidentKey: "ddr2:retry",
          predictionState: "publication_retry_pending",
          coverageCause: "publication_retry_pending",
          sourceEventState: "active",
        }),
        coverage({
          incidentKey: "ddr2:failed",
          predictionState: "publication_failed",
          coverageCause: "publication_failed",
          sourceEventState: "recovered",
          failedPublication: {
            publicPredictionId: 1,
            assessmentId: 2,
            lockedAt: LOCKED_AT,
            outcomeKind: "prediction",
            rowHash: "hash",
            sealedPayloadRedacted: true,
            lastAttemptedAt: LOCKED_AT + 60,
          },
        }),
      ],
      nowSec: REVIEWED_AT,
    });

    expect(summary.headline.publicationRetryPendingCount).toBe(1);
    expect(summary.headline.publicationFailedCount).toBe(1);
    expect(summary.headline.lockedPredictionCount).toBe(0);
    expect(summary.headline.predictionRatePct).toBe(0);
  });

  it("keeps operational miss rate bounded when one coverage row has overlapping failure causes", () => {
    const row = buildDdrrCoverageRow(
      coverage({
        incidentKey: "ddr2:failed-after-miss",
        predictionState: "publication_failed",
        coverageCause: "publication_failed",
        operationalCoverageCause: "lock_missed",
        sourceEventState: "recovered",
        actualEndedAt: ELIGIBLE_AT + 3600,
        failedPublication: {
          publicPredictionId: 7,
          assessmentId: 8,
          lockedAt: LOCKED_AT,
          outcomeKind: "prediction",
          rowHash: "hash",
          sealedPayloadRedacted: true,
          lastAttemptedAt: LOCKED_AT + 60,
        },
      }),
    );
    const summary = summarizeDdrrRows([row]);

    expect(summary.headline.missedOperationalLockCount).toBe(1);
    expect(summary.headline.publicationFailedCount).toBe(1);
    expect(summary.headline.operationalMissRatePct).toBe(1);
  });

  it("pins coverage state counts separately from operational-cause filters", () => {
    const { summary } = reviewDdrrV2Rows({
      coverageRows: [
        coverage({
          incidentKey: "ddr2:pending",
          predictionState: "pending_lock",
          coverageCause: "active_pending_lock",
          sourceEventState: "active",
          actualEndedAt: null,
        }),
        coverage({
          incidentKey: "ddr2:deferred",
          predictionState: "lock_deferred",
          coverageCause: "active_lock_deferred",
          sourceEventState: "active",
          actualEndedAt: null,
        }),
        coverage({ incidentKey: "ddr2:resolved", predictionState: "resolved_before_prediction" }),
        coverage({
          incidentKey: "ddr2:terminal",
          predictionState: "terminal_before_prediction",
          coverageCause: "pre_lock_terminal",
          sourceEventState: "terminal",
          actualEndedAt: null,
        }),
        coverage({
          incidentKey: "ddr2:data-quality-operational",
          predictionState: "data_quality_gap",
          coverageCause: "data_quality_gap",
          operationalCoverageCause: "cron_gap",
          outcomeQualityState: "data_quality_gap",
        }),
        coverage({
          incidentKey: "ddr2:data-quality-confirmation",
          predictionState: "data_quality_gap",
          coverageCause: "data_quality_gap",
          operationalCoverageCause: "confirmation_time_unknown",
          outcomeQualityState: "data_quality_gap",
        }),
        coverage({
          incidentKey: "ddr2:orphan-operational",
          predictionState: "orphan_closed",
          coverageCause: "orphan_closed",
          operationalCoverageCause: "system_deferral",
          sourceEventState: "orphan_closed",
          outcomeQualityState: "orphan_closed",
        }),
        coverage({
          incidentKey: "ddr2:orphan-source",
          predictionState: "orphan_closed",
          coverageCause: "orphan_closed",
          sourceEventState: "orphan_closed",
          outcomeQualityState: "orphan_closed",
        }),
        coverage({
          incidentKey: "ddr2:missed-recovered",
          predictionState: "missed_lock_recovered",
          coverageCause: "lock_missed",
          operationalCoverageCause: "lock_missed",
        }),
        coverage({
          incidentKey: "ddr2:missed-terminal",
          predictionState: "missed_lock_terminal",
          coverageCause: "terminal_time_unknown",
          operationalCoverageCause: "lock_missed",
          sourceEventState: "terminal",
          actualEndedAt: null,
        }),
        coverage({
          incidentKey: "ddr2:failed",
          predictionState: "publication_failed",
          coverageCause: "publication_failed",
          failedPublication: {
            publicPredictionId: 11,
            assessmentId: 12,
            lockedAt: LOCKED_AT,
            outcomeKind: "prediction",
            rowHash: "failed-hash",
            sealedPayloadRedacted: true,
            lastAttemptedAt: LOCKED_AT + 60,
          },
        }),
        coverage({
          incidentKey: "ddr2:retry",
          predictionState: "publication_retry_pending",
          coverageCause: "publication_retry_pending",
          sourceEventState: "active",
          actualEndedAt: null,
        }),
      ],
      nowSec: REVIEWED_AT,
    });

    expect({
      policyUniverseIncidentCount: summary.headline.policyUniverseIncidentCount,
      activeEligibleIncidentCount: summary.headline.activeEligibleIncidentCount,
      pendingLockCount: summary.headline.pendingLockCount,
      lockDeferredCount: summary.headline.lockDeferredCount,
      resolvedBeforePredictionCount: summary.headline.resolvedBeforePredictionCount,
      terminalBeforePredictionCount: summary.headline.terminalBeforePredictionCount,
      dataQualityGapCount: summary.headline.dataQualityGapCount,
      orphanClosedCount: summary.headline.orphanClosedCount,
      missedLockRecoveredCount: summary.headline.missedLockRecoveredCount,
      missedLockTerminalCount: summary.headline.missedLockTerminalCount,
      missedLockOrphanClosedCount: summary.headline.missedLockOrphanClosedCount,
      missedLockDataQualityGapCount: summary.headline.missedLockDataQualityGapCount,
      missedNoPredictionCount: summary.headline.missedNoPredictionCount,
      publicationFailedCount: summary.headline.publicationFailedCount,
      publicationRetryPendingCount: summary.headline.publicationRetryPendingCount,
      confirmationTimeUnknownCount: summary.headline.confirmationTimeUnknownCount,
      missedOperationalLockCount: summary.headline.missedOperationalLockCount,
      currentEligibleOpportunityCount: summary.headline.currentEligibleOpportunityCount,
      finalizedOpportunityCount: summary.headline.finalizedOpportunityCount,
      stateAssignedPct: summary.headline.stateAssignedPct,
      finalizedCoveragePct: summary.headline.finalizedCoveragePct,
      operationalMissRatePct: summary.headline.operationalMissRatePct,
    }).toMatchInlineSnapshot(`
      {
        "activeEligibleIncidentCount": 3,
        "confirmationTimeUnknownCount": 1,
        "currentEligibleOpportunityCount": 7,
        "dataQualityGapCount": 2,
        "finalizedCoveragePct": 0.9166666666666666,
        "finalizedOpportunityCount": 5,
        "lockDeferredCount": 1,
        "missedLockDataQualityGapCount": 1,
        "missedLockOrphanClosedCount": 1,
        "missedLockRecoveredCount": 1,
        "missedLockTerminalCount": 1,
        "missedNoPredictionCount": 4,
        "missedOperationalLockCount": 4,
        "operationalMissRatePct": 0.7142857142857143,
        "orphanClosedCount": 2,
        "pendingLockCount": 1,
        "policyUniverseIncidentCount": 12,
        "publicationFailedCount": 1,
        "publicationRetryPendingCount": 1,
        "resolvedBeforePredictionCount": 1,
        "stateAssignedPct": 1.1666666666666667,
        "terminalBeforePredictionCount": 1,
      }
    `);
  });

  it("tracks invalidations separately and includes them in trust denominators", () => {
    const { rows, summary } = reviewDdrrV2Rows({
      assessments: [assessment({ incidentKey: "ddr2:locked" })],
      invalidatedPredictions: [invalidated()],
      actualEventsById: new Map([[1, actualEvent({ endedAt: LOCKED_AT + 100, recoveryPrice: 1 })]]),
      nowSec: REVIEWED_AT,
    });

    expect(rows.find((row) => row.kind === "invalidated_prediction")?.predictionState).toBe("invalidated");
    expect(summary.headline.lockedPredictionCount).toBe(1);
    expect(summary.headline.invalidatedPredictionCount).toBe(1);
    expect(summary.headline.invalidatedByReason).toEqual({ event_identity_error: 1 });
    expect(summary.headline.predictionRatePct).toBe(0.5);
    expect(summary.headline.invalidationAdjustedPredictionRatePct).toBe(1);
  });

  it("pins headline and segment metrics for mixed DDRR row structures", () => {
    const { summary } = reviewDdrrV2Rows({
      assessments: [
        assessment({ eventId: 1, incidentKey: "ddr2:correct", publicPredictionId: 1 }),
        assessment({
          eventId: 2,
          incidentKey: "ddr2:false-terminal",
          publicPredictionId: 2,
          resolutionTier: "recovery_unlikely",
          durationSuppressed: true,
          durationSuppressedReason: "verdict_terminal",
          predictedRemainingSec: null,
          iqrRemainingSec: null,
        }),
      ],
      noCalls: [
        assessment({
          eventId: 3,
          incidentKey: "ddr2:no-call",
          publicPredictionId: 3,
          resolutionTier: "insufficient_signal",
          durationSuppressed: true,
          durationSuppressedReason: "insufficient_signal",
          predictedRemainingSec: null,
          iqrRemainingSec: null,
        }),
      ],
      invalidatedPredictions: [invalidated({ incidentKey: "ddr2:invalidated", publicPredictionId: 4 })],
      coverageRows: [
        coverage({
          incidentKey: "ddr2:pending",
          predictionState: "pending_lock",
          coverageCause: "active_pending_lock",
          sourceEventState: "active",
          actualEndedAt: null,
        }),
      ],
      actualEventsById: new Map([
        [1, actualEvent({ eventId: 1, endedAt: LOCKED_AT + 3_600, recoveryPrice: 1 })],
        [2, actualEvent({ eventId: 2, endedAt: LOCKED_AT + 3_600, recoveryPrice: 1 })],
        [3, actualEvent({ eventId: 3, endedAt: null, recoveryPrice: null })],
      ]),
      nowSec: REVIEWED_AT,
    });

    const projection = {
      headlineScope: summary.headlineScope,
      headline: {
        policyUniverseIncidentCount: summary.headline.policyUniverseIncidentCount,
        lockedPredictionCount: summary.headline.lockedPredictionCount,
        noCallCount: summary.headline.noCallCount,
        invalidatedPredictionCount: summary.headline.invalidatedPredictionCount,
        pendingLockCount: summary.headline.pendingLockCount,
        recoveryLikelihoodCorrectCount: summary.headline.recoveryLikelihoodCorrectCount,
        recoveryLikelihoodScoredCount: summary.headline.recoveryLikelihoodScoredCount,
        durationScoredCount: summary.headline.durationScoredCount,
        predictionRatePct: summary.headline.predictionRatePct,
        invalidationAdjustedPredictionRatePct: summary.headline.invalidationAdjustedPredictionRatePct,
        decisionProgressPct: summary.headline.decisionProgressPct,
        stateAssignedPct: summary.headline.stateAssignedPct,
        finalizedCoveragePct: summary.headline.finalizedCoveragePct,
      },
      segments: summary.byPredictionPolicy.map((segment) => ({
        segmentKind: segment.segmentKind,
        predictionMethodologyVersion: segment.predictionMethodologyVersion,
        predictionPolicyVersion: segment.predictionPolicyVersion,
        policyUniverseIncidentCount: segment.metrics.policyUniverseIncidentCount,
        lockedPredictionCount: segment.metrics.lockedPredictionCount,
        noCallCount: segment.metrics.noCallCount,
        invalidatedPredictionCount: segment.metrics.invalidatedPredictionCount,
        pendingLockCount: segment.metrics.pendingLockCount,
      })),
    };

    expect(projection).toMatchInlineSnapshot(`
      {
        "headline": {
          "decisionProgressPct": 1,
          "durationScoredCount": 1,
          "finalizedCoveragePct": 0.8,
          "invalidatedPredictionCount": 1,
          "invalidationAdjustedPredictionRatePct": 0.75,
          "lockedPredictionCount": 2,
          "noCallCount": 1,
          "pendingLockCount": 1,
          "policyUniverseIncidentCount": 5,
          "predictionRatePct": 0.5,
          "recoveryLikelihoodCorrectCount": 1,
          "recoveryLikelihoodScoredCount": 2,
          "stateAssignedPct": 1,
        },
        "headlineScope": "insufficient_data",
        "segments": [
          {
            "invalidatedPredictionCount": 1,
            "lockedPredictionCount": 2,
            "noCallCount": 1,
            "pendingLockCount": 0,
            "policyUniverseIncidentCount": 4,
            "predictionMethodologyVersion": "2.0",
            "predictionPolicyVersion": "sticky-24h-v1",
            "segmentKind": "prediction_policy",
          },
          {
            "invalidatedPredictionCount": 0,
            "lockedPredictionCount": 0,
            "noCallCount": 0,
            "pendingLockCount": 1,
            "policyUniverseIncidentCount": 1,
            "predictionMethodologyVersion": null,
            "predictionPolicyVersion": null,
            "segmentKind": "coverage",
          },
          {
            "invalidatedPredictionCount": 1,
            "lockedPredictionCount": 2,
            "noCallCount": 1,
            "pendingLockCount": 1,
            "policyUniverseIncidentCount": 5,
            "predictionMethodologyVersion": null,
            "predictionPolicyVersion": null,
            "segmentKind": "all",
          },
        ],
      }
    `);
  });
});
