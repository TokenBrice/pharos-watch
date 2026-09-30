import { DependencyScenarioArtifactSchema, DEPENDENCY_SCENARIOS_CACHE_PREFIX, dependencyScenarioFreshness, type DependencyScenarioArtifact, type DependencyScenariosResponse } from "@shared/types/dependency-scenarios";
import { jsonResponse } from "../lib/api-response";
import { loadActiveSafetyScoreIdentity } from "../lib/safety-score-active-source";

/** Read-only hypothetical lane. Canonical publishers never read these keys. */
export async function handleDependencyScenarios(db: D1Database): Promise<Response> {
  let artifact: DependencyScenarioArtifact | null = null;
  let readFailure: string | null = null;
  try {
    const marker = await db.prepare("SELECT value FROM cache WHERE key = ?").bind(`${DEPENDENCY_SCENARIOS_CACHE_PREFIX}latest`).first<{ value: string }>();
    if (marker?.value.startsWith(`${DEPENDENCY_SCENARIOS_CACHE_PREFIX}artifact:`)) {
      const row = await db.prepare("SELECT value FROM cache WHERE key = ?").bind(marker.value).first<{ value: string }>();
      if (row) artifact = DependencyScenarioArtifactSchema.parse(JSON.parse(row.value));
    }
  } catch {
    readFailure = "artifact-read-failed";
  }
  const active = await loadActiveSafetyScoreIdentity(db);
  const freshness = dependencyScenarioFreshness(artifact, active.safetyScoreIdentity?.publicationGenerationId ?? null, Math.floor(Date.now() / 1000));
  if (readFailure) freshness.reason = readFailure;
  const body: DependencyScenariosResponse = { artifact, freshness };
  // No intermediary cache may turn a changed accepted generation into current.
  return jsonResponse(body, { headers: { "Cache-Control": "no-store" } });
}
