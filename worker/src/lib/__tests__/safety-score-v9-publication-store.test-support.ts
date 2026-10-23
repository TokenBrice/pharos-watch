import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import { persistSafetyScoreV9Publication } from "../safety-score-v9/publication-store";
import { buildSafetyScoreV9AcceptedProjections } from "../safety-score-v9/accepted-projections";
import { materializeV9AcceptedPublication } from "../report-cards-v9-materialization";

type PublicationWrite = Parameters<typeof persistSafetyScoreV9Publication>[1];

export function currentInput(publication: SafetyScoreV9CurrentResponse): PublicationWrite {
  return {
    publication,
    buildAcceptedProjections: buildSafetyScoreV9AcceptedProjections,
    publicationHealth: {
      schemaVersion: 2,
      status: "current",
      acceptedPublicationGenerationId: publication.publicationGenerationId,
      acceptedAtSec: publication.publishedAtSec,
      attemptedAtSec: publication.publishedAtSec,
      heldSinceSec: null,
      reasons: [],
    },
    publicationAttempt: {
      schemaVersion: 1,
      attemptedAtSec: publication.publishedAtSec,
      outcome: "published-clean",
      publicationGenerationId: publication.publicationGenerationId,
      quarantines: [],
      affectedAssetIds: [],
    },
    publicationClockSec: publication.publishedAtSec,
  };
}

/** Production order: atomic acceptance, then the post-acceptance public materialization. */
export async function persistAndMaterialize(db: D1Database, input: PublicationWrite) {
  const persisted = await persistSafetyScoreV9Publication(db, input);
  if (persisted.acceptedMaterialization !== null) {
    await materializeV9AcceptedPublication(db, persisted.acceptedMaterialization, input.signal);
  }
  return persisted;
}
