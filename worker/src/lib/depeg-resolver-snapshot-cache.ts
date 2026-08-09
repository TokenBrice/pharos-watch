import { DdrResponseSchema, type DdrResponse } from "@shared/types/depeg-resolver";
import {
  DDR_METHODOLOGY_VERSION,
  DDR_SNAPSHOT_CACHE_GENERATION as CURRENT_DDR_SNAPSHOT_CACHE_GENERATION,
} from "@shared/lib/methodology-versions/depeg-resolver";
import {
  loadVersionedSnapshotCache,
  writeVersionedSnapshotCache,
  type VersionedSnapshotCacheLoadResult,
  type VersionedSnapshotCacheOptions,
} from "./versioned-snapshot-cache";

const DDR_SNAPSHOT_CACHE_KEY = "depeg-resolver:snapshot";
export const DDR_SNAPSHOT_CACHE_GENERATION = CURRENT_DDR_SNAPSHOT_CACHE_GENERATION;

export type DdrSnapshotCacheFailureReason =
  | "missing-cache"
  | "json-parse-failed"
  | "invalid-payload"
  | "invalid-envelope"
  | "generation-mismatch"
  | "methodology-mismatch";

export type DdrSnapshotCacheLoadResult = VersionedSnapshotCacheLoadResult<DdrResponse, DdrSnapshotCacheFailureReason>;

const DDR_SNAPSHOT_CACHE_OPTIONS: VersionedSnapshotCacheOptions<DdrResponse, DdrSnapshotCacheFailureReason> = {
  cacheKey: DDR_SNAPSHOT_CACHE_KEY,
  label: "depeg-resolver",
  generation: DDR_SNAPSHOT_CACHE_GENERATION,
  methodologyVersion: DDR_METHODOLOGY_VERSION,
  schema: DdrResponseSchema,
  reasons: {
    missingCache: "missing-cache",
    jsonParseFailed: "json-parse-failed",
    invalidPayload: "invalid-payload",
    invalidEnvelope: "invalid-envelope",
    generationMismatch: "generation-mismatch",
    methodologyMismatch: "methodology-mismatch",
  },
  getUpdatedAt: (payload) => payload._meta.computedAt,
  validatePayload: (payload) => (
    payload.methodology.version === DDR_METHODOLOGY_VERSION
      ? null
      : {
          reason: "methodology-mismatch",
          message: `Depeg-resolver snapshot methodology ${payload.methodology.version} does not match ${DDR_METHODOLOGY_VERSION}`,
        }
  ),
};

export async function loadDepegResolverSnapshot(db: D1Database): Promise<DdrSnapshotCacheLoadResult> {
  return loadVersionedSnapshotCache(db, DDR_SNAPSHOT_CACHE_OPTIONS);
}

export async function writeDepegResolverSnapshot(db: D1Database, snapshot: DdrResponse): Promise<void> {
  await writeVersionedSnapshotCache(db, snapshot, DDR_SNAPSHOT_CACHE_OPTIONS);
}
