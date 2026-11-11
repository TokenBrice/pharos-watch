import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { withSqliteD1, insertLiveEvent, sealPublicFixture, insertPredictionErratum } from "./depeg-resolver-ddrv2-store.test-support";
import { ensureCanonicalIncidents } from "../depeg-resolver/depeg-resolver-incident-store";
import {
  DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
  DDR_METHODOLOGY_CHANGELOG_PATH,
  DDR_METHODOLOGY_VERSION,
  DDR_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/depeg-resolver";
import { summarizeDdrrRows } from "@shared/lib/depeg-resolver-review";
import { MethodologyEnvelopeSchema } from "@shared/types/methodology-envelope";
import { DdrrResponseOpenApiSchema, type DdrrRow } from "@shared/types/depeg-resolver-review";
import { loadPredictionErrata, type LoadPredictionErrataFilters } from "../depeg-resolver/depeg-resolver-errata-store";
import { buildDdrMethodologyEnvelope } from "../depeg-resolver/depeg-resolver-methodology";
import { buildDdrrResponseEnvelope } from "../depeg-resolver/depeg-resolver-review-response";
import { assertHash, assertLockMetadata, assertNonEmpty, assertNonNegativeInteger, assertPositiveInteger } from "../depeg-resolver/depeg-resolver-store-validators";

describe("DDR store input rejection", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid positive integer %s before persistence", (value) => {
      expect(() => assertPositiveInteger(value, "eventId")).toThrow("eventId must be a positive safe integer");
    },
  );
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid non-negative integer %s", (value) => {
    expect(() => assertNonNegativeInteger(value, "deferrals")).toThrow("deferrals must be a non-negative safe integer");
  });
  it("rejects blank identities and non-canonical hashes", () => {
    expect(() => assertNonEmpty(" \n ", "runId")).toThrow("runId must be non-empty");
    for (const hash of ["a".repeat(63), "A".repeat(64), "g".repeat(64)]) {
      expect(() => assertHash(hash, "featureHash")).toThrow("featureHash must be a 64-character lowercase hex hash");
    }
  });
  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid readiness score %s", (score) => {
    expect(() => assertLockMetadata({ forecastReadinessScore: score })).toThrow("forecastReadinessScore");
    expect(() => assertLockMetadata({ readinessThreshold: score })).toThrow("readinessThreshold");
  });
  it("rejects incomplete readiness locks rather than persisting optimistic eligibility", () => {
    expect(() => assertLockMetadata({ lockTrigger: "forecast_readiness" })).toThrow("requires forecastReadinessScore");
    expect(() => assertLockMetadata({ lockTrigger: "forecast_readiness", forecastReadinessScore: 0.7 })).toThrow("requires forecastReadinessVersion");
    expect(() => assertLockMetadata({ lockTrigger: "forecast_readiness", forecastReadinessScore: 0.7, forecastReadinessVersion: "v1" })).toThrow("requires readinessThreshold");
  });
  it("requires the complete reviewed backstop window", () => {
    expect(() => assertLockMetadata({ lockTrigger: "readiness_backstop" })).toThrow("requires backstopAt");
    expect(() => assertLockMetadata({ lockTrigger: "readiness_backstop", backstopAt: 123 })).toThrow("requires backstopDelaySec");
    expect(() => assertLockMetadata({ lockTrigger: "readiness_backstop", backstopAt: 123, backstopDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC - 1 })).toThrow("readiness-72h backstop delay");
  });
});
const ERRATUM_ROW = {
  id: 9,
  public_prediction_id: 77,
  incident_key: "ddr:usdc:below",
  event_id: 42,
  assessment_id: 101,
  reason: "input_corruption",
  operator_note: "invalid source payload",
  replacement_assessment_id: 102,
  replacement_row_hash: "b".repeat(64),
  row_hash_before: "a".repeat(64),
  created_at: 1_800_000_000,
  created_by: "operator",
};

function errataDb() {
  return mockD1([{ match: "FROM depeg_resolver_prediction_errata", rows: [ERRATUM_ROW] }]);
}

