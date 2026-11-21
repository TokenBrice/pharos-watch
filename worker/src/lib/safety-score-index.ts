import { SafetyScoreIndexSchema } from "@shared/types/safety-score-index";
import { ScorecardPillarRatingsSchema, type ScorecardPillarRatings } from "@shared/types/social-scorecard";
import { V9PublicationHealthSchema, type V9PublicationHealth, type SafetyGradesResponse } from "@shared/types/report-cards-v9";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import { safetyScorePublicationIdentitiesMatch } from "@shared/lib/safety-score-publication";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { throwIfAborted } from "./abort";
import { SAFETY_SCORE_V9_CACHE_KEYS, resolveSafetyScoreV9EffectivePublicationHealth } from "./safety-score-v9/publication-health";
import { publicationIdentityFromStorageEnvelope } from "./safety-score-v9/publication-codec";

export interface SafetyScoreGradeSnapshot {
  lifecycle: "active";
  safetyScoreIdentity: SafetyScoreV9PublicationIdentity;
  methodology: { version: string };
  asOfSec: number;
  updatedAt: number;
  publicationHealth: V9PublicationHealth;
  completeness: { expectedCount: number };
  cards: SafetyGradesResponse["grades"];
  scorecardPillars?: { id: string; ratings: ScorecardPillarRatings };
  scorecardPillarsById?: Record<string, ScorecardPillarRatings>;
}

export type ActiveSafetyScoreIndex =
  | { kind: "v9"; snapshot: SafetyScoreGradeSnapshot }
  | { kind: "held"; reason: "v9-publication-held"; detail: string; snapshot: SafetyScoreGradeSnapshot }
  | { kind: "error"; reason: string; detail: string; snapshot: null };

export interface SafetyScoreIndexPillarOptions {
  includePillarsForIds: readonly string[];
}

/** One D1 read binds the small projection to the accepted envelope and health.
 * Never inflate the publication as a request-time fallback, including rollout.
 */
export async function loadActiveSafetyScoreIndex(
  db: D1Database,
  signal?: AbortSignal,
  pillarSubject?: string | SafetyScoreIndexPillarOptions,
): Promise<ActiveSafetyScoreIndex> {
  const unavailable = (reason: string): ActiveSafetyScoreIndex => ({
    kind: "error", reason, detail: `Canonical Safety Score index unavailable: ${reason}`, snapshot: null,
  });
  const singlePillarSubjectId = typeof pillarSubject === "string" ? pillarSubject : undefined;
  const batchPillarIds = typeof pillarSubject === "object" && pillarSubject !== null && pillarSubject.includePillarsForIds.length > 0
    ? pillarSubject.includePillarsForIds
    : undefined;
  const pillarExtractPath = singlePillarSubjectId !== undefined
    ? `$.ratings.${JSON.stringify(singlePillarSubjectId)}`
    : batchPillarIds !== undefined
      ? "$.ratings"
      : null;
  try {
    throwIfAborted(signal);
    const row = await db.prepare(`SELECT
      i.value AS score_index, i.updated_at AS index_updated_at,
      h.value AS health, h.updated_at AS health_updated_at,
      json_extract(p.value, '$.identity') AS publication_identity,
      json_extract(p.value, '$.identity.resultDigest') AS result_digest,
      p.updated_at AS publication_updated_at,
      CASE WHEN json_valid(og.value) THEN CASE WHEN
        json_extract(og.value, '$.publicationGenerationId') = json_extract(p.value, '$.identity.publicationGenerationId')
        AND json_extract(og.value, '$.resultDigest') = json_extract(p.value, '$.identity.resultDigest')
        THEN json_quote(json_extract(og.value, ?)) END
      END AS pillar_ratings
      FROM cache p
      LEFT JOIN cache i ON i.key = ?
      LEFT JOIN cache h ON h.key = ?
      LEFT JOIN cache og ON og.key = ? AND og.updated_at = p.updated_at
      WHERE p.key = ?`).bind(
      pillarExtractPath,
      SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex,
      SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth,
      pillarExtractPath === null ? null : SAFETY_SCORE_V9_CACHE_KEYS.scorecardPillars,
      SAFETY_SCORE_V9_CACHE_KEYS.publication,
    ).first<{
      score_index: string | null; index_updated_at: number | null;
      health: string | null; health_updated_at: number | null;
      publication_identity: string | null; result_digest: string | null; publication_updated_at: number;
      pillar_ratings: string | null;
    }>();
    throwIfAborted(signal);
    if (!row) return unavailable("v9-snapshot-unavailable");
    if (row.score_index === null) return unavailable("safety-score-index-missing");
    let index;
    try {
      const storedIndex: unknown = JSON.parse(row.score_index);
      if (storedIndex && typeof storedIndex === "object" && "schemaVersion" in storedIndex && storedIndex.schemaVersion === 1) return unavailable("publication-schema-cutover-pending");
      index = SafetyScoreIndexSchema.parse(storedIndex);
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
    const storedHealth: unknown = JSON.parse(row.health);
    if (storedHealth && typeof storedHealth === "object" && "schemaVersion" in storedHealth && storedHealth.schemaVersion === 1) return unavailable("publication-schema-cutover-pending");
    const health = V9PublicationHealthSchema.parse(storedHealth);
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
    const singlePillars = singlePillarSubjectId !== undefined && index.scores[singlePillarSubjectId]?.ratingStatus === "rated"
      && row.pillar_ratings != null ? ScorecardPillarRatingsSchema.safeParse(JSON.parse(row.pillar_ratings)) : null;
    let scorecardPillarsById: Record<string, ScorecardPillarRatings> | undefined;
    if (batchPillarIds !== undefined && row.pillar_ratings != null) {
      try {
        const rawRatings: unknown = JSON.parse(row.pillar_ratings);
        if (rawRatings && typeof rawRatings === "object" && !Array.isArray(rawRatings)) {
          const map: Record<string, ScorecardPillarRatings> = {};
          const ratingsRecord = rawRatings as Record<string, unknown>;
          for (const id of batchPillarIds) {
            if (index.scores[id]?.ratingStatus !== "rated" || ratingsRecord[id] === undefined) continue;
            const parsed = ScorecardPillarRatingsSchema.safeParse(ratingsRecord[id]);
            if (parsed.success) {
              map[id] = parsed.data;
            }
          }
          scorecardPillarsById = map;
        }
      } catch {
        scorecardPillarsById = undefined;
      }
    }
    const snapshot: SafetyScoreGradeSnapshot = {
      lifecycle: "active", safetyScoreIdentity: index.safetyScoreIdentity,
      methodology: { version: index.safetyScoreIdentity.methodologyVersion },
      asOfSec: index.asOfSec, updatedAt: index.publishedAtSec, publicationHealth: effectiveHealth,
      completeness: { expectedCount: index.expectedCount },
      cards: Object.entries(index.scores).map(([id, entry]) => ({ id, ...entry })),
      ...(singlePillars?.success && singlePillarSubjectId !== undefined
        ? { scorecardPillars: { id: singlePillarSubjectId, ratings: singlePillars.data } }
        : {}),
      ...(scorecardPillarsById !== undefined ? { scorecardPillarsById } : {}),
    };
    return effectiveHealth.status === "held"
      ? { kind: "held", reason: "v9-publication-held", detail: "Canonical Safety Score V9 ratings are held at the last verified snapshot", snapshot }
      : { kind: "v9", snapshot };
  } catch {
    return unavailable("safety-score-index-read-failed");
  }
}
