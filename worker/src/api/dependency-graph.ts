import { DEPENDENCY_GRAPH_RESPONSE_SCHEMA_VERSION, projectDependencyGraph } from "@shared/types/dependency-graph";
import { errorResponse, jsonSafetyScoreSnapshotResponse } from "../lib/api-response";
import { loadActiveSafetyScoreCohort } from "../lib/safety-score-active-source";
import { logWorkerEvent } from "../lib/structured-log";

/** Free graph projection of the accepted V9 publication, including held snapshots. */
export const handleDependencyGraph = async (db: D1Database): Promise<Response> => {
  const active = await loadActiveSafetyScoreCohort(db);
  if (active.projectionFallbackCount > 0) logWorkerEvent({
    scope: "api", level: "warn", event: "safety-cohort-reader-fallback", route: "/api/dependency-graph/v1",
    message: "Dependency graph read used the transitional cohort fallback",
    metadata: { safetyProjectionFallbackCount: active.projectionFallbackCount },
  });
  if (active.kind === "error") return errorResponse(503, active.detail);
  return jsonSafetyScoreSnapshotResponse(active.snapshot, projectDependencyGraph(active.snapshot),
    `dependency-graph-v${DEPENDENCY_GRAPH_RESPONSE_SCHEMA_VERSION}`);
};
