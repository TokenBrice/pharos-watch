import { describe, expect, it } from "vitest";
import { summarizeDdrrRows } from "@shared/lib/depeg-resolver-review";
import { DdrrResponseOpenApiSchema, type DdrrRow } from "@shared/types/depeg-resolver-review";
import { buildDdrrResponseEnvelope } from "../depeg-resolver-review-response";

function prediction(index: number, stablecoinId = "lusd-liquity"): DdrrRow {
  const error = index < 200 ? 3600 : 10_800;
  return {
    kind: "prediction_review", eventId: index + 1, currentEventId: index + 1,
    incidentKey: `${stablecoinId}:below:${index}`, stablecoinId, symbol: "LUSD", name: "Liquity USD",
    pegCurrency: "USD", governance: "decentralized", direction: "below", startedAt: index + 1,
    eligibleAt: index + 1, sourceEventState: "recovered", terminalEvidenceAt: null,
    terminalEvidenceInterval: null, terminalEvidencePrecision: null, publicPredictionId: index + 1,
    assessmentId: index + 1, predictionState: "frozen", predictionMethodologyVersion: "4.0",
    predictionPolicyVersion: "sticky-24h-v1", lockedAt: index + 2, publishedAt: index + 3,
    publicationSnapshotToken: "snapshot-1",
    frozen: { resolutionTier: "recovery_likely", predictedRemainingSec: 3600,
      iqrRemainingSec: [1800, 7200], horizonCells: [], stratum: null, factors: [] },
    actual: { kind: "recovered", actualEndedAt: 20_000, actualRemainingSec: 7200,
      terminalEvidenceAt: null, terminalEvidenceInterval: null, terminalEvidencePrecision: null, reviewedAt: 20_001 },
    verdictReview: index === 400 ? "false_terminal" : "correct_recoverable",
    durationReview: "inside_band", horizonReviews: [], predictedRemainingSec: 3600,
    actualRemainingSec: 7200, medianReview: "median_late_by", signedDurationErrorSec: error,
    absoluteDurationErrorSec: error, withinIqr: index !== 400,
  };
}

function envelope(rows: DdrrRow[]) {
  return buildDdrrResponseEnvelope({
    nowSec: 30_000, summary: summarizeDdrrRows(rows), rows,
    assessedEventCount: rows.length, methodologyVersions: ["4.0"],
  });
}

describe("DDRR authoritative summaries and browse samples", () => {
  it("includes the cap-plus-one missed verdict and changed median in the producer coin summary", () => {
    const rows = Array.from({ length: 401 }, (_, index) => prediction(index));
    const response = envelope(rows);
    expect(response.rows).toHaveLength(400);
    expect(response._meta).toMatchObject({ computedAt: 30_000, reviewedEventCount: 401,
      publicRowLimit: 400, publicRowsTruncated: true });
    expect(response.summary.byStablecoin).toEqual([expect.objectContaining({
      stablecoinId: "lusd-liquity", reviewedRowCount: 401, reviewedForecastCount: 401,
      scoredCount: 401, correctCount: 400, missCount: 1, durationScoredCount: 401,
      medianAbsoluteDurationErrorSec: 10_800,
    })]);
    expect(summarizeDdrrRows(response.rows).byStablecoin?.[0].medianAbsoluteDurationErrorSec).toBe(7200);
    expect(DdrrResponseOpenApiSchema.safeParse(response).success).toBe(true);
  });

  it("publishes a coin summary even when every row for that coin falls outside the display cap", () => {
    const response = envelope([...Array.from({ length: 400 }, (_, index) => prediction(index)),
      prediction(400, "usdc-circle")]);
    expect(response.rows.every((row) => row.stablecoinId === "lusd-liquity")).toBe(true);
    expect(response.summary.byStablecoin).toContainEqual(expect.objectContaining({
      stablecoinId: "usdc-circle", reviewedRowCount: 1, reviewedForecastCount: 1,
      scoredCount: 1, correctCount: 0, missCount: 1,
    }));
  });
});
