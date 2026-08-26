import { describe, expect, it } from "vitest";
import { summarizeDdrrRows } from "@shared/lib/depeg-resolver-review";
import type { DdrrRow } from "@shared/types/depeg-resolver-review";
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
  ddrSourceEventStateToActualOutcome,
  formatMetricPercent,
  formatPercent,
  formatDdrSignedDuration,
  getActualOutcome,
  getCoverageMetric,
  getCoverageState,
  getDurationReview,
  getRowContextLabel,
  getRowTime,
  getSignedDurationError,
  getVerdictReview,
  isDdrCorrectVerdict,
  isDdrMissVerdict,
  isDdrScoredVerdict,
  isScored,
  isTrackRecordRow,
  nodeKind,
  summarizeAccuracyByMajor,
  summarizePredictionRows,
} from "../depeg-resolver-review-presentation";

const noCallRow = {
  ...predictionRow,
  kind: "no_call_review",
  predictionState: "no_call",
  verdictReview: "unscored_insufficient_signal",
  durationReview: "duration_unscored",
  missingReasons: ["thin signal"],
} as DdrrRow;

const invalidatedRow = {
  ...predictionRow,
  kind: "invalidated_prediction",
  predictionState: "invalidated",
  publishedAt: null,
  originalKind: "no_call",
} as DdrrRow;

describe("DDR review presentation vocabulary", () => {
  it("owns labels and scoreability for both public review surfaces", () => {
    expect(DDR_VERDICT_LABELS.correct_recoverable).toBe("Correct recoverable");
    expect(DDR_COVERAGE_LABELS.no_call).toBe("no-call");
    expect(DDR_OUTCOME_LABELS.still_open).toBe("still open");
    expect(isDdrScoredVerdict("risk_noted_terminal")).toBe(true);
    expect(isDdrCorrectVerdict("correct_terminal")).toBe(true);
    expect(isDdrMissVerdict("false_recoverable")).toBe(true);
    expect(isDdrScoredVerdict("pending")).toBe(false);
  });

  it("normalizes source outcomes and duration display exhaustively", () => {
    expect(ddrSourceEventStateToActualOutcome("active")).toBe("still_open");
    expect(ddrSourceEventStateToActualOutcome("missing")).toBe("source_missing");
    expect(ddrSourceEventStateToActualOutcome("terminal")).toBe("terminal");
    expect(formatDdrSignedDuration(null)).toBe("N/A");
    expect(formatDdrSignedDuration(61)).toBe("+1m");
    expect(formatDdrSignedDuration(-61)).toBe("−1m");
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
    expect(formatPercent(0.5)).toBe("50%");
    expect(formatMetricPercent(null)).toBe("—");
  });

  it("counts prediction verdict and IQR breakdowns without counting context rows", () => {
    const breakdown = summarizePredictionRows([
      predictionRow,
      { ...predictionRow, eventId: 44, verdictReview: "correct_terminal", withinIqr: false } as DdrrRow,
      { ...predictionRow, eventId: 45, verdictReview: "false_terminal", withinIqr: null } as DdrrRow,
      { ...predictionRow, eventId: 46, verdictReview: "false_recoverable" } as DdrrRow,
      noCallRow,
      coverageRow,
    ]);

    expect(breakdown).toEqual({
      correctRecoverable: 1,
      correctTerminal: 1,
      falseTerminal: 1,
      falseRecoverable: 1,
      withinIqrCount: 2,
      iqrScoredCount: 3,
    });
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
        durationScored: 5,
        meanSignedDurationErrorSec: 3600,
        meanAbsoluteDurationErrorSec: 5400,
      },
      {
        major: "v3",
        scored: 34,
        correct: 31,
        accuracy: 31 / 34,
        durationScored: 30,
        meanSignedDurationErrorSec: 0,
        meanAbsoluteDurationErrorSec: 8400,
      },
      {
        major: "v4",
        scored: 0,
        correct: 0,
        accuracy: null,
        durationScored: 0,
        meanSignedDurationErrorSec: null,
        meanAbsoluteDurationErrorSec: null,
      },
    ]);
  });

  it("selects coverage metrics using their distinct denominators", () => {
    const headline = {
      ...summarizeDdrrRows([]).headline,
      policyUniverseIncidentCount: 20,
      recoveryLikelihoodScoredCount: 8,
      predictionRatePct: 0.65,
      lockedPredictionCount: 9,
      publicationRetryPendingCount: 1,
      publicationFailedCount: 0,
      noCallRatePct: 0.1,
      invalidatedPct: 0.05,
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
