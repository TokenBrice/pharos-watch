import { DependencyScenarioArtifactSchema, DEPENDENCY_SCENARIOS_CACHE_PREFIX, dependencyScenarioFreshness, type DependencyScenarioArtifact, type DependencyScenariosResponse } from "@shared/types/dependency-scenarios";
import { reassembleDependencyScenarioPayload } from "@shared/lib/dependency-scenario-storage";
import { DependencyScenarioChunkManifestSchema, DEPENDENCY_SCENARIO_CHUNK_STORAGE_FORMAT, DEPENDENCY_SCENARIO_READER_CAPABILITY_HEADER, DEPENDENCY_SCENARIO_READER_VERSION_HEADER } from "@shared/types/dependency-scenario-storage";
import { jsonResponse } from "../lib/api-response";
import { loadActiveSafetyScoreIdentity } from "../lib/safety-score-active-source";

/** Read-only hypothetical lane. Canonical publishers never read these keys. */
export async function handleDependencyScenarios(db: D1Database, workerVersionId?: string | null): Promise<Response> {
  let artifact: DependencyScenarioArtifact | null = null;
  let readFailure: string | null = null;
  try {
    const marker = await db.prepare("SELECT value FROM cache WHERE key = ?").bind(`${DEPENDENCY_SCENARIOS_CACHE_PREFIX}latest`).first<{ value: string }>();
    if (marker?.value.startsWith(`${DEPENDENCY_SCENARIOS_CACHE_PREFIX}artifact:`)) {
      const row = await db.prepare("SELECT value FROM cache WHERE key = ?").bind(marker.value).first<{ value: string }>();
      if (row) {
        const stored: unknown = JSON.parse(row.value);
        const manifest = DependencyScenarioChunkManifestSchema.safeParse(stored);
        if (manifest.success) {
          const chunks = await db.prepare("SELECT chunk_index,value,byte_length,sha256 FROM dependency_scenario_payload_chunks WHERE payload_id = ? ORDER BY chunk_index").bind(marker.value).all();
          const digest = marker.value.slice(`${DEPENDENCY_SCENARIOS_CACHE_PREFIX}artifact:`.length);
          artifact = DependencyScenarioArtifactSchema.parse(JSON.parse(reassembleDependencyScenarioPayload(manifest.data, chunks.results, digest)));
        } else {
          // Existing single-row artifacts remain readable throughout rollout.
          artifact = DependencyScenarioArtifactSchema.parse(stored);
        }
      }
    }
  } catch {
    readFailure = "artifact-read-failed";
  }
  const active = await loadActiveSafetyScoreIdentity(db);
  const freshness = dependencyScenarioFreshness(artifact, active.safetyScoreIdentity?.publicationGenerationId ?? null, Math.floor(Date.now() / 1000));
  if (readFailure) freshness.reason = readFailure;
  const body: DependencyScenariosResponse = { artifact, freshness };
  // No intermediary cache may turn a changed accepted generation into current.
  return jsonResponse(body, { headers: {
    "Cache-Control": "no-store",
    [DEPENDENCY_SCENARIO_READER_CAPABILITY_HEADER]: DEPENDENCY_SCENARIO_CHUNK_STORAGE_FORMAT,
    ...(workerVersionId ? { [DEPENDENCY_SCENARIO_READER_VERSION_HEADER]: workerVersionId } : {}),
  } });
}
