import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { projectSafetyGrades } from "@shared/types/report-cards-v9";
import { errorResponse, jsonFreshResponse } from "../lib/api-response";
import { CACHE_PROFILES } from "../lib/constants";
import { loadActiveSafetyScoreSource } from "../lib/safety-score-active-source";

/**
 * Free lane (no `X-API-Key`): grade-only projection of the same accepted V9
 * publication `/api/report-cards/v9` serves. Held publications are served
 * uncached, exactly like the full report cards.
 */
export const handleSafetyGrades = async (db: D1Database): Promise<Response> => {
  const active = await loadActiveSafetyScoreSource(db);
  if (active.kind === "error") {
    return errorResponse(503, active.detail);
  }
  const snapshot = active.snapshot;
  const held = snapshot.publicationHealth.status === "held";
  return jsonFreshResponse(projectSafetyGrades(snapshot), {
    cacheControl: held ? CACHE_PROFILES.noStore : CACHE_PROFILES.standard,
    updatedAt: snapshot.updatedAt,
    maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.reportCards,
    headers: { "X-Safety-Score-Status": held ? "held" : "current" },
  });
};
