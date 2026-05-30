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
import { buildDdrrCoverageRow, reviewDdrrV2Rows, reviewDepegResolverAssessment, summarizeDdrrRows } from "../index";

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

describe("DDRR v2 row contract", () => {
  it("bumps the public reviewer version and emits discriminated prediction rows", () => {
    const row = reviewDepegResolverAssessment(assessment(), actualEvent(), REVIEWED_AT);

    expect(DDRR_REVIEWER_VERSION).toBe("ddr-reviewer-v2");
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
});

describe("DDRR v2 scoring", () => {
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
});

describe("DDRR v2 coverage metrics", () => {
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
});
