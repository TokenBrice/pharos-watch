import { describe, expect, it } from "vitest";
import type { DdrHorizon, DdrHorizonCell } from "../../../types/depeg-resolver";
import {
  DdrrRowSchema,
  type DdrrActualEventInput,
  type DdrrAssessmentInput,
} from "../index";
import {
  reviewDepegResolverAssessment,
  reviewDepegResolverAssessments,
  summarizeDdrrRows,
} from "../index";

const ASSESSED_AT = 100_000;
const STARTED_AT = 90_000;

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
    stablecoinId: "fixture-usd",
    symbol: "FXUSD",
    name: "Fixture USD",
    pegCurrency: "USD",
    governance: "decentralized",
    direction: "below",
    startedAt: STARTED_AT,
    assessedAt: ASSESSED_AT,
    eventAgeSec: ASSESSED_AT - STARTED_AT,
    checkpoint: "first",
    methodologyVersion: "v1.0",
    resolutionTier: "recovery_likely",
    durationSuppressed: false,
    durationSuppressedReason: null,
    predictedRemainingSec: 3_600,
    iqrRemainingSec: [1_800, 7_200],
    horizonCells: [
      horizonCell("6h"),
      horizonCell("24h"),
      horizonCell("7d"),
      horizonCell("30d"),
    ],
    stratum: "below - moderate - robust - USD",
    factors: [],
    ...overrides,
  };
}

function actualEvent(overrides: Partial<DdrrActualEventInput> = {}): DdrrActualEventInput {
  return {
    eventId: 1,
    startedAt: STARTED_AT,
    endedAt: ASSESSED_AT + 3_600,
    recoveryPrice: 1,
    stablecoinStatus: "active",
    terminalObserved: null,
    ...overrides,
  };
}

function reviewed(
  assessmentOverrides: Partial<DdrrAssessmentInput>,
  eventOverrides: Partial<DdrrActualEventInput> | null,
  nowSec = ASSESSED_AT + 10_000,
) {
  const a = assessment(assessmentOverrides);
  return reviewDepegResolverAssessment(a, eventOverrides == null ? null : actualEvent({ eventId: a.eventId, ...eventOverrides }), nowSec);
}

describe("DDRR verdict review", () => {
  it("classifies recovered, terminal, pending, and data issue cases", () => {
    expect(reviewed({ resolutionTier: "recovery_likely" }, { endedAt: ASSESSED_AT + 100, recoveryPrice: 1 }).verdictReview).toBe(
      "correct_recoverable",
    );
    expect(reviewed({ resolutionTier: "at_risk" }, { endedAt: ASSESSED_AT + 100, recoveryPrice: 1 }).verdictReview).toBe(
      "correct_recoverable",
    );
    expect(reviewed({ resolutionTier: "recovery_unlikely" }, { endedAt: ASSESSED_AT + 100, recoveryPrice: 1 }).verdictReview).toBe(
      "false_terminal",
    );
    expect(reviewed({ resolutionTier: "recovery_unlikely" }, { endedAt: null, recoveryPrice: null, stablecoinStatus: "frozen" }).verdictReview).toBe(
      "correct_terminal",
    );
    expect(reviewed({ resolutionTier: "recovery_likely" }, { endedAt: null, recoveryPrice: null, stablecoinStatus: "frozen" }).verdictReview).toBe(
      "false_recoverable",
    );
    expect(reviewed({ resolutionTier: "at_risk" }, { endedAt: null, recoveryPrice: null, stablecoinStatus: "frozen" }).verdictReview).toBe(
      "risk_noted_terminal",
    );
    expect(reviewed({ resolutionTier: "insufficient_signal" }, { endedAt: ASSESSED_AT + 100, recoveryPrice: 1 }).verdictReview).toBe(
      "unscored_insufficient_signal",
    );
    expect(reviewed({ resolutionTier: "recovery_likely" }, { endedAt: null, recoveryPrice: null }).verdictReview).toBe("pending");

    const orphan = reviewed({ resolutionTier: "recovery_likely" }, { endedAt: ASSESSED_AT + 100, recoveryPrice: null });
    expect(orphan.actualOutcome).toBe("orphan_closed");
    expect(orphan.verdictReview).toBe("data_issue");

    const missing = reviewed({ resolutionTier: "recovery_likely" }, null);
    expect(missing.actualOutcome).toBe("source_event_missing");
    expect(missing.verdictReview).toBe("data_issue");
  });

  it("marks impossible recovered timing as a data issue", () => {
    const row = reviewed({ resolutionTier: "recovery_likely" }, { endedAt: ASSESSED_AT - 1, recoveryPrice: 1 });

    expect(row.actualOutcome).toBe("data_issue");
    expect(row.verdictReview).toBe("data_issue");
    expect(row.durationReview).toBe("data_issue");
    expect(row.actualRemainingSec).toBeNull();
  });
});

