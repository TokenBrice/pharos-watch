import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import type { persistSafetyScoreV9Publication } from "../safety-score-v9/publication-store";

type PublicationWrite = Parameters<typeof persistSafetyScoreV9Publication>[1];

export function currentInput(publication: SafetyScoreV9CurrentResponse): PublicationWrite {
  return {
    publication,
    publicationHealth: {
      schemaVersion: 1,
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
