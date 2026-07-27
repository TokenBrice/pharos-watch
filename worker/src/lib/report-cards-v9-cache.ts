import {
  buildReportCardsV9DependencyGraph,
  REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION,
  ReportCardsV9CurrentResponseSchema,
  type ReportCardsV9Response,
  type V9PublicationHealth,
} from "@shared/types/report-cards-v9";
import {
  SafetyScoreV9CurrentResponseSchema,
  type SafetyScoreV9Response,
} from "@shared/types/safety-score-v9-public";
import {
  loadLatestSafetyScoreV9ShadowEnvelope,
  loadSafetyScoreV9PublicationHealth,
} from "./safety-score-v9-store";

export class ReportCardsV9SnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportCardsV9SnapshotUnavailableError";
  }
}

/**
 * Converts the canonical V9 envelope into the separately owned public
 * V9 contract. This is intentionally a projection, never a V8 fallback or
 * a score recomputation.
 */
export function projectSafetyScoreV9CandidateToPublicSnapshot(
  candidate: SafetyScoreV9Response,
  publicationHealth: V9PublicationHealth,
): ReportCardsV9Response {
  const currentCandidate = SafetyScoreV9CurrentResponseSchema.parse(candidate);
  if (
    publicationHealth.acceptedPublicationGenerationId !==
      currentCandidate.publicationGenerationId ||
    publicationHealth.acceptedAtSec !== currentCandidate.publishedAtSec
  ) {
    throw new Error(
      "Safety Score V9 publication health does not match the accepted candidate",
    );
  }
  return ReportCardsV9CurrentResponseSchema.parse({
    model: "v9",
    schemaVersion: REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION,
    lifecycle: "shadow",
    safetyScoreIdentity: {
      model: "v9",
      schemaVersion: 1,
      methodologyVersion: currentCandidate.policyVersion,
      policyId: currentCandidate.policy.id,
      policyDigest: currentCandidate.policy.semanticDigest,
      evaluationBuildDigest: currentCandidate.evaluationBuildDigest,
      baseInputGenerationId: currentCandidate.baseInputGenerationId,
      publicationGenerationId: currentCandidate.publicationGenerationId,
    },
    methodology: {
      version: currentCandidate.policyVersion,
      policy: currentCandidate.policy,
    },
    asOfSec: currentCandidate.asOfSec,
    updatedAt: currentCandidate.publishedAtSec,
    publicationHealth,
    completeness: currentCandidate.completeness,
    source: {
      candidateId: currentCandidate.candidateId,
      factSetDigest: currentCandidate.factSetDigest,
      resultDigest: currentCandidate.resultDigest,
      sourceGenerations: currentCandidate.sourceGenerations,
    },
    cards: currentCandidate.cards,
    dependencyGraph: buildReportCardsV9DependencyGraph(currentCandidate.cards),
  });
}

/**
 * The current canonical V9 source is the persisted shadow envelope. It is
 * read strictly and never falls back to V8 or an on-read evaluator.
 */
export async function loadPublishedReportCardsV9Snapshot(
  db: D1Database,
  signal?: AbortSignal,
): Promise<ReportCardsV9Response> {
  let envelope;
  let publicationHealth;
  try {
    [envelope, publicationHealth] = await Promise.all([
      loadLatestSafetyScoreV9ShadowEnvelope(db, signal),
      loadSafetyScoreV9PublicationHealth(db, signal),
    ]);
  } catch (error) {
    throw new ReportCardsV9SnapshotUnavailableError(
      `Canonical Safety Score V9 shadow cache is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (envelope === null) {
    throw new ReportCardsV9SnapshotUnavailableError("Canonical Safety Score V9 shadow cache is unavailable");
  }
  if (publicationHealth === null) {
    throw new ReportCardsV9SnapshotUnavailableError(
      "Safety Score V9 publication health is unavailable",
    );
  }
  try {
    return projectSafetyScoreV9CandidateToPublicSnapshot(
      envelope.candidate,
      publicationHealth,
    );
  } catch (error) {
    throw new ReportCardsV9SnapshotUnavailableError(
      `Canonical Safety Score V9 shadow cache is incompatible: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
