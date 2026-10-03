import {
  jsonResponse,
  jsonSafetyScoreSnapshotResponse,
} from "../lib/api-response";
import { loadActiveSafetyScoreSource } from "../lib/safety-score-active-source";

/**
 * Canonical V9 public contract. This route reads only the accepted V9
 * publication and never falls back to V8 or recomputes a score.
 */
export const handleReportCardsV9 = async (db: D1Database): Promise<Response> => {
  const active = await loadActiveSafetyScoreSource(db);
  if (active.kind === "error") {
    return jsonResponse(
      { error: active.detail, reason: active.reason },
      { status: 503, noStore: true },
    );
  }
  return jsonSafetyScoreSnapshotResponse(active.snapshot);
};
