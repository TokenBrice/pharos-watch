import { describe, expect, it, vi } from "vitest";
import { summarizeDdrrRows } from "@shared/lib/depeg-resolver-review";
import type {
  DdrrResponse,
  DdrrRow,
  DdrrV2PredictionReviewRow,
} from "@shared/types/depeg-resolver-review";
import {
  buildDdrrCalibrationReport,
  isTrustedDdrrApiKeyDestination,
  runCli,
} from "../maintenance/generate-ddrr-calibration-report";

const STARTED_AT = 1_780_000_000;
const LOCKED_AT = STARTED_AT + 72 * 3600;

function horizonCell() {
  return {
    horizon: "24h" as const,
    state: "benchmarked" as const,
    probability: 0.6,
    probabilityDisplay: "60%",
    probabilityInterval: { lower: 0.5, upper: 0.7 },
    rawAtRisk: 20,
    uniqueCoins: 10,
    intervalClosures: 12,
    intervalNonClosures: 8,
  };
}

function horizonReview() {
  return {
    horizon: "24h" as const,
    horizonSec: 24 * 3600,
    result: "hit" as const,
    horizonElapsed: true,
    resolvedWithinHorizon: true,
    sourceCellState: "benchmarked" as const,
    probability: 0.6,
    probabilityDisplay: "60%",
    probabilityInterval: { lower: 0.5, upper: 0.7 },
  };
}

function baseRow(overrides: Partial<DdrrRow> = {}) {
  return {
    eventId: 1,
    currentEventId: 1,
    incidentKey: "ddr2:fixture",
    stablecoinId: "fixture-usd",
    symbol: "FXD",
    name: "Fixture USD",
    pegCurrency: "USD",
    governance: "centralized",
    direction: "below" as const,
    startedAt: STARTED_AT,
    eligibleAt: STARTED_AT + 72 * 3600,
    sourceEventState: "recovered" as const,
    terminalEvidenceAt: null,
    terminalEvidenceInterval: null,
    terminalEvidencePrecision: null,
    ...overrides,
  };
}

function prediction(overrides: Partial<DdrrV2PredictionReviewRow> = {}): DdrrV2PredictionReviewRow {
  return {
    ...baseRow(),
    kind: "prediction_review",
    publicPredictionId: 101,
    assessmentId: 201,
    predictionState: "frozen",
    predictionMethodologyVersion: "3.03",
    predictionPolicyVersion: "sticky-24h-v1",
    lockedAt: LOCKED_AT,
    publishedAt: LOCKED_AT,
    publicationSnapshotToken: "snapshot-fixture",
    frozen: {
      resolutionTier: "recovery_unlikely",
      predictedRemainingSec: 48 * 3600,
      iqrRemainingSec: [24 * 3600, 72 * 3600],
      horizonCells: [horizonCell()],
      stratum: "below · minor · fragile · USD",
      factors: [
        {
          code: "K2_backing_impairment",
          kind: "kill",
          severity: "severe",
          label: "Very-high-risk reserves paired with a severe below-peg break",
        },
        {
          code: "K5_exit_collapse",
          kind: "kill",
          severity: "elevated",
          label: "Thin exit liquidity",
        },
      ],
    },
    actual: {
      kind: "recovered",
      actualEndedAt: LOCKED_AT + 12 * 3600,
      actualRemainingSec: 12 * 3600,
      terminalEvidenceAt: null,
      terminalEvidenceInterval: null,
      terminalEvidencePrecision: null,
      reviewedAt: LOCKED_AT + 24 * 3600,
    },
    verdictReview: "false_terminal",
    durationReview: "faster_than_band",
    horizonReviews: [horizonReview()],
    predictedRemainingSec: 48 * 3600,
    actualRemainingSec: 12 * 3600,
    signedDurationErrorSec: -36 * 3600,
    absoluteDurationErrorSec: 36 * 3600,
    medianReview: "median_early_by",
    withinIqr: false,
    ...overrides,
  };
}

function response(rows: DdrrRow[]): DdrrResponse {
  return {
    _meta: {
      computedAt: LOCKED_AT + 24 * 3600,
      expiresAt: LOCKED_AT + 25 * 3600,
      degraded: false,
      degradedReason: null,
      reviewerVersion: "ddr-reviewer-v3",
      publicWarning: "fixture",
      assessedEventCount: rows.length,
      reviewedEventCount: rows.length,
      pendingEventCount: 0,
      durationScoredCount: rows.filter((row) => row.kind === "prediction_review" && row.signedDurationErrorSec != null)
        .length,
      verdictScoredCount: rows.filter((row) => row.kind === "prediction_review").length,
      assessmentRowLimit: 20_000,
      assessmentRowsTruncated: false,
      incidentRowLimit: 20_000,
      incidentRowsTruncated: false,
      publicRowLimit: 100,
      publicRowsTruncated: false,
      methodologyVersions: ["3.03"],
    },
    summary: summarizeDdrrRows(rows),
    rows,
    methodology: {
      version: "3.03",
      versionLabel: "v3.03",
      currentVersion: "3.03",
      currentVersionLabel: "v3.03",
      changelogPath: "/methodology/depeg-resolver-changelog/",
      asOf: LOCKED_AT,
      isCurrent: true,
    },
  };
}

