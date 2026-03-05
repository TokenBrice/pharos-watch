import { withErrorHandler, addFreshnessHeaders, errorResponse, jsonResponse } from "../lib/api-utils";
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

  return jsonResponse(snapshot, addFreshnessHeaders({
    "Cache-Control": CACHE_PROFILES.standard,
  }, snapshot.updatedAt, 900));
});
