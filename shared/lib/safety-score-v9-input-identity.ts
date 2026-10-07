import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "../data/safety-score-v9/evaluation-build-manifest-v1";
import {
  SafetyScoreV9InputIdentitySchema,
  type SafetyScoreV9InputIdentity,
} from "../types/safety-score-publication";

/**
 * Builds the identity for the private native input consumed by the V9 compiler.
 *
 * The discriminator is `v9-input` because this identity describes an input
 * capture, never a publication: it is bound to the pinned V9 evaluation build
 * (`SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST`) and therefore breaks intentionally
 * whenever the evaluator changes, so a capture prepared under one evaluator can
 * never be scored by another.
 */
export function buildSafetyScoreV9InputIdentity(input: {
  methodologyVersion: string;
  baseInputGenerationId: string;
  publicationGenerationId: string;
}): SafetyScoreV9InputIdentity {
  return SafetyScoreV9InputIdentitySchema.parse({
    model: "v9-input",
    schemaVersion: 1,
    methodologyVersion: input.methodologyVersion,
    evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
    baseInputGenerationId: input.baseInputGenerationId,
    publicationGenerationId: input.publicationGenerationId,
  });
}

export function safetyScoreV9InputIdentitiesMatch(
  left: SafetyScoreV9InputIdentity,
  right: SafetyScoreV9InputIdentity,
): boolean {
  return (
    left.model === right.model &&
    left.schemaVersion === right.schemaVersion &&
    left.methodologyVersion === right.methodologyVersion &&
    left.evaluationBuildDigest === right.evaluationBuildDigest &&
    left.baseInputGenerationId === right.baseInputGenerationId &&
    left.publicationGenerationId === right.publicationGenerationId
  );
}

/**
 * Exact admission remains unchanged. This diagnosis only proves whether a
 * paired capture can request a newer deployed evaluator through prepare.
 */
export function diagnoseSafetyScoreV9InputIdentityMismatch(input: {
  expected: SafetyScoreV9InputIdentity;
  actual: SafetyScoreV9InputIdentity;
  expectedRegistryFingerprint: string;
  actualRegistryFingerprint: string;
  expectedWorkerVersion: string | null;
  actualWorkerVersion: string | null;
  expectedWorkerUploadedAtSec: number | null;
  actualWorkerUploadedAtSec: number | null;
  pairedCaptureValid: boolean;
}) {
  const changedFields: string[] = [];
  for (const field of [
    "model", "schemaVersion", "methodologyVersion", "evaluationBuildDigest",
    "baseInputGenerationId", "publicationGenerationId",
  ] as const) {
    if (input.expected[field] !== input.actual[field]) changedFields.push(field);
  }
  if (input.expectedRegistryFingerprint !== input.actualRegistryFingerprint) changedFields.push("registryFingerprint");
  if (!input.pairedCaptureValid) changedFields.push("capture-pair");
  const deploymentOnly = input.pairedCaptureValid && changedFields.length > 0 &&
    changedFields.every(field => field === "evaluationBuildDigest" || field === "registryFingerprint") &&
    input.expectedWorkerVersion !== null && input.actualWorkerVersion !== null &&
    input.expectedWorkerVersion !== input.actualWorkerVersion &&
    input.expectedWorkerUploadedAtSec !== null && input.actualWorkerUploadedAtSec !== null &&
    input.expectedWorkerUploadedAtSec > input.actualWorkerUploadedAtSec;
  return {
    deploymentOnly,
    changedFields,
    expected: {
      evaluationBuildDigest: input.expected.evaluationBuildDigest,
      registryFingerprint: input.expectedRegistryFingerprint,
      workerVersion: input.expectedWorkerVersion?.slice(0, 160) ?? null,
      workerUploadedAtSec: input.expectedWorkerUploadedAtSec,
    },
    actual: {
      evaluationBuildDigest: input.actual.evaluationBuildDigest,
      registryFingerprint: input.actualRegistryFingerprint,
      workerVersion: input.actualWorkerVersion?.slice(0, 160) ?? null,
      workerUploadedAtSec: input.actualWorkerUploadedAtSec,
    },
  };
}
