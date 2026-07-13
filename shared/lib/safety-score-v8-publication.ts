import { SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST } from "../data/safety-score-v8/evaluation-build-manifest-v1";
import {
  SafetyScoreV8PublicationIdentitySchema,
  type SafetyScoreV8PublicationIdentity,
} from "../types/safety-score-publication";

export function buildSafetyScoreV8PublicationIdentity(input: {
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

export function safetyScoreV8PublicationIdentitiesMatch(
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

export function safetyScoreV8MethodologyIdentitiesMatch(
  left: SafetyScoreV8PublicationIdentity,
  right: SafetyScoreV8PublicationIdentity,
): boolean {
  return (
    left.model === right.model &&
    left.schemaVersion === right.schemaVersion &&
    left.methodologyVersion === right.methodologyVersion &&
    left.evaluationBuildDigest === right.evaluationBuildDigest
  );
}
