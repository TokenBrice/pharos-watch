import { SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST } from "../data/safety-score-v8/evaluation-build-manifest-v1";
import {
  SafetyScoreV8PublicationIdentitySchema,
  type SafetyScoreV8PublicationIdentity,
} from "../types/safety-score-publication";

/**
 * Builds the identity for the private fixed input consumed by the V9 compiler.
 *
 * The persisted discriminator remains `v8` because the fixed-input schema and
 * evaluator digest are rollout-compatible with the retired V8 pipeline.
 */
export function buildSafetyScoreV9InputIdentity(input: {
  methodologyVersion: string;
  baseInputGenerationId: string;
  publicationGenerationId: string;
}): SafetyScoreV8PublicationIdentity {
  return SafetyScoreV8PublicationIdentitySchema.parse({
    model: "v8",
    schemaVersion: 1,
    methodologyVersion: input.methodologyVersion,
    evaluationBuildDigest: SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST,
    baseInputGenerationId: input.baseInputGenerationId,
    publicationGenerationId: input.publicationGenerationId,
  });
}

export function safetyScoreV9InputIdentitiesMatch(
  left: SafetyScoreV8PublicationIdentity,
  right: SafetyScoreV8PublicationIdentity,
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
