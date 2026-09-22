import {
  errorResponse,
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
    return errorResponse(503, active.detail);
  }
  return jsonSafetyScoreSnapshotResponse(active.snapshot);
};
