import { describe, expect, it } from "vitest";
import { buildFlightToQualityClassification } from "../flight-to-quality-classification";
import type { ReportCardCachePayload } from "../report-card-cache";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v8/evaluation-build-manifest-v1";

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
    const result = buildFlightToQualityClassification(reportCardCache({
      "usdc-circle": { score: 65, grade: "B-" },
      "usdt-tether": { score: 49, grade: "D" },
      "dai-makerdao": { score: 50, grade: "C-" },
      "untracked-token": { score: 90, grade: "A+" },
    }));

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

    expect(buildFlightToQualityClassification(payload)).toEqual({
      kind: "unavailable",
      reason: "identity-missing",
    });
  });
});
