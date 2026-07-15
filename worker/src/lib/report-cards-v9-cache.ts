import {
  buildReportCardsV9DependencyGraph,
  ReportCardsV9ResponseSchema,
  type ReportCardsV9Response,
} from "@shared/types/report-cards-v9";
import type { SafetyScoreV9Response } from "@shared/types/safety-score-v9-public";
import { loadLatestSafetyScoreV9ShadowEnvelope } from "./safety-score-v9-store";

export class ReportCardsV9SnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportCardsV9SnapshotUnavailableError";
  }
}

/**
 * Converts the canonical candidate envelope into the separately owned public
 * V9 contract. This is intentionally a projection, never a V8 fallback or
 * a score recomputation.
 */
export function projectSafetyScoreV9CandidateToPublicSnapshot(
  candidate: SafetyScoreV9Response,
): ReportCardsV9Response {
  return ReportCardsV9ResponseSchema.parse({
    model: "v9",
    schemaVersion: 1,
    lifecycle: "shadow",
    safetyScoreIdentity: {
      model: "v9",
      schemaVersion: 1,
      methodologyVersion: candidate.policyVersion,
      policyId: candidate.policy.id,
      policyDigest: candidate.policy.semanticDigest,
      evaluationBuildDigest: candidate.evaluationBuildDigest,
      baseInputGenerationId: candidate.baseInputGenerationId,
      publicationGenerationId: candidate.publicationGenerationId,
    },
    methodology: {
      version: candidate.policyVersion,
      policy: candidate.policy,
    },
    asOfSec: candidate.asOfSec,
    updatedAt: candidate.publishedAtSec,
    completeness: candidate.completeness,
    source: {
      candidateId: candidate.candidateId,
      factSetDigest: candidate.factSetDigest,
      resultDigest: candidate.resultDigest,
      sourceGenerations: candidate.sourceGenerations,
    },
    cards: candidate.cards,
    dependencyGraph: buildReportCardsV9DependencyGraph(candidate.cards),
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
  try {
    envelope = await loadLatestSafetyScoreV9ShadowEnvelope(db, signal);
  } catch (error) {
    throw new ReportCardsV9SnapshotUnavailableError(
      `Canonical Safety Score V9 shadow cache is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (envelope === null) {
    throw new ReportCardsV9SnapshotUnavailableError("Canonical Safety Score V9 shadow cache is unavailable");
  }
  try {
    return projectSafetyScoreV9CandidateToPublicSnapshot(envelope.candidate);
  } catch (error) {
    throw new ReportCardsV9SnapshotUnavailableError(
      `Canonical Safety Score V9 shadow cache is incompatible: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