describe("generate-ddrr-calibration-report", () => {
  it("requires both row and independent-coin support before recommending a retune", () => {
    for (const [rows, coins, recommendation] of [[49, 20, "hold"], [50, 19, "hold"], [50, 20, "candidate"]] as const) {
      const report = buildDdrrCalibrationReport(response(Array.from({ length: rows }, (_, i) =>
        prediction({ stablecoinId: `coin-${i % coins}` }))), { generatedAt: "fixture", source: { mode: "input", detail: "fixture" } });
      expect(report.durationCalibration.overall).toMatchObject({ rowCount: rows, coinCount: coins, recommendation });
    }
  });

  it.each([
    [true, false, ["degraded-snapshot"]],
    [false, true, ["truncated-population"]],
    [true, true, ["degraded-snapshot", "truncated-population"]],
  ] as const)("holds a sufficient but incomplete population (%s/%s)", (degraded, truncated, reasons) => {
    const payload = response(Array.from({ length: 50 }, (_, index) => prediction({ stablecoinId: `coin-${index % 20}` })));
    payload._meta.degraded = degraded;
    payload._meta.publicRowsTruncated = truncated;
    const report = buildDdrrCalibrationReport(payload, { generatedAt: "fixture", source: { mode: "input", detail: "fixture" } });
    expect(report.durationCalibration.populationEligible).toBe(false);
    expect(report.durationCalibration.populationIneligibilityReasons).toEqual(reasons);
    for (const segment of [report.durationCalibration.overall, ...report.durationCalibration.byStratum, ...report.durationCalibration.byDirection]) {
      expect(segment.recommendation).toBe("hold");
    }
    expect(report.recommendations[0]!.severity).toBe("hold");
  });

  it("keeps signed bias boundaries and empty scored samples distinct", () => {
    for (const [error, bias] of [[-3600, "too_slow"], [-3599, "balanced"], [3599, "balanced"], [3600, "too_fast"]] as const) {
      const report = buildDdrrCalibrationReport(response([prediction({ signedDurationErrorSec: error, absoluteDurationErrorSec: Math.abs(error) })]),
        { generatedAt: "fixture", source: { mode: "input", detail: "fixture" } });
      expect(report.durationCalibration.overall).toMatchObject({ bias, medianSignedErrorSec: error });
    }
    const empty = buildDdrrCalibrationReport(response([prediction({ signedDurationErrorSec: null, absoluteDurationErrorSec: null })]),
      { generatedAt: "fixture", source: { mode: "input", detail: "fixture" } });
    expect(empty.durationCalibration.overall).toMatchObject({ rowCount: 0, bias: "insufficient_data", meanSignedErrorSec: null, recommendation: "hold" });
  });

  it("warns on degraded and truncated snapshots and excludes invalidated publications", () => {
    const erratum = { id: 1, state: "invalidated" as const, publicPredictionId: 103, incidentKey: "invalidated",
      eventId: 4, assessmentId: 203, reason: "false_positive" as const, createdAt: LOCKED_AT,
      operatorNote: "reviewed", rowHashBefore: null, replacementAssessmentId: null, replacementRowHash: null, createdBy: "reviewer" };
    const payload = response([prediction(), { ...baseRow(), kind: "invalidated_prediction", publicPredictionId: 103,
      assessmentId: 203, predictionState: "invalidated", predictionMethodologyVersion: "3.03", predictionPolicyVersion: "sticky-24h-v1",
      lockedAt: LOCKED_AT, publishedAt: LOCKED_AT, publicationSnapshotToken: "fixture", originalKind: "no_call",
      originalOutcome: { lockedAt: LOCKED_AT, eventAgeAtLockSec: 72 * 3600, missingReasons: ["missing"],
        relatedContext: { dewsBand: null, dewsScore: null, liquidityScore: null, safetyGrade: null, safetyScore: null,
          supplyChange7dPct: null, supplyChange30dPct: null, mintSurge: null } },
      latestErratum: erratum, errataCount: 1, errataHistory: [erratum] }]);
    payload._meta.degraded = true;
    payload._meta.degradedReason = "upstream unavailable";
    payload._meta.publicRowsTruncated = true;
    const report = buildDdrrCalibrationReport(payload, { generatedAt: "fixture", source: { mode: "input", detail: "fixture" } });
    expect(report.sample).toMatchObject({ rowCount: 2, predictionReviewCount: 1, invalidatedPredictionCount: 1 });
    expect(report.durationCalibration.overall.rowCount).toBe(1);
    expect(report.warnings).toHaveLength(2);
    expect(report.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/degraded.*upstream unavailable/), expect.stringMatching(/truncated/)]));
  });

  it("only sends environment API keys to trusted api-base origins", async () => {
    expect(isTrustedDdrrApiKeyDestination("https://api.pharos.watch")).toBe(true);
    expect(isTrustedDdrrApiKeyDestination("http://127.0.0.1:8787")).toBe(true);
    expect(isTrustedDdrrApiKeyDestination("https://api.example.test")).toBe(false);

    const originalPharosApiKey = process.env.PHAROS_API_KEY;
    const payload = response([prediction()]);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ payload }), { status: 200 }));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      process.env.PHAROS_API_KEY = "ddrr-fixture-value";
      await expect(
        runCli(
          [
            "--api-base",
            "https://api.example.test",
            "--json",
            "--stdout",
            "--generated-at",
            "2026-06-29T00:00:00.000Z",
          ],
          process.cwd(),
          fetchMock as unknown as typeof fetch,
        ),
      ).resolves.toBe(0);
    } finally {
      if (originalPharosApiKey === undefined) {
        delete process.env.PHAROS_API_KEY;
      } else {
        process.env.PHAROS_API_KEY = originalPharosApiKey;
      }
      stdout.mockRestore();
    }

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/depeg-resolver-review",
      expect.objectContaining({
        headers: expect.not.objectContaining({ "X-API-Key": "ddrr-fixture-value" }),
      }),
    );
  });
});
