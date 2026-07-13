import { withErrorHandler, errorResponse, jsonFreshResponse } from "../lib/api-utils";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CACHE_PROFILES } from "../lib/constants";
import { buildReportCardsSnapshot, ReportCardsSnapshotUnavailableError } from "../lib/report-cards-snapshot";
import { loadPublishedReportCardsSnapshot } from "../lib/report-cards-snapshot-cache";
import type { ReportCardsResponse } from "@shared/types/report-cards";

export const handleReportCards = withErrorHandler("report-cards", async (db: D1Database): Promise<Response> => {
  const cached = await loadPublishedReportCardsSnapshot(db);
  let snapshot: ReportCardsResponse;
  if (cached.kind === "ok") {
    snapshot = cached.payload;
  } else {
    console.warn(
      `[report-cards] Published snapshot unavailable; computing on read reason=${cached.reason}` +
        (cached.updatedAt != null ? ` updatedAt=${cached.updatedAt}` : ""),
    );
    try {
      // This is the legacy V8 compatibility fallback, not a canonical cache
      // publication. Preserve its degraded-input behavior when the strict
      // identity-bearing publication is unavailable.
      snapshot = await buildReportCardsSnapshot(db);
    } catch (err) {
      if (err instanceof ReportCardsSnapshotUnavailableError) {
        return errorResponse(503, err.message);
      }
      throw err;
    }
  }

  return jsonFreshResponse(snapshot, {
    cacheControl: CACHE_PROFILES.standard,
    updatedAt: snapshot.updatedAt,
    maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.reportCards,
  });
});
