import { DEPENDENCY_GRAPH_RESPONSE_SCHEMA_VERSION, projectDependencyGraph } from "@shared/types/dependency-graph";
import { errorResponse } from "../lib/api-response";
import { jsonSafetyScoreSnapshotResponse } from "../lib/safety-score-v9/http-response";
import { loadActiveSafetyScoreCohort } from "../lib/safety-score-active-source";

/** Free graph projection of the accepted V9 publication, including held snapshots. */
export const handleDependencyGraph = async (db: D1Database): Promise<Response> => {
  const active = await loadActiveSafetyScoreCohort(db);
  if (active.kind === "error") return errorResponse(503, active.detail);
  return jsonSafetyScoreSnapshotResponse(active.snapshot, projectDependencyGraph(active.snapshot),
    `dependency-graph-v${DEPENDENCY_GRAPH_RESPONSE_SCHEMA_VERSION}`);
};
