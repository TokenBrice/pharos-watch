import { describe, expect, it } from "vitest";
import { summarizeDdrrRows } from "@shared/lib/depeg-resolver-review";
import {
  DdrrResponseRowSchema,
  DdrrV2BaseRowSchema,
  type DdrrRow,
  type DdrrV2NoCallReviewRow,
  type DdrrV2InvalidatedPredictionRow,
} from "@shared/types/depeg-resolver-review";
import { DdrRelatedContextSchema } from "@shared/types/depeg-resolver";
import { RatioSchema } from "@shared/types/ratio";
import {
  coverageRow,
  makePredictionPolicySegment,
  predictionRow,
} from "@/components/depeg-resolver-review-test-support";
import {
  buildDdrReviewerRows,
  buildDdrTimelineModel,
  DDR_COVERAGE_LABELS,
  DDR_OUTCOME_LABELS,
  DDR_VERDICT_LABELS,
  DDR_VERDICT_TITLES,
  DDR_VERDICT_TONES,
  MUTED_TONE,
  formatBrierSkill,
  formatDurationRatioHeadline,
  formatMetricPercent,
  formatWilsonInterval,
  formatReviewerPercent,
  formatDdrSignedDuration,
  getActualOutcome,
  getCoverageMetric,
  getCoverageState,
  getDurationReview,
  getRowContextLabel,
  getRowTime,
  getSignedDurationError,
  getVerdictReview,
  isDdrScoredVerdict,
  isScored,
  isTrackRecordRow,
  nodeKind,
  summarizeAccuracyByMajor,
  wilsonInterval90,
} from "../depeg-resolver-review-presentation";

const publicationRow = {
  ...DdrrV2BaseRowSchema.parse(predictionRow),
  publicPredictionId: predictionRow.publicPredictionId,
  assessmentId: predictionRow.assessmentId,
  predictionMethodologyVersion: predictionRow.predictionMethodologyVersion,
  predictionPolicyVersion: predictionRow.predictionPolicyVersion,
  lockedAt: predictionRow.lockedAt,
};

const noCallRow: DdrrV2NoCallReviewRow = {
  ...publicationRow,
  kind: "no_call_review",
  predictionState: "no_call",
  publishedAt: predictionRow.publishedAt,
  publicationSnapshotToken: predictionRow.publicationSnapshotToken,
  actual: predictionRow.actual,
  verdictReview: "unscored_insufficient_signal",
  durationReview: "duration_unscored",
  horizonReviews: [],
  missingReasons: ["thin signal"],
};

const latestErratum: DdrrV2InvalidatedPredictionRow["latestErratum"] = {
  id: 1,
  state: "invalidated",
  publicPredictionId: publicationRow.publicPredictionId,
  incidentKey: publicationRow.incidentKey,
  eventId: publicationRow.eventId,
  assessmentId: publicationRow.assessmentId,
  reason: "event_identity_error",
  createdAt: 4,
  operatorNote: "Event identity corrected",
  rowHashBefore: null,
  replacementAssessmentId: null,
  replacementRowHash: null,
  createdBy: "fixture",
};

const invalidatedRow: DdrrV2InvalidatedPredictionRow = {
  ...publicationRow,
  kind: "invalidated_prediction",
  predictionState: "invalidated",
  sourceEventState: "invalidated",
  publishedAt: null,
  publicationSnapshotToken: null,
  originalKind: "no_call",
  originalOutcome: {
    lockedAt: noCallRow.lockedAt,
    eventAgeAtLockSec: noCallRow.lockedAt - noCallRow.startedAt,
    missingReasons: noCallRow.missingReasons,
    relatedContext: DdrRelatedContextSchema.parse({}),
  },
  latestErratum,
  errataCount: 1,
  errataHistory: [latestErratum],
};

