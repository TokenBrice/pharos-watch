import { withErrorHandler, errorResponse, jsonFreshResponse } from "../lib/api-utils";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CACHE_PROFILES } from "../lib/constants";
import {
  buildReportCardsSnapshot,
  ReportCardsSnapshotUnavailableError,
} from "../lib/report-cards-snapshot";

export const handleReportCards = withErrorHandler("report-cards", async (db: D1Database): Promise<Response> => {
  let snapshot;
  try {
    snapshot = await buildReportCardsSnapshot(db);
  } catch (err) {
    if (err instanceof ReportCardsSnapshotUnavailableError) {
      return errorResponse(503, err.message);
    }
    throw err;
  }

  return jsonFreshResponse(snapshot, {
    cacheControl: CACHE_PROFILES.standard,
    updatedAt: snapshot.updatedAt,
    maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.reportCards,
  });
});
