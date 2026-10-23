/**
 * Runtime-neutral identity fields used to determine whether two publication
 * records are exact matches or belong to the same organic series.
 */
export type SafetyScorePublicationIdentityContract =
  | {
      model: "v8";
      schemaVersion: number;
      methodologyVersion: string;
      evaluationBuildDigest: string;
      baseInputGenerationId: string;
      publicationGenerationId: string;
    }
  | {
      model: "v9";
      schemaVersion: number;
      methodologyVersion: string;
      policyId: string;
      policyDigest: string;
      evaluationBuildDigest: string;
      baseInputGenerationId: string;
      publicationGenerationId: string;
    };

export function safetyScorePublicationIdentitiesMatch(
  left: SafetyScorePublicationIdentityContract,
  right: SafetyScorePublicationIdentityContract,
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
  left: SafetyScorePublicationIdentityContract,
  right: SafetyScorePublicationIdentityContract,
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

/**
 * Request-time yield hydration recomputes every safety-derived field from the
 * live cards, so it needs only the scoring contract (model, schema,
 * methodology, policy) to match. An evaluator-build rotation alone does not
 * change that contract; series comparisons keep the stricter check above.
 */
export function safetyScorePublicationIdentitiesShareScoringContract(
  left: SafetyScorePublicationIdentityContract,
  right: SafetyScorePublicationIdentityContract,
): boolean {
  return safetyScorePublicationIdentitiesAreComparable(
    left,
    { ...right, evaluationBuildDigest: left.evaluationBuildDigest },
  );
}
