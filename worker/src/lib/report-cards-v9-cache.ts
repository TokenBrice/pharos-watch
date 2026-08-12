import {
  buildReportCardsV9DependencyGraph,
  REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION,
  ReportCardsV9CurrentResponseSchema,
  type ReportCardsV9CurrentResponse,
  type V9PublicationHealth,
} from "@shared/types/report-cards-v9";
import {
  SafetyScoreV9CurrentResponseSchema,
  type SafetyScoreV9CurrentResponse,
} from "@shared/types/safety-score-v9-public";
import {
  loadSafetyScoreV9Publication,
  loadSafetyScoreV9PublicationHealth,
} from "./safety-score-v9-publication-store";

export class ReportCardsV9SnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportCardsV9SnapshotUnavailableError";
  }
}

export function projectSafetyScoreV9PublicationToPublicSnapshot(
  input: SafetyScoreV9CurrentResponse,
  publicationHealth: V9PublicationHealth,
): ReportCardsV9CurrentResponse {
  const publication = SafetyScoreV9CurrentResponseSchema.parse(input);
  const healthMatchesPublication =
    publicationHealth.acceptedPublicationGenerationId ===
      publication.publicationGenerationId &&
    publicationHealth.acceptedAtSec === publication.publishedAtSec;
  const effectiveHealth = healthMatchesPublication
    ? publicationHealth
    : {
        ...publicationHealth,
        status: "held" as const,
        acceptedPublicationGenerationId: publication.publicationGenerationId,
        acceptedAtSec: publication.publishedAtSec,
        heldSinceSec: publication.publishedAtSec,
        reasons: [{
          code: "assessment-failed" as const,
          detail: "Publication health did not match the stored snapshot; serving the last-known-good snapshot as held.",
        }],
      };
  return ReportCardsV9CurrentResponseSchema.parse({
    model: "v9",
    schemaVersion: REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION,
    lifecycle: "active",
    safetyScoreIdentity: {
      model: "v9",
      schemaVersion: 1,
      methodologyVersion: publication.policyVersion,
      policyId: publication.policy.id,
      policyDigest: publication.policy.semanticDigest,
      evaluationBuildDigest: publication.evaluationBuildDigest,
      baseInputGenerationId: publication.baseInputGenerationId,
      publicationGenerationId: publication.publicationGenerationId,
    },
    methodology: {
      version: publication.policyVersion,
      policy: publication.policy,
    },
    asOfSec: publication.asOfSec,
    updatedAt: publication.publishedAtSec,
    publicationHealth: effectiveHealth,
    completeness: publication.completeness,
    source: {
      candidateId: publication.candidateId,
      factSetDigest: publication.factSetDigest,
      resultDigest: publication.resultDigest,
      sourceGenerations: publication.sourceGenerations,
    },
    cards: publication.cards,
    dependencyGraph: buildReportCardsV9DependencyGraph(
      publication.cards,
    ),
  });
}

export async function loadPublishedReportCardsV9Snapshot(
  db: D1Database,
  signal?: AbortSignal,
): Promise<ReportCardsV9CurrentResponse> {
  let publication;
  let publicationHealth;
  try {
    [publication, publicationHealth] = await Promise.all([
      loadSafetyScoreV9Publication(db, signal),
      loadSafetyScoreV9PublicationHealth(db, signal),
    ]);
  } catch (error) {
    throw new ReportCardsV9SnapshotUnavailableError(
      `Canonical Safety Score V9 publication is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (publication === null) {
    throw new ReportCardsV9SnapshotUnavailableError(
      "Canonical Safety Score V9 publication is unavailable",
    );
  }
  if (publicationHealth === null) {
    throw new ReportCardsV9SnapshotUnavailableError(
      "Safety Score V9 publication health is unavailable",
    );
  }
  try {
    return projectSafetyScoreV9PublicationToPublicSnapshot(
      publication,
      publicationHealth,
    );
  } catch (error) {
    throw new ReportCardsV9SnapshotUnavailableError(
      `Canonical Safety Score V9 publication is incompatible: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
