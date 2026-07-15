import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { errorResponse, jsonFreshResponse, withErrorHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { getCache } from "../lib/db-cache";
import {
  loadPublishedReportCardsV9Snapshot,
  ReportCardsV9SnapshotUnavailableError,
} from "../lib/report-cards-v9-cache";

/**
 * Owner-gated activation marker: the versioned V9 endpoint stays DARK until
 * the activation runbook writes this cache key. Without it the shadow cron's
 * cache would be served to any API caller pre-activation.
 */
export const REPORT_CARDS_V9_ACTIVATION_CACHE_KEY = "safety-score-v9:public-activation";

/**
 * Versioned V9 public contract. It is shadow-only until a separately approved
 * activation changes the canonical model selection; this route never reads or
 * recomputes the V8 report-card product.
 */
export const handleReportCardsV9 = withErrorHandler("report-cards-v9", async (db: D1Database): Promise<Response> => {
  try {
    const activation = await getCache(db, REPORT_CARDS_V9_ACTIVATION_CACHE_KEY);
    if (!activation) {
      return errorResponse(404, "Safety Score v9 is not activated; this endpoint is dark until the owner-gated activation step.");
    }
    const snapshot = await loadPublishedReportCardsV9Snapshot(db);
    return jsonFreshResponse(snapshot, {
      cacheControl: CACHE_PROFILES.standard,
      updatedAt: snapshot.updatedAt,
      maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.reportCards,
    });
  } catch (error) {
    if (error instanceof ReportCardsV9SnapshotUnavailableError) {
      return errorResponse(503, error.message);
    }
    throw error;
  }
});