describe("loadPredictionErrata", () => {
  it.each(["publicPredictionIds", "incidentKeys", "eventIds"] as const)(
    "filters %s with repeated identities without duplicate or unrelated errata", async (filter) => withSqliteD1(async (db) => {
      const identities = [];
      for (const [eventId, stablecoinId] of [[1, "lusd-liquity"], [2, "usdc-circle"]] as const) {
        insertLiveEvent(db, { eventId, stablecoinId, startedAt: 100000 });
        const [incident] = await ensureCanonicalIncidents(db, [{
          eventId, stablecoinId, pegCurrency: "USD", direction: "below", startedAt: 100000,
          peakDeviationBps: -300, source: "live",
        }], { nowSec: 200000, predictionPolicyVersion: "sticky-24h-v1", ddrV2EffectiveAt: 90000, createdBy: "vitest" });
        const prediction = await sealPublicFixture(db, incident!.incidentKey, "prediction", {
          payload: { eventId, stablecoinId },
        });
        insertPredictionErratum(db, {
          publicPredictionId: prediction.id, incidentKey: incident!.incidentKey, eventId,
          assessmentId: prediction.assessmentId, reason: "input_corruption", operatorNote: "invalid source payload",
          createdAt: 200001, createdBy: "operator",
        });
        identities.push({ publicPredictionIds: prediction.id, incidentKeys: incident!.incidentKey, eventIds: eventId });
      }
      const identity = identities[0]![filter];
      const absent = filter === "incidentKeys" ? "missing" : 999;
      const rows = await loadPredictionErrata(db, { [filter]: [...Array.from({ length: 101 }, () => identity), absent] });
      expect(rows.map(({ id, publicPredictionId, incidentKey, eventId, state }) => ({
        id, publicPredictionId, incidentKey, eventId, state,
      }))).toEqual([{
        id: 1, publicPredictionId: 1, incidentKey: identities[0]!.incidentKeys, eventId: 1, state: "invalidated",
      }]);
    }),
  );

  it.each([
    { publicPredictionIds: [] },
    { incidentKeys: [] },
    { eventIds: [] },
  ] as LoadPredictionErrataFilters[])("returns without querying for an empty filter", async (filters) => {
    const db = errataDb();

    await expect(loadPredictionErrata(db, filters)).resolves.toEqual([]);
    expect(db.getHistory()).toHaveLength(0);
  });

  it("reads every erratum without a filter and marks each one invalidated", async () => {
    const db = errataDb();

    await expect(loadPredictionErrata(db, {})).resolves.toEqual([{
      state: "invalidated",
      id: 9,
      publicPredictionId: 77,
      incidentKey: "ddr:usdc:below",
      eventId: 42,
      assessmentId: 101,
      reason: "input_corruption",
      operatorNote: "invalid source payload",
      replacementAssessmentId: 102,
      replacementRowHash: "b".repeat(64),
      rowHashBefore: "a".repeat(64),
      createdAt: 1_800_000_000,
      createdBy: "operator",
    }]);
    expect(db.getHistory()[0]?.sql).not.toContain("WHERE");
  });
});
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

describe("buildDdrMethodologyEnvelope", () => {
  it.each([0, 1_780_358_400])("publishes a current schema-valid DDR envelope at asOf=%s", (asOf) => {
    const response = buildDdrMethodologyEnvelope(asOf);
    expect(MethodologyEnvelopeSchema.parse(response)).toEqual({
      version: DDR_METHODOLOGY_VERSION,
      versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      currentVersion: DDR_METHODOLOGY_VERSION,
      currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      changelogPath: DDR_METHODOLOGY_CHANGELOG_PATH,
      asOf,
      isCurrent: true,
    });
  });

  it("does not overwrite the caller's observation clock or leak mutation between responses", () => {
    const old = buildDdrMethodologyEnvelope(1_700_000_000);
    old.version = "caller-mutated";
    const current = buildDdrMethodologyEnvelope(1_780_358_400);
    expect(current.version).toBe(DDR_METHODOLOGY_VERSION);
    expect(current.asOf).toBe(1_780_358_400);
    expect(old.asOf).toBe(1_700_000_000);
  });
});
