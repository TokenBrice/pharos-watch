import type { SafetyScorePublicationIdentity } from "../types/safety-score-publication";

export function safetyScorePublicationIdentitiesMatch(
  left: SafetyScorePublicationIdentity,
  right: SafetyScorePublicationIdentity,
): boolean {
  if (
    left.model !== right.model ||
    left.schemaVersion !== right.schemaVersion ||
    left.methodologyVersion !== right.methodologyVersion ||
    left.evaluationBuildDigest !== right.evaluationBuildDigest ||
    left.baseInputGenerationId !== right.baseInputGenerationId ||
    left.publicationGenerationId !== right.publicationGenerationId
  ) {
    return false;
  }
  if (left.model === "v8" || right.model === "v8") return left.model === right.model;
  return left.policyId === right.policyId && left.policyDigest === right.policyDigest;
}

/**
 * Publication generations and base inputs may advance within one organic
 * series. Model, schema, methodology, policy, and evaluator build may not.
 */
export function safetyScorePublicationIdentitiesAreComparable(
  left: SafetyScorePublicationIdentity,
  right: SafetyScorePublicationIdentity,
): boolean {
  if (
    left.model !== right.model ||
    left.schemaVersion !== right.schemaVersion ||
    left.methodologyVersion !== right.methodologyVersion ||
    left.evaluationBuildDigest !== right.evaluationBuildDigest
  ) {
    return false;
  }
  if (left.model === "v8" || right.model === "v8") return left.model === right.model;
  return left.policyId === right.policyId && left.policyDigest === right.policyDigest;
}
