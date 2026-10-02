import { SafetyScoreIndexSchema } from "@shared/types/safety-score-index";
import { V9PublicationHealthSchema, type V9PublicationHealth, type SafetyGradesResponse } from "@shared/types/report-cards-v9";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import { safetyScorePublicationIdentitiesMatch } from "@shared/lib/safety-score-publication";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { throwIfAborted } from "./abort";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "./safety-score-v9/publication-store";
import { publicationIdentityFromStorageEnvelope } from "./safety-score-v9/publication-codec";
import { resolveSafetyScoreV9EffectivePublicationHealth } from "./report-cards-v9-cache";

export interface SafetyScoreGradeSnapshot {
  lifecycle: "active";
  safetyScoreIdentity: SafetyScoreV9PublicationIdentity;
  methodology: { version: string };
  asOfSec: number;
  updatedAt: number;
  publicationHealth: V9PublicationHealth;
  completeness: { expectedCount: number };
  cards: SafetyGradesResponse["grades"];
}

export type ActiveSafetyScoreIndex =
  | { kind: "v9"; snapshot: SafetyScoreGradeSnapshot }
  | { kind: "held"; reason: "v9-publication-held"; detail: string; snapshot: SafetyScoreGradeSnapshot }
  | { kind: "error"; reason: string; detail: string; snapshot: null };

/** One D1 read binds the small projection to the accepted envelope and health.
 * Never inflate the publication as a request-time fallback, including rollout.
 */
export async function loadActiveSafetyScoreIndex(db: D1Database, signal?: AbortSignal): Promise<ActiveSafetyScoreIndex> {
  const unavailable = (reason: string): ActiveSafetyScoreIndex => ({
    kind: "error", reason, detail: `Canonical Safety Score index unavailable: ${reason}`, snapshot: null,
  });
  try {
    throwIfAborted(signal);
    const row = await db.prepare(`SELECT
      i.value AS score_index, i.updated_at AS index_updated_at,
      h.value AS health, h.updated_at AS health_updated_at,
      json_extract(p.value, '$.identity') AS publication_identity,
      json_extract(p.value, '$.identity.resultDigest') AS result_digest,
      p.updated_at AS publication_updated_at
      FROM cache p
      LEFT JOIN cache i ON i.key = ?
      LEFT JOIN cache h ON h.key = ?
      WHERE p.key = ?`).bind(
      SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex,
      SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth,
      SAFETY_SCORE_V9_CACHE_KEYS.publication,
    ).first<{
      score_index: string | null; index_updated_at: number | null;
      health: string | null; health_updated_at: number | null;
      publication_identity: string | null; result_digest: string | null; publication_updated_at: number;
    }>();
    throwIfAborted(signal);
    if (!row) return unavailable("v9-snapshot-unavailable");
    if (row.score_index === null) return unavailable("safety-score-index-missing");
    let index;
    try {
      index = SafetyScoreIndexSchema.parse(JSON.parse(row.score_index));
      if (stableJsonStringifyV1(index) !== row.score_index) return unavailable("safety-score-index-invalid");
    } catch {
      return unavailable("safety-score-index-invalid");
    }
    const identity = row.publication_identity === null ? null
      : publicationIdentityFromStorageEnvelope(JSON.parse(row.publication_identity));
    if (identity === null || !safetyScorePublicationIdentitiesMatch(identity, index.safetyScoreIdentity)
      || row.result_digest !== index.publicationResultDigest
      || row.publication_updated_at !== index.publishedAtSec
      || row.index_updated_at !== index.publishedAtSec) {
      return unavailable("safety-score-index-publication-mismatch");
    }
    if (row.health === null) return unavailable("safety-score-index-health-unavailable");
    const health = V9PublicationHealthSchema.parse(JSON.parse(row.health));
    if (stableJsonStringifyV1(health) !== row.health || row.health_updated_at !== health.attemptedAtSec) {
      return unavailable("safety-score-index-health-unavailable");
    }
    if (health.acceptedPublicationGenerationId !== index.safetyScoreIdentity.publicationGenerationId) {
      return unavailable("safety-score-index-health-mismatch");
    }
    const effectiveHealth = resolveSafetyScoreV9EffectivePublicationHealth({
      publicationGenerationId: index.safetyScoreIdentity.publicationGenerationId,
      publishedAtSec: index.publishedAtSec,
    }, health);
    const snapshot: SafetyScoreGradeSnapshot = {
      lifecycle: "active", safetyScoreIdentity: index.safetyScoreIdentity,
      methodology: { version: index.safetyScoreIdentity.methodologyVersion },
      asOfSec: index.asOfSec, updatedAt: index.publishedAtSec, publicationHealth: effectiveHealth,
      completeness: { expectedCount: index.expectedCount },
      cards: Object.entries(index.scores).map(([id, entry]) => ({ id, ...entry })),
    };
    return effectiveHealth.status === "held"
      ? { kind: "held", reason: "v9-publication-held", detail: "Canonical Safety Score V9 ratings are held at the last verified snapshot", snapshot }
      : { kind: "v9", snapshot };
  } catch {
    return unavailable("safety-score-index-read-failed");
  }
}
