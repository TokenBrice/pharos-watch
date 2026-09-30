import { projectDependencyGraph } from "@shared/types/dependency-graph";
import { errorResponse, jsonSafetyScoreSnapshotResponse } from "../lib/api-response";
import { loadActiveSafetyScoreSource } from "../lib/safety-score-active-source";

/** Free graph projection of the accepted V9 publication, including held snapshots. */
export const handleDependencyGraph = async (db: D1Database): Promise<Response> => {
  const active = await loadActiveSafetyScoreSource(db);
  if (active.kind === "error") return errorResponse(503, active.detail);
  return jsonSafetyScoreSnapshotResponse(active.snapshot, projectDependencyGraph(active.snapshot));
};
