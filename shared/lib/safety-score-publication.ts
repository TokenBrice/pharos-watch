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

export type SafetyScoreAcceptedEvidenceReason =
  | "accepted-evidence-missing"
  | "accepted-evidence-invalid"
  | "accepted-evidence-future"
  | "accepted-evidence-stale";

export interface SafetyScoreAcceptedEvidenceAssessment {
  acceptedGenerationId: string | null;
  acceptedAtSec: number | null;
  assessedAtSec: number;
  /** Unclamped `now - acceptedAt`; null when the clock is unusable. */
  ageSec: number | null;
  maxAgeSec: number;
  withinBudget: boolean;
  reason: SafetyScoreAcceptedEvidenceReason | null;
  /** Hold diagnostics never change the accepted-clock verdict; each consumer owns its hold policy. */
  held: boolean;
  heldSinceSec: number | null;
}

/**
 * One reading of the admitted generation's accepted publication clock (R3).
 * Callers pass the accepted clock, never an attempt clock, plus their own
 * budget; schema, checksum and identity admission stay in the loaders.
 * Missing, non-finite or future evidence fails closed unless the caller names
 * an explicit future-skew allowance.
 */
export function assessSafetyScoreAcceptedEvidence(input: {
  acceptedGenerationId?: string | null;
  acceptedAtSec: number | null | undefined;
  health?: { status: string; heldSinceSec?: number | null } | null;
  nowSec: number;
  maxAgeSec: number;
  allowedFutureSkewSec?: number;
}): SafetyScoreAcceptedEvidenceAssessment {
  const held = input.health?.status === "held";
  const base = {
    acceptedGenerationId: input.acceptedGenerationId ?? null,
    acceptedAtSec: input.acceptedAtSec ?? null,
    assessedAtSec: input.nowSec,
    maxAgeSec: input.maxAgeSec,
    held,
    heldSinceSec: held ? input.health?.heldSinceSec ?? null : null,
  };
  const reject = (reason: SafetyScoreAcceptedEvidenceReason, ageSec: number | null = null) =>
    ({ ...base, ageSec, withinBudget: false, reason });
  if (input.acceptedAtSec == null) return reject("accepted-evidence-missing");
  if (!Number.isFinite(input.acceptedAtSec) || !Number.isFinite(input.nowSec)) {
    return reject("accepted-evidence-invalid");
  }
  const ageSec = input.nowSec - input.acceptedAtSec;
  if (-ageSec > (input.allowedFutureSkewSec ?? 0)) return reject("accepted-evidence-future");
  if (ageSec > input.maxAgeSec) return reject("accepted-evidence-stale", ageSec);
  return { ...base, ageSec, withinBudget: true, reason: null };
}
