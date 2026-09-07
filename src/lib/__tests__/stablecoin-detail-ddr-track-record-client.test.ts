// src/lib/__tests__/stablecoin-detail-ddr-track-record-client.test.ts
import { describe, expect, it } from "vitest";
import { DDRR_PUBLIC_WARNING, type DdrrResponse, type DdrrRow } from "@shared/types/depeg-resolver-review";
import { projectDdrTrackRecordSummary } from "../stablecoin-detail-ddr-track-record-client";

const COIN = "lusd-liquity";

const BASE_ROW = {
  eventId: 1,
  currentEventId: 1,
  incidentKey: `${COIN}:below:1`,
  stablecoinId: COIN,
  symbol: "LUSD",
  name: "Liquity USD",
  pegCurrency: "USD",
  governance: "decentralized",
  direction: "below",
  startedAt: 1_700_000_000,
  eligibleAt: 1_700_000_600,
  sourceEventState: "recovered",
  terminalEvidenceAt: null,
  terminalEvidenceInterval: null,
  terminalEvidencePrecision: null,
} as const;

const PUBLICATION_CORE = {
  publicPredictionId: 7,
  assessmentId: 9,
  predictionMethodologyVersion: "4.0",
  predictionPolicyVersion: "sticky-24h-v1",
  lockedAt: 1_700_000_900,
  publishedAt: 1_700_001_000,
  publicationSnapshotToken: "snapshot-1",
} as const;

const ACTUAL_RECOVERED = {
  kind: "recovered",
  actualEndedAt: 1_700_010_000,
  actualRemainingSec: 9000,
  terminalEvidenceAt: null,
  terminalEvidenceInterval: null,
  terminalEvidencePrecision: null,
  reviewedAt: 1_700_010_100,
} as const;

function predictionRow(overrides: Record<string, unknown> = {}): DdrrRow {
  return {
    ...BASE_ROW,
    ...PUBLICATION_CORE,
    kind: "prediction_review",
    predictionState: "frozen",
    frozen: {
      resolutionTier: "recovery_likely",
      predictedRemainingSec: 3600,
      iqrRemainingSec: [1800, 7200],
      horizonCells: [],
      stratum: null,
      factors: [],
    },
    actual: ACTUAL_RECOVERED,
    verdictReview: "correct_recoverable",
    durationReview: "inside_band",
    horizonReviews: [],
    predictedRemainingSec: 3600,
    actualRemainingSec: 9000,
    signedDurationErrorSec: -3600,
    absoluteDurationErrorSec: 3600,
    medianReview: null,
    withinIqr: true,
    ...overrides,
  } as unknown as DdrrRow;
}

function noCallRow(overrides: Record<string, unknown> = {}): DdrrRow {
  return {
    ...BASE_ROW,
    ...PUBLICATION_CORE,
    kind: "no_call_review",
    predictionState: "no_call",
    missingReasons: ["insufficient_signal"],
    actual: ACTUAL_RECOVERED,
    verdictReview: "unscored_insufficient_signal",
    durationReview: "duration_unscored",
    horizonReviews: [],
    ...overrides,
  } as unknown as DdrrRow;
}

function coverageRow(overrides: Record<string, unknown> = {}): DdrrRow {
  return {
    ...BASE_ROW,
    kind: "coverage",
    predictionState: "missed_lock_recovered",
    actualOutcome: "recovered",
    actualEndedAt: 1_700_010_000,
    terminalEvidenceSourceDate: null,
    coverageCause: "lock_missed",
    operationalCoverageCause: null,
    outcomeQualityState: "classified",
    reason: null,
    failedPublication: null,
    ...overrides,
  } as unknown as DdrrRow;
}

function invalidatedRow(overrides: Record<string, unknown> = {}): DdrrRow {
  return {
    ...BASE_ROW,
    ...PUBLICATION_CORE,
    kind: "invalidated_prediction",
    predictionState: "invalidated",
    originalKind: "prediction",
    originalOutcome: { kind: "prediction" },
    latestErratum: { reason: "source_event_repair" },
    errataCount: 2,
    errataHistory: [],
    ...overrides,
  } as unknown as DdrrRow;
}

