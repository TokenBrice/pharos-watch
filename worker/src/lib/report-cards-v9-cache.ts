import { toErrorMessage } from "@shared/lib/error-utils";
import {
  buildReportCardsV9DependencyGraph,
  REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION,
  ReportCardsV9CurrentResponseSchema,
  type ReportCardsV9CurrentResponse,
  type V9PublicationHealth,
} from "@shared/types/report-cards-v9";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import {
  SafetyScoreV9CurrentResponseSchema,
  type SafetyScoreV9CurrentResponse,
} from "@shared/types/safety-score-v9-public";
import {
  loadSafetyScoreV9Publication,
  loadSafetyScoreV9PublicationHealth,
} from "./safety-score-v9/publication-store";

export class ReportCardsV9SnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportCardsV9SnapshotUnavailableError";
  }
}

/**
 * The published V9 identity carried by a parsed publication. Kept separate from
 * the full projection so identity-only consumers never materialize the cards.
 */
export function buildSafetyScoreV9PublicationIdentity(
  publication: SafetyScoreV9CurrentResponse,
): SafetyScoreV9PublicationIdentity {
  return {
    model: "v9",
    schemaVersion: 1,
    methodologyVersion: publication.policyVersion,
    policyId: publication.policy.id,
    policyDigest: publication.policy.semanticDigest,
    evaluationBuildDigest: publication.evaluationBuildDigest,
    baseInputGenerationId: publication.baseInputGenerationId,
    publicationGenerationId: publication.publicationGenerationId,
  };
}

/**
 * Publication health as the public snapshot serves it: health that does not
 * match the stored publication is downgraded to `held` rather than trusted.
 */
export function resolveSafetyScoreV9EffectivePublicationHealth(
  publication: SafetyScoreV9CurrentResponse,
  publicationHealth: V9PublicationHealth,
): V9PublicationHealth {
  const healthMatchesPublication =
    publicationHealth.acceptedPublicationGenerationId ===
      publication.publicationGenerationId &&
    publicationHealth.acceptedAtSec === publication.publishedAtSec;
  return healthMatchesPublication
    ? publicationHealth
    : {
        ...publicationHealth,
        status: "held" as const,
        acceptedPublicationGenerationId: publication.publicationGenerationId,
        acceptedAtSec: publication.publishedAtSec,
        attemptedAtSec: Math.max(
          publicationHealth.attemptedAtSec,
          publication.publishedAtSec,
        ),
        heldSinceSec: publicationHealth.status === "held" &&
          publicationHealth.heldSinceSec !== null
          ? Math.max(
              publicationHealth.heldSinceSec,
              publication.publishedAtSec,
            )
          : Math.max(
              publicationHealth.attemptedAtSec,
              publication.publishedAtSec,
            ),
        reasons: [{
          code: "assessment-failed" as const,
          detail: "Publication health did not match the stored snapshot; serving the last-known-good snapshot as held.",
        }],
      };
}

export function projectSafetyScoreV9PublicationToPublicSnapshot(
  input: SafetyScoreV9CurrentResponse,
  publicationHealth: V9PublicationHealth,
): ReportCardsV9CurrentResponse {
  const publication = SafetyScoreV9CurrentResponseSchema.parse(input);
  const effectiveHealth = resolveSafetyScoreV9EffectivePublicationHealth(
    publication,
    publicationHealth,
  );
  return ReportCardsV9CurrentResponseSchema.parse({
    model: "v9",
    schemaVersion: REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION,
    lifecycle: "active",
    safetyScoreIdentity: buildSafetyScoreV9PublicationIdentity(publication),
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
        toErrorMessage(error)
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
        toErrorMessage(error)
      }`,
    );
  }
}