describe("DDR review presentation vocabulary", () => {
  it("owns labels and scoreability for both public review surfaces", () => {
    expect(DDR_VERDICT_LABELS.correct_recoverable).toBe("Correct recoverable");
    expect(DDR_COVERAGE_LABELS.no_call).toBe("no-call");
    expect(DDR_OUTCOME_LABELS.still_open).toBe("still open");
    expect(isDdrScoredVerdict("risk_noted_terminal")).toBe(true);
    expect(isDdrScoredVerdict("pending")).toBe(false);
  });

  it("presents terminal-at-lock as unscored curation debt, not a forecast outcome", () => {
    expect(DDR_VERDICT_LABELS.terminal_at_lock).toBe("Terminal at lock");
    expect(DDR_VERDICT_TONES.terminal_at_lock).toBe(MUTED_TONE);
    expect(DDR_VERDICT_TITLES.terminal_at_lock).toMatch(/registry curation lag, not scored/);
    expect(isDdrScoredVerdict("terminal_at_lock")).toBe(false);
    expect(nodeKind("terminal_at_lock")).toBe("muted");
  });

  it("formats reviewer v5 duration ratio and horizon skill headlines", () => {
    expect(formatDurationRatioHeadline(Math.log2(1.4))).toBe("1.4× slower");
    expect(formatDurationRatioHeadline(-1)).toBe("2.0× faster");
    expect(formatDurationRatioHeadline(0.01)).toBe("on pace");
    expect(formatBrierSkill(0.123)).toBe("+0.12");
    expect(formatBrierSkill(-0.05)).toBe("−0.05");
    expect(formatBrierSkill(null)).toBe("—");
  });

  it("reads native outcomes and formats duration display", () => {
    expect(
      getActualOutcome({
        ...coverageRow,
        sourceEventState: "active",
        actualOutcome: "still_open",
      }),
    ).toBe("still_open");
    expect(
      getActualOutcome({
        ...coverageRow,
        sourceEventState: "missing",
        actualOutcome: "source_missing",
      }),
    ).toBe("source_missing");
    expect(getActualOutcome(invalidatedRow)).toBe("invalidated");
    expect(formatDdrSignedDuration(null)).toBe("N/A");
    expect(formatDdrSignedDuration(61)).toBe("+1m");
    expect(formatDdrSignedDuration(-61)).toBe("−1m");
  });

  it("accepts generation-3 coverage rows and renders the same outcome label as generation-4", () => {
    const generation4Row = DdrrResponseRowSchema.parse(coverageRow);
    const { actualOutcome: _actualOutcome, ...generation3Payload } = coverageRow;
    const generation3Row = DdrrResponseRowSchema.parse(generation3Payload);

    expect(generation3Row).not.toHaveProperty("actualOutcome");
    const generation4Outcome = getActualOutcome(generation4Row);
    const generation3Outcome = getActualOutcome(generation3Row);
    expect(generation4Outcome).toBe("recovered");
    expect(generation3Outcome).toBe(generation4Outcome);
    expect(DDR_OUTCOME_LABELS[generation3Outcome]).toBe(DDR_OUTCOME_LABELS[generation4Outcome]);
  });
});