describe("DDRR duration review", () => {
  it("computes signed duration error and IQR classifications", () => {
    const inside = reviewed({ predictedRemainingSec: 3_600, iqrRemainingSec: [1_800, 7_200] }, { endedAt: ASSESSED_AT + 4_000, recoveryPrice: 1 });
    expect(inside.durationReview).toBe("inside_band");
    expect(inside.medianReview).toBe("median_late_by");
    expect(inside.signedErrorSec).toBe(400);
    expect(inside.absoluteErrorSec).toBe(400);
    expect(inside.withinIqr).toBe(true);

    const faster = reviewed({ predictedRemainingSec: 3_600, iqrRemainingSec: [1_800, 7_200] }, { endedAt: ASSESSED_AT + 1_000, recoveryPrice: 1 });
    expect(faster.durationReview).toBe("faster_than_band");
    expect(faster.medianReview).toBe("median_early_by");
    expect(faster.signedErrorSec).toBe(-2_600);
    expect(faster.withinIqr).toBe(false);

    const slower = reviewed({ predictedRemainingSec: 3_600, iqrRemainingSec: [1_800, 7_200] }, { endedAt: ASSESSED_AT + 9_000, recoveryPrice: 1 });
    expect(slower.durationReview).toBe("slower_than_band");
    expect(slower.medianReview).toBe("median_late_by");
    expect(slower.signedErrorSec).toBe(5_400);
    expect(slower.withinIqr).toBe(false);
  });

  it("aggregates average signed and absolute duration error", () => {
    const rows = [
      reviewed({ eventId: 1, predictedRemainingSec: 3_600 }, { eventId: 1, endedAt: ASSESSED_AT + 7_200, recoveryPrice: 1 }),
      reviewed({ eventId: 2, predictedRemainingSec: 3_600 }, { eventId: 2, endedAt: ASSESSED_AT + 1_800, recoveryPrice: 1 }),
    ];

    const summary = summarizeDdrrRows(rows);
    expect(summary.durationScoredCount).toBe(2);
    expect(summary.averageSignedDurationErrorSec).toBe(900);
    expect(summary.averageAbsoluteDurationErrorSec).toBe(2_700);
    expect(summary.medianAbsoluteErrorSec).toBe(2_700);
    expect(summary.withinIqrCount).toBe(2);
    expect(summary.iqrScoredCount).toBe(2);
  });
});

