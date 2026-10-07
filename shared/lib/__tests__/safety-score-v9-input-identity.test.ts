import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "../../data/safety-score-v9/evaluation-build-manifest-v1";
import {
  buildSafetyScoreV9InputIdentity,
  diagnoseSafetyScoreV9InputIdentityMismatch,
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

  it("requires methodology, generation, publication, and build identities to match", () => {
    const identity = buildSafetyScoreV9InputIdentity(input);

    expect(safetyScoreV9InputIdentitiesMatch(identity, buildSafetyScoreV9InputIdentity({ ...input }))).toBe(true);
    expect(safetyScoreV9InputIdentitiesMatch(identity, { ...identity, methodologyVersion: "9.1" })).toBe(false);
    expect(safetyScoreV9InputIdentitiesMatch(identity, {
      ...identity,
      baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
    })).toBe(false);
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
  it.each(["evaluationBuildDigest", "registryFingerprint"] as const)("diagnoses deployment-only %s drift without relaxing exact matching", (field) => {
    const expected = buildSafetyScoreV9InputIdentity(input);
    const actual = field === "evaluationBuildDigest" ? { ...expected, evaluationBuildDigest: "0".repeat(64) } : expected;
    const diagnosis = diagnoseSafetyScoreV9InputIdentityMismatch({
      expected, actual, expectedRegistryFingerprint: "a".repeat(64),
      actualRegistryFingerprint: field === "registryFingerprint" ? "b".repeat(64) : "a".repeat(64),
      expectedWorkerVersion: "new-worker", actualWorkerVersion: "old-worker",
      expectedWorkerUploadedAtSec: 200, actualWorkerUploadedAtSec: 100, pairedCaptureValid: true,
    });
    expect(diagnosis.deploymentOnly).toBe(true);
    expect(diagnosis.changedFields).toEqual([field]);
    expect(safetyScoreV9InputIdentitiesMatch(expected, actual)).toBe(field !== "evaluationBuildDigest");
  });

  it.each(["methodologyVersion", "baseInputGenerationId", "publicationGenerationId"] as const)("excludes %s drift from deployment-only classification", (field) => {
    const expected = buildSafetyScoreV9InputIdentity(input);
    const diagnosis = diagnoseSafetyScoreV9InputIdentityMismatch({
      expected, actual: { ...expected, [field]: "different", evaluationBuildDigest: "0".repeat(64) },
      expectedRegistryFingerprint: "a".repeat(64), actualRegistryFingerprint: "a".repeat(64),
      expectedWorkerVersion: "new-worker", actualWorkerVersion: "old-worker",
      expectedWorkerUploadedAtSec: 200, actualWorkerUploadedAtSec: 100, pairedCaptureValid: true,
    });
    expect(diagnosis.deploymentOnly).toBe(false);
    expect(diagnosis.changedFields).toContain(field);
  });
});
