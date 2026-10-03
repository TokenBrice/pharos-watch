import type { SafetyGradesResponse } from "@shared/types/report-cards-v9";
import {
  jsonResponse,
  jsonSafetyScoreSnapshotResponse,
} from "../lib/api-response";
import { loadActiveSafetyScoreIndex } from "../lib/safety-score-index";

/**
 * Free lane (no `X-API-Key`): grade-only projection of the same accepted V9
 * publication `/api/report-cards/v9` serves. Held publications are served
 * uncached, exactly like the full report cards.
 */
export const handleSafetyGrades = async (db: D1Database): Promise<Response> => {
  const active = await loadActiveSafetyScoreIndex(db);
  if (active.kind === "error") {
    return jsonResponse({ error: active.detail, reason: active.reason }, { status: 503, noStore: true });
  }
  const snapshot = active.snapshot;
  const body: SafetyGradesResponse = {
    schemaVersion: 1,
    model: "v9",
    methodologyVersion: snapshot.methodology.version,
    asOfSec: snapshot.asOfSec,
    updatedAt: snapshot.updatedAt,
    publicationStatus: snapshot.publicationHealth.status,
    grades: snapshot.cards,
  };
  return jsonSafetyScoreSnapshotResponse(snapshot, body);
};
