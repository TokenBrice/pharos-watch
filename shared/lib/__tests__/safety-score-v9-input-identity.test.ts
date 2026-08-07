import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "../../data/safety-score-v9/evaluation-build-manifest-v1";
import {
  buildSafetyScoreV9InputIdentity,
  safetyScoreV9InputIdentitiesMatch,
} from "../safety-score-v9-input-identity";

const input = {
  methodologyVersion: "9.0",
  baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
  publicationGenerationId: "report-cards:9.0:1785168000",
};

describe("Safety Score V9 input identity", () => {
  it("builds the native input identity bound to the V9 evaluation build", () => {
    expect(buildSafetyScoreV9InputIdentity(input)).toEqual({
      model: "v9-input",
      schemaVersion: 1,
      methodologyVersion: "9.0",
      evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
      baseInputGenerationId: input.baseInputGenerationId,
      publicationGenerationId: input.publicationGenerationId,
    });
  });

  it("rejects a base input generation outside the published id format", () => {
    for (const badId of [
      `report-cards-input:v2:${"a".repeat(64)}`,
      `report-cards-input:v1:${"a".repeat(63)}`,
      "report-cards-input:v1:NOTHEX",
    ]) {
      expect(() =>
        buildSafetyScoreV9InputIdentity({ ...input, baseInputGenerationId: badId }),
      ).toThrow();
    }
  });

  it("requires every persisted identity field to match", () => {
    const identity = buildSafetyScoreV9InputIdentity(input);

    expect(safetyScoreV9InputIdentitiesMatch(identity, identity)).toBe(true);
    expect(
      safetyScoreV9InputIdentitiesMatch(identity, {
        ...identity,
        publicationGenerationId: "report-cards:9.0:1785168060",
      }),
    ).toBe(false);
    expect(
      safetyScoreV9InputIdentitiesMatch(identity, {
        ...identity,
        evaluationBuildDigest: "b".repeat(64),
      }),
    ).toBe(false);
  });
});
