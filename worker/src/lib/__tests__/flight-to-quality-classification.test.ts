import { describe, expect, it } from "vitest";
import {
  buildFlightToQualityClassification,
  buildFlightToQualityClassificationFromV9Snapshot,
} from "../flight-to-quality-classification";
import type { ReportCardCachePayload } from "../report-card-cache";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v8/evaluation-build-manifest-v1";
import { makeWorkerReportCardsV9Response, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../safety-score-v9-consumer-freshness";

function reportCardCache(scores: ReportCardCachePayload["scores"]): ReportCardCachePayload {
  return {
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    scores,
    updatedAt: 1,
    safetyScoreIdentity: {
      model: "v8",
      schemaVersion: 1,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      evaluationBuildDigest: SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST,
      baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
      publicationGenerationId: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:1`,
    },
  };
}

describe("buildFlightToQualityClassification", () => {
  it("uses report-card grade boundaries for safe and risky classifications", () => {
    const result = buildFlightToQualityClassification({ ...reportCardCache({
      "usdc-circle": { score: 65, grade: "B-" },
      "usdt-tether": { score: 49, grade: "D" },
      "dai-makerdao": { score: 50, grade: "C-" },
      "untracked-token": { score: 90, grade: "A+" },
    }), identityComplete: true });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("Expected complete Safety Score identity");
    const { classification } = result;
    expect(classification.safeIds).toEqual(new Set(["usdc-circle"]));
    expect(classification.riskyIds).toEqual(new Set(["usdt-tether"]));
    expect(classification.safetyScoreIdentity.model).toBe("v8");
  });

  it("fails closed when the cache has no Safety Score identity", () => {
    const payload = reportCardCache({});
    delete payload.safetyScoreIdentity;

    expect(buildFlightToQualityClassification({ ...payload, identityComplete: true })).toEqual({
      kind: "unavailable",
      reason: "identity-missing",
    });
  });

  it("uses V9 grades without projecting V8 numeric score thresholds", () => {
    const result = buildFlightToQualityClassification({
      identityComplete: true,
      safetyScoreIdentity: {
        model: "v9",
        schemaVersion: 1,
        methodologyVersion: "9.0",
        policyId: "safety-score-v9",
        policyDigest: "c".repeat(64),
        evaluationBuildDigest: "d".repeat(64),
        baseInputGenerationId: `report-cards-input:v1:${"e".repeat(64)}`,
        publicationGenerationId: "report-cards:v9:1",
      },
      scores: {
        "usdc-circle": { score: 1, grade: "B-" },
        "usdt-tether": { score: 100, grade: "C+" },
        "dai-makerdao": { score: 99, grade: "C" },
        "frax": { score: 98, grade: "C-" },
        "usde-ethena": { score: 99, grade: "D" },
      },
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("Expected complete V9 identity");
    expect(result.classification.safeIds).toEqual(new Set(["usdc-circle"]));
    expect(result.classification.riskyIds).toEqual(new Set(["usde-ethena"]));
    expect(result.classification.safetyScoreIdentity.model).toBe("v9");
  });

  it("fails closed for incomplete or mismatched identities", () => {
    const payload = reportCardCache({ "usdc-circle": { score: 65, grade: "B-" } });
    expect(buildFlightToQualityClassification({ ...payload, identityComplete: false })).toEqual({
      kind: "unavailable",
      reason: "identity-incomplete",
    });
    expect(buildFlightToQualityClassification({
      ...payload,
      identityComplete: true,
      expectedIdentity: { ...payload.safetyScoreIdentity!, publicationGenerationId: "report-cards:other" },
    })).toEqual({
      kind: "unavailable",
      reason: "identity-mismatch",
    });
  });

  it("requires an explicit shadow-lifecycle opt-in and complete V9 snapshot", () => {
    const snapshot = makeWorkerReportCardsV9Response({
      cards: [makeWorkerV9Card()],
      updatedAt: Math.floor(Date.now() / 1000),
    });

    expect(buildFlightToQualityClassificationFromV9Snapshot(snapshot, { allowShadowLifecycle: false })).toEqual({
      kind: "unavailable",
      reason: "lifecycle-not-approved",
    });
    const result = buildFlightToQualityClassificationFromV9Snapshot(snapshot, { allowShadowLifecycle: true });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("Expected explicit V9 shadow classification");
    expect(result.classification.safeIds).toEqual(new Set(["usdc-circle"]));

    expect(buildFlightToQualityClassificationFromV9Snapshot(
      { ...snapshot, completeness: { ...snapshot.completeness, expectedCount: 2 } },
      { allowShadowLifecycle: true },
    )).toEqual({ kind: "unavailable", reason: "source-contract-invalid" });

    expect(buildFlightToQualityClassificationFromV9Snapshot(
      {
        ...snapshot,
        publicationHealth: {
          ...snapshot.publicationHealth,
          status: "held",
          attemptedAtSec: snapshot.updatedAt + 1_800,
          heldSinceSec: snapshot.updatedAt + 1_800,
          reasons: [{ code: "dex-stale" }],
        },
      },
      { allowShadowLifecycle: true },
    )).toEqual({ kind: "unavailable", reason: "publication-held" });
  });

  it("fails closed for a stale current V9 snapshot", () => {
    const snapshot = makeWorkerReportCardsV9Response({
      updatedAt: Math.floor(Date.now() / 1000) - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC - 1,
    });

    expect(buildFlightToQualityClassificationFromV9Snapshot(
      snapshot,
      { allowShadowLifecycle: true },
    )).toEqual({ kind: "unavailable", reason: "source-stale" });
  });
});
