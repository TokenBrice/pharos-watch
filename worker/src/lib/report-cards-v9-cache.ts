import { toErrorMessage } from "@shared/lib/error-utils";
import { z } from "zod";
import {
  buildReportCardsV9DependencyGraph,
  REPORT_CARDS_V9_RESPONSE_SCHEMA_VERSION,
  type V9PublicationHealth,
} from "@shared/types/report-cards-v9";
import {
  ReportCardsV9CanonicalProjectionSchema,
  ReportCardsV9CurrentResponseSchema,
  type ReportCardsV9CurrentResponse,
} from "@shared/types/report-cards-v9-current";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import type { SafetyScoreV9AdmittedPublication } from "./safety-score-v9/publication-codec";
import { resolveV9PublicWitnessTexts } from "@shared/types/safety-score-v9-public-witness-texts";
import { loadSafetyScoreV9Publication } from "./safety-score-v9/publication-store";
import { loadSafetyScoreV9PublicationHealth, resolveSafetyScoreV9EffectivePublicationHealth } from "./safety-score-v9/publication-health";

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
  publication: SafetyScoreV9AdmittedPublication,
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

function buildPublicProjection(
  publication: SafetyScoreV9AdmittedPublication,
  publicationHealth: V9PublicationHealth,
  cards: SafetyScoreV9CurrentCard[],
) {
  const effectiveHealth = resolveSafetyScoreV9EffectivePublicationHealth(publication, publicationHealth);
  return {
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
    cards,
    foreignCauseGaps: publication.foreignCauseGaps,
    // A retained schema-7 generation carries no block: publish the machine
    // reason so consumers render unavailable, never zero open questions.
    openEvidence: publication.schemaVersion === 8 ? publication.openEvidence : null,
    openEvidenceUnavailableReason:
      publication.schemaVersion === 8 ? null : "publication-predates-open-evidence",
    ...(publication.schemaVersion === 8 && publication.documentationCauseGaps !== undefined
      ? { documentationCauseGaps: publication.documentationCauseGaps }
      : {}),
    ...(publication.pillarFreshness === undefined ? {} : { pillarFreshness: publication.pillarFreshness }),
    ...(publication.commonModeGroups === undefined ? {} : { commonModeGroups: publication.commonModeGroups }),
    dependencyGraph: buildReportCardsV9DependencyGraph(
      cards,
    ),
  };
}

export function projectSafetyScoreV9PublicationToPublicSnapshot(
  publication: SafetyScoreV9AdmittedPublication,
  publicationHealth: V9PublicationHealth,
): ReportCardsV9CurrentResponse {
  const cards = publication.cards.map((card) => resolveV9PublicWitnessTexts(card));
  return ReportCardsV9CurrentResponseSchema.parse(buildPublicProjection(publication, publicationHealth, cards));
}

/**
 * Only for an already admitted canonical publication. Run all public envelope,
 * graph, gap and parent refinements without cloning the canonical cards again.
 * The materializer admits/resolves/serializes each wire card independently.
 */
export function projectSafetyScoreV9PublicationForMaterialization(
  publication: SafetyScoreV9AdmittedPublication,
  publicationHealth: V9PublicationHealth,
) {
  const admitted = new WeakSet<object>(publication.cards);
  return ReportCardsV9CanonicalProjectionSchema.safeExtend({
    cards: z.array(z.custom<SafetyScoreV9CurrentCard>((card) =>
      card !== null && typeof card === "object" && admitted.has(card))),
  }).parse(buildPublicProjection(publication, publicationHealth, publication.cards));
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
