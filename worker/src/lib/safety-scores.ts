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
 * Loads the canonical published V9 score map. Held or unavailable publications
 * fail closed so downstream yield and audit jobs cannot mix scoring identities.
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
  if (active.kind === "held") {
    return result({
      kind: "degraded",
      reason: active.reason,
      scores: new Map(),
      trackedCount: active.snapshot.completeness.expectedCount,
      safetyScoreIdentity: identity,
      publicationGenerationId: identity.publicationGenerationId,
      methodologyVersion: identity.methodologyVersion,
      publishedAt: active.snapshot.updatedAt,
    });
  }
  const scores = new Map<string, SafetyResult>();
  for (const card of active.snapshot.cards) {
    if (card.score !== null) {
      scores.set(card.id, { score: card.score, grade: card.grade });
    }
  }
  return result({
    kind: "ok",
    scores,
    trackedCount: active.snapshot.completeness.expectedCount,
    safetyScoreIdentity: identity,
    publicationGenerationId: identity.publicationGenerationId,
    methodologyVersion: identity.methodologyVersion,
    publishedAt: active.snapshot.updatedAt,
  });
}