function response(rows: DdrrRow[], meta: Record<string, unknown> | null = {}): DdrrResponse {
  return {
    _meta: meta === null ? undefined : { computedAt: 1_700_100_000, publicWarning: DDRR_PUBLIC_WARNING, ...meta },
    summary: {},
    rows,
    methodology: {},
  } as unknown as DdrrResponse;
}

describe("projectDdrTrackRecordSummary", () => {
  it("returns null without data, rows, or a coin id", () => {
    expect(projectDdrTrackRecordSummary(undefined, COIN)).toBeNull();
    expect(projectDdrTrackRecordSummary(response([]), COIN)).toBeNull();
    expect(projectDdrTrackRecordSummary(response([predictionRow()]), "")).toBeNull();
    expect(projectDdrTrackRecordSummary({ rows: null } as unknown as DdrrResponse, COIN)).toBeNull();
  });

  it("ignores rows belonging to other coins", () => {
    expect(
      projectDdrTrackRecordSummary(response([predictionRow({ stablecoinId: "usdc-circle" })]), COIN),
    ).toBeNull();
  });

  it("returns null for coins carrying only coverage rows", () => {
    expect(projectDdrTrackRecordSummary(response([coverageRow(), coverageRow({ eventId: 2 })]), COIN)).toBeNull();
  });

  it("aggregates verdict counts, the median duration miss, and the reviewed stamp", () => {
    const record = projectDdrTrackRecordSummary(
      response([
        predictionRow({ eventId: 1, absoluteDurationErrorSec: 3600 }),
        predictionRow({ eventId: 2, verdictReview: "false_terminal", absoluteDurationErrorSec: 10_800 }),
        predictionRow({ eventId: 3, verdictReview: "pending", absoluteDurationErrorSec: null }),
        noCallRow({ eventId: 4 }),
        coverageRow({ eventId: 5 }),
        invalidatedRow({ eventId: 6 }),
      ]),
      COIN,
    );

    expect(record).not.toBeNull();
    expect(record!.reviewedForecastCount).toBe(3);
    expect(record!.scoredCount).toBe(2);
    expect(record!.correctCount).toBe(1);
    expect(record!.missCount).toBe(1);
    expect(record!.pendingCount).toBe(1);
    expect(record!.noCallCount).toBe(1);
    expect(record!.notCalledCount).toBe(1);
    expect(record!.invalidatedCount).toBe(1);
    expect(record!.durationScoredCount).toBe(2);
    // median of [3600, 10800] = 7200s
    expect(record!.medianAbsoluteDurationErrorLabel).toBe("2h");
    expect(record!.reviewedAt).toBe("2023-11-16");
    expect(record!.publicWarning).toBe(DDRR_PUBLIC_WARNING);
    expect(record!.lede).toContain("3 frozen DDR forecasts");
    expect(record!.lede).toContain("1 of 2 scored recovery calls correct");
    expect(record!.lede).toContain("Median duration miss 2h");
    expect(record!.lede).toContain("1 incident carried no published call");
  });

  it("tones the header chip by the scored record", () => {
    const allCorrect = projectDdrTrackRecordSummary(response([predictionRow()]), COIN)!;
    expect(allCorrect.chipLabel).toBe("1/1 correct");
    expect(allCorrect.chipToneClass).toContain("emerald");

    const mixed = projectDdrTrackRecordSummary(
      response([predictionRow(), predictionRow({ eventId: 2, verdictReview: "false_recoverable" })]),
      COIN,
    )!;
    expect(mixed.chipLabel).toBe("1/2 correct");
    expect(mixed.chipToneClass).toContain("amber");

    const allWrong = projectDdrTrackRecordSummary(
      response([predictionRow({ verdictReview: "false_terminal" })]),
      COIN,
    )!;
    expect(allWrong.chipLabel).toBe("0/1 correct");
    expect(allWrong.chipToneClass).toContain("red");

    const maturing = projectDdrTrackRecordSummary(
      response([predictionRow({ verdictReview: "pending" })]),
      COIN,
    )!;
    expect(maturing.chipLabel).toBe("1 maturing");
    expect(maturing.chipToneClass).toContain("sky");

    const unscored = projectDdrTrackRecordSummary(response([noCallRow()]), COIN)!;
    expect(unscored.chipLabel).toBe("Unscored");
    expect(unscored.lede).toContain("No frozen DDR forecast");
  });

  it("orders incidents newest first and folds the tail into a hidden count", () => {
    const rows = Array.from({ length: 8 }, (_, index) =>
      predictionRow({ eventId: index + 1, startedAt: 1_700_000_000 + index * 86_400 }),
    );
    const record = projectDdrTrackRecordSummary(response(rows), COIN)!;

    expect(record.incidents).toHaveLength(6);
    expect(record.hiddenIncidentCount).toBe(2);
    expect(record.incidents.map((incident) => incident.startedAt)).toEqual([
      1_700_604_800, 1_700_518_400, 1_700_432_000, 1_700_345_600, 1_700_259_200, 1_700_172_800,
    ]);
    expect(record.incidents[0]!.dateLabel).toBe("2023-11-21");
  });

  it("labels each incident with the /depeg outcome vocabulary", () => {
    const record = projectDdrTrackRecordSummary(
      response([
        predictionRow({ eventId: 1, signedDurationErrorSec: 7200, durationReview: "median_late_by" }),
        noCallRow({ eventId: 2, startedAt: BASE_ROW.startedAt - 100 }),
        coverageRow({ eventId: 3, startedAt: BASE_ROW.startedAt - 200, sourceEventState: "active", actualOutcome: "still_open" }),
        invalidatedRow({ eventId: 4, startedAt: BASE_ROW.startedAt - 300 }),
      ]),
      COIN,
    )!;

    const [prediction, noCall, coverage, invalidated] = record.incidents;
    expect(prediction!.outcomeLabel).toBe("Correct recoverable");
    expect(prediction!.outcomeToneClass).toContain("emerald");
    expect(prediction!.actualOutcomeLabel).toBe("recovered");
    expect(prediction!.durationLabel).toBe("+2h late vs median");
    expect(prediction!.erratumLabel).toBeNull();

    expect(noCall!.outcomeLabel).toBe("no-call");
    expect(noCall!.durationLabel).toBe("unscored");

    expect(coverage!.outcomeLabel).toBe("missed recovered");
    expect(coverage!.actualOutcomeLabel).toBe("still open");

    expect(invalidated!.outcomeLabel).toBe("invalidated");
    expect(invalidated!.erratumLabel).toBe("2 errata");
    expect(
      projectDdrTrackRecordSummary(response([invalidatedRow({ errataCount: 1 }), predictionRow({ eventId: 9 })]), COIN)!
        .incidents.find((incident) => incident.outcomeLabel === "invalidated")!.erratumLabel,
    ).toBe("1 erratum");
  });

  it("renders a negative duration miss with a signed minus", () => {
    const record = projectDdrTrackRecordSummary(response([predictionRow()]), COIN)!;
    expect(record.incidents[0]!.durationLabel).toBe("−1h inside band");
  });

  it("drops malformed rows and falls back to the public warning", () => {
    const record = projectDdrTrackRecordSummary(
      response(
        [
          predictionRow(),
          predictionRow({ eventId: 2, startedAt: Number.NaN }),
          null as unknown as DdrrRow,
          predictionRow({ eventId: 3, stablecoinId: undefined }),
        ],
        null,
      ),
      COIN,
    )!;

    expect(record.reviewedForecastCount).toBe(1);
    expect(record.incidents).toHaveLength(1);
    expect(record.reviewedAt).toBeNull();
    expect(record.publicWarning).toBe(DDRR_PUBLIC_WARNING);
  });
});