describe("DDR review derivations", () => {
  it("extracts row state, labels, timing, and display predicates", () => {
    expect(isScored(predictionRow)).toBe(true);
    expect(isScored(noCallRow)).toBe(false);
    expect(isTrackRecordRow(predictionRow)).toBe(true);
    expect(isTrackRecordRow(coverageRow)).toBe(false);

    expect(getCoverageState(predictionRow)).toBeNull();
    expect(getCoverageState(coverageRow)).toBe("missed_lock_recovered");
    expect(getVerdictReview(predictionRow)).toBe("correct_recoverable");
    expect(getVerdictReview(coverageRow)).toBe("pending");
    expect(getDurationReview(noCallRow)).toBe("duration_unscored");
    expect(getDurationReview(coverageRow)).toBe("duration_unscored");
    expect(getActualOutcome(noCallRow)).toBe("recovered");
    expect(getActualOutcome(coverageRow)).toBe("recovered");
    expect(getRowContextLabel(predictionRow)).toBe("Public prediction");
    expect(getRowContextLabel(noCallRow)).toBe("No-call");
    expect(getRowContextLabel(invalidatedRow)).toBe("Invalidated no-call");
    expect(getRowContextLabel(coverageRow)).toBe("Coverage");
    expect(getRowTime(predictionRow)).toBe(3);
    expect(getRowTime(invalidatedRow)).toBe(2);
    expect(getRowTime(coverageRow)).toBe(7202);
    expect(getSignedDurationError(predictionRow)).toBe(3600);
    expect(getSignedDurationError(noCallRow)).toBeNull();
    expect(formatReviewerPercent(0.5)).toBe("50%");
    expect(formatMetricPercent(null)).toBe("—");
  });

  it("classifies and caps the track-record timeline", () => {
    expect(nodeKind("correct_terminal")).toBe("correct");
    expect(nodeKind("false_recoverable")).toBe("miss");
    expect(nodeKind("risk_noted_terminal")).toBe("risk");
    expect(nodeKind("pending")).toBe("pending");
    expect(nodeKind("data_issue")).toBe("muted");

    const timeline = buildDdrTimelineModel(
      [
        { ...predictionRow, eventId: 1, publishedAt: 10, verdictReview: "pending" } as DdrrRow,
        { ...predictionRow, eventId: 2, publishedAt: 20, verdictReview: "false_terminal" } as DdrrRow,
        { ...predictionRow, eventId: 3, publishedAt: 30, verdictReview: "correct_terminal" } as DdrrRow,
      ],
      2,
    );

    expect(timeline.rows.map((row) => row.eventId)).toEqual([2, 3]);
    expect(timeline.correct).toBe(1);
    expect(timeline.miss).toBe(1);
    expect(timeline.pending).toBe(0);
  });

  it("consolidates version accuracy and duration means by methodology major", () => {
    const baseSummary = summarizeDdrrRows([]);
    const template = baseSummary.byPredictionPolicy.find(
      (candidate) => candidate.segmentKind === "all",
    )!.metrics;

    const segments = summarizeAccuracyByMajor({
      ...baseSummary,
      byPredictionPolicy: [
        makePredictionPolicySegment(template, "2.0", 6, 5, 5, 3600, 5400),
        makePredictionPolicySegment(template, "3.02", 13, 11, 10, 7200, 10800),
        makePredictionPolicySegment(template, "3.04", 21, 20, 20, -3600, 7200),
      ],
    });

    expect(segments).toEqual([
      {
        major: "v2",
        scored: 6,
        correct: 5,
        accuracy: 5 / 6,
        interval: wilsonInterval90(5, 6),
        durationScored: 5,
        meanSignedDurationErrorSec: 3600,
        meanAbsoluteDurationErrorSec: 5400,
      },
      {
        major: "v3",
        scored: 34,
        correct: 31,
        accuracy: 31 / 34,
        interval: wilsonInterval90(31, 34),
        durationScored: 30,
        meanSignedDurationErrorSec: 0,
        meanAbsoluteDurationErrorSec: 8400,
      },
      {
        major: "v5",
        scored: 0,
        correct: 0,
        accuracy: null,
        interval: null,
        durationScored: 0,
        meanSignedDurationErrorSec: null,
        meanAbsoluteDurationErrorSec: null,
      },
    ]);
  });

  it("bounds per-major accuracy with a 90% Wilson interval however thin the sample", () => {
    const interval = wilsonInterval90(5, 6)!;
    expect(interval.lower).toBeCloseTo(0.4976, 3);
    expect(interval.upper).toBeCloseTo(0.9619, 3);
    expect(formatWilsonInterval(interval)).toBe("50–96%");
    expect(wilsonInterval90(1, 1)!.upper).toBeCloseTo(1, 9);
    expect(wilsonInterval90(0, 0)).toBeNull();
  });

  it("selects coverage metrics using their distinct denominators", () => {
    const headline = {
      ...summarizeDdrrRows([]).headline,
      policyUniverseIncidentCount: 20,
      recoveryLikelihoodScoredCount: 8,
      predictionRatePct: RatioSchema.parse(0.65),
      lockedPredictionCount: 9,
      publicationRetryPendingCount: 1,
      publicationFailedCount: 0,
      noCallRatePct: RatioSchema.parse(0.1),
      invalidatedPct: RatioSchema.parse(0.05),
    };

    expect(getCoverageMetric(headline, "scoreableCoveragePct")).toBe(0.4);
    expect(getCoverageMetric(headline, "predictionCoveragePct")).toBe(0.65);
    expect(getCoverageMetric(headline, "publicationSuccessPct")).toBe(0.9);
    expect(getCoverageMetric(headline, "noCallSharePct")).toBe(0.1);
    expect(getCoverageMetric(headline, "invalidationRatePct")).toBe(0.05);
    expect(
      getCoverageMetric(
        { ...headline, policyUniverseIncidentCount: 0, lockedPredictionCount: 0, publicationRetryPendingCount: 0 },
        "scoreableCoveragePct",
      ),
    ).toBeNull();
  });

  it("orders scored rows first while preserving the track-record subset", () => {
    const model = buildDdrReviewerRows(
      [
        coverageRow,
        { ...predictionRow, eventId: 44, verdictReview: "pending" } as DdrrRow,
        predictionRow,
      ],
      2,
    );

    expect(model.shownRows.map((row) => row.eventId)).toEqual([42, 43]);
    expect(model.hiddenCount).toBe(1);
    expect(model.trackRecordRows.map((row) => row.eventId)).toEqual([44, 42]);
  });
});