describe("DDRR headline stats", () => {
  it("counts strict recovery-likelihood accuracy and excludes unscored rows", () => {
    const assessments = [
      assessment({ eventId: 1, resolutionTier: "recovery_likely" }),
      assessment({ eventId: 2, resolutionTier: "recovery_unlikely" }),
      assessment({ eventId: 3, resolutionTier: "recovery_unlikely" }),
      assessment({ eventId: 4, resolutionTier: "recovery_likely" }),
      assessment({ eventId: 5, resolutionTier: "at_risk" }),
      assessment({ eventId: 6, resolutionTier: "recovery_likely" }),
      assessment({ eventId: 7, resolutionTier: "insufficient_signal", durationSuppressed: true, predictedRemainingSec: null }),
      assessment({ eventId: 8, resolutionTier: "recovery_likely" }),
    ];
    const { summary } = reviewDepegResolverAssessments({
      assessments,
      actualEventsById: new Map([
        [1, actualEvent({ eventId: 1, endedAt: ASSESSED_AT + 100, recoveryPrice: 1 })],
        [2, actualEvent({ eventId: 2, endedAt: null, recoveryPrice: null, stablecoinStatus: "frozen" })],
        [3, actualEvent({ eventId: 3, endedAt: ASSESSED_AT + 100, recoveryPrice: 1 })],
        [4, actualEvent({ eventId: 4, endedAt: null, recoveryPrice: null, stablecoinStatus: "frozen" })],
        [5, actualEvent({ eventId: 5, endedAt: null, recoveryPrice: null, stablecoinStatus: "frozen" })],
        [6, actualEvent({ eventId: 6, endedAt: null, recoveryPrice: null })],
        [7, actualEvent({ eventId: 7, endedAt: ASSESSED_AT + 100, recoveryPrice: 1 })],
        [8, actualEvent({ eventId: 8, endedAt: ASSESSED_AT + 100, recoveryPrice: null })],
      ]),
      nowSec: ASSESSED_AT + 1_000,
    });

    expect(summary.correctRecoverable).toBe(1);
    expect(summary.correctTerminal).toBe(1);
    expect(summary.falseTerminal).toBe(1);
    expect(summary.falseRecoverable).toBe(1);
    expect(summary.riskNotedTerminal).toBe(1);
    expect(summary.pending).toBe(1);
    expect(summary.unscoredInsufficientSignal).toBe(1);
    expect(summary.dataIssue).toBe(1);
    expect(summary.recoveryLikelihoodCorrectCount).toBe(2);
    expect(summary.recoveryLikelihoodScoredCount).toBe(5);
    expect(summary.recoveryLikelihoodAccuracyPct).toBe(0.4);
    expect(summary.verdictScoredCount).toBe(5);
  });
});

describe("DDRR horizon review", () => {
  it("marks hit, miss, pending, and unscored horizon states", () => {
    const open = reviewed(
      {
        horizonCells: [
          horizonCell("6h"),
          horizonCell("24h"),
          horizonCell("7d"),
          horizonCell("30d", { state: "unsupported", probability: null, probabilityDisplay: null, probabilityInterval: null }),
        ],
      },
      { endedAt: null, recoveryPrice: null },
      ASSESSED_AT + 7 * 3_600,
    );

    expect(open.horizonReviews.map((h) => [h.horizon, h.result])).toEqual([
      ["6h", "miss"],
      ["24h", "pending"],
      ["7d", "pending"],
      ["30d", "unscored"],
    ]);

    const recovered = reviewed(
      { eventId: 2, horizonCells: [horizonCell("6h"), horizonCell("24h"), horizonCell("7d"), horizonCell("30d")] },
      { eventId: 2, endedAt: ASSESSED_AT + 5 * 3_600, recoveryPrice: 1 },
      ASSESSED_AT + 5 * 3_600,
    );

    expect(recovered.horizonReviews.find((h) => h.horizon === "6h")?.result).toBe("hit");

    const summary = summarizeDdrrRows([open, recovered]);
    expect(summary.horizonHitRates.find((h) => h.horizon === "6h")).toEqual({
      horizon: "6h",
      scored: 2,
      hits: 1,
      misses: 1,
      hitRate: 0.5,
    });
  });

  it("returns rows that satisfy the public schema", () => {
    const row = reviewed({}, { endedAt: ASSESSED_AT + 4_000, recoveryPrice: 1 });

    expect(DdrrRowSchema.parse(row)).toEqual(row);
  });
});
