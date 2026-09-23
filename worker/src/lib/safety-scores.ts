import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import { loadActiveSafetyScoreSource } from "./safety-score-active-source";

interface SafetyResult {
  score: number;
  grade: string;
}

export type PublishedSafetyScoresResultMap = {
  kind: "ok" | "degraded";
  mode: "map";
  reason?: string;
  coveredCount: number;
  trackedCount: number;
  coverageRatio: number;
  scores: Map<string, SafetyResult>;
  source: "safety-score-v9-publication";
  safetyScoreIdentity: SafetyScoreV9PublicationIdentity | null;
  publicationGenerationId: string | null;
  methodologyVersion: string | null;
  publishedAt: number | null;
};

function result(
  input: Omit<
    PublishedSafetyScoresResultMap,
    "mode" | "source" | "coveredCount" | "coverageRatio"
  > & { scores: Map<string, SafetyResult> },
): PublishedSafetyScoresResultMap {
  const coveredCount = input.scores.size;
  return {
    ...input,
    mode: "map",
    source: "safety-score-v9-publication",
    coveredCount,
    coverageRatio:
      input.trackedCount > 0 ? coveredCount / input.trackedCount : 1,
  };
}

/**
 * Loads the canonical published V9 score map: the same accepted generation the
 * report-card surfaces serve, in both health states. A hold rejects the newest
 * publication attempt; it does not withdraw the accepted ratings
 * (`report-cards.md`: a held response serves the last accepted ratings with the
 * accepted timestamp). Dropping the accepted map on a hold made every
 * downstream row unrateable for as long as the hold lasted, while the public
 * report-card route kept serving exactly those ratings.
 *
 * `kind` and `reason` still name the health state, so a consumer that requires
 * *current* ratings keeps rejecting a held publication by checking them
 * (`yield-coverage-audit`, the live yield read-path hydration); a consumer that
 * can serve the accepted generation applies its own freshness budget.
 */
export async function computeSafetyScoresSnapshot(
  db: D1Database,
): Promise<PublishedSafetyScoresResultMap> {
  const active = await loadActiveSafetyScoreSource(db);
  if (active.kind === "error") {
    return result({
      kind: "degraded",
      reason: active.reason,
      scores: new Map(),
      trackedCount: 0,
      safetyScoreIdentity: null,
      publicationGenerationId: null,
      methodologyVersion: null,
      publishedAt: null,
    });
  }
  const identity = active.snapshot.safetyScoreIdentity;
  const scores = new Map<string, SafetyResult>();
  for (const card of active.snapshot.cards) {
    if (card.score !== null) {
      scores.set(card.id, { score: card.score, grade: card.grade });
    }
  }
  const acceptedGeneration = {
    scores,
    trackedCount: active.snapshot.completeness.expectedCount,
    safetyScoreIdentity: identity,
    publicationGenerationId: identity.publicationGenerationId,
    methodologyVersion: identity.methodologyVersion,
    publishedAt: active.snapshot.updatedAt,
  };
  return active.kind === "held"
    ? result({ kind: "degraded", reason: active.reason, ...acceptedGeneration })
    : result({ kind: "ok", ...acceptedGeneration });
}
