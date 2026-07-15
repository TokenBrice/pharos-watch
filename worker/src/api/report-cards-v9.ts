import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { errorResponse, jsonFreshResponse, withErrorHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import {
  loadPublishedReportCardsV9Snapshot,
  ReportCardsV9SnapshotUnavailableError,
} from "../lib/report-cards-v9-cache";

/**
 * Versioned V9 public contract. It is shadow-only until a separately approved
 * activation changes the canonical model selection; this route never reads or
 * recomputes the V8 report-card product.
 */
export const handleReportCardsV9 = withErrorHandler("report-cards-v9", async (db: D1Database): Promise<Response> => {
  try {
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
