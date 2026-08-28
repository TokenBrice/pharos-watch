import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import { errorResponse, jsonFreshResponse } from "../lib/api-response";
import { CACHE_PROFILES } from "../lib/constants";
import { loadActiveSafetyScoreSource } from "../lib/safety-score-active-source";

function snapshotResponse(
  snapshot: ReportCardsV9CurrentResponse,
): Response {
  const held = snapshot.publicationHealth.status === "held";
  return jsonFreshResponse(
    snapshot,
    {
      cacheControl: held ? CACHE_PROFILES.noStore : CACHE_PROFILES.standard,
      updatedAt: snapshot.updatedAt,
      maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.reportCards,
      headers: {
        "X-Safety-Score-Status": held ? "held" : "current",
      },
    },
  );
}

/**
 * Canonical V9 public contract. This route reads only the accepted V9
 * publication and never falls back to V8 or recomputes a score.
 */
export const handleReportCardsV9 = async (db: D1Database): Promise<Response> => {
  const active = await loadActiveSafetyScoreSource(db);
  if (active.kind === "error") {
    return errorResponse(503, active.detail);
  }
  return snapshotResponse(active.snapshot);
};
