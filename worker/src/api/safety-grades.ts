import { projectSafetyGrades } from "@shared/types/report-cards-v9";
import {
  errorResponse,
  jsonSafetyScoreSnapshotResponse,
} from "../lib/api-response";
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
  return jsonSafetyScoreSnapshotResponse(
    snapshot,
    projectSafetyGrades(snapshot),
  );
};
