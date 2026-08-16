import {
  DDR_METHODOLOGY_VERSION,
  DDRR_REVIEWER_VERSION,
  DDRR_SNAPSHOT_CACHE_GENERATION as CURRENT_DDRR_SNAPSHOT_CACHE_GENERATION,
} from "@shared/lib/methodology-versions/depeg-resolver";
import { DdrrResponseSchema, type DdrrResponse } from "@shared/types/depeg-resolver-review";
import {
  loadVersionedSnapshotCache,
  writeVersionedSnapshotCache,
  type VersionedSnapshotCacheEnvelope,
  type VersionedSnapshotCacheLoadResult,
  type VersionedSnapshotCacheOptions,
} from "./versioned-snapshot-cache";

const DDRR_SNAPSHOT_CACHE_KEY = "depeg-resolver-review:snapshot";
export const DDRR_SNAPSHOT_CACHE_GENERATION = CURRENT_DDRR_SNAPSHOT_CACHE_GENERATION;

export type DdrrSnapshotCacheFailureReason =
  | "missing-cache"
  | "json-parse-failed"
  | "invalid-payload"
  | "invalid-envelope"
  | "generation-mismatch"
  | "methodology-mismatch"
  | "reviewer-version-mismatch";

export type DdrrSnapshotCacheLoadResult = VersionedSnapshotCacheLoadResult<
  DdrrResponse,
  DdrrSnapshotCacheFailureReason
>;

const DDRR_SNAPSHOT_CACHE_OPTIONS: VersionedSnapshotCacheOptions<DdrrResponse, DdrrSnapshotCacheFailureReason> = {
  cacheKey: DDRR_SNAPSHOT_CACHE_KEY,
  retention: {
    storage: "d1-kv",
    schemaId: "depeg-resolver-review:snapshot-envelope",
    ttlSec: null,
    maxEntries: 1,
    stale: "accept",
    invalid: "retain",
  },
  label: "depeg-resolver-review",
  generation: DDRR_SNAPSHOT_CACHE_GENERATION,
  methodologyVersion: DDR_METHODOLOGY_VERSION,
  schema: DdrrResponseSchema,
  reasons: {
    missingCache: "missing-cache",
    jsonParseFailed: "json-parse-failed",
    invalidPayload: "invalid-payload",
    invalidEnvelope: "invalid-envelope",
    generationMismatch: "generation-mismatch",
    methodologyMismatch: "methodology-mismatch",
  },
  getUpdatedAt: (payload) => payload._meta.computedAt,
  validateEnvelope: (envelope: VersionedSnapshotCacheEnvelope<unknown>) => (
    envelope.reviewerVersion === DDRR_REVIEWER_VERSION ? null : "reviewer-version-mismatch"
  ),
  validatePayload: (payload) => {
    if (payload.methodology.version !== DDR_METHODOLOGY_VERSION) {
      return {
        reason: "methodology-mismatch",
        message: `Depeg-resolver-review snapshot methodology ${payload.methodology.version} does not match ${DDR_METHODOLOGY_VERSION}`,
      };
    }
    if (payload._meta.reviewerVersion !== DDRR_REVIEWER_VERSION) {
      return {
        reason: "reviewer-version-mismatch",
        message: `Depeg-resolver-review snapshot version ${payload._meta.reviewerVersion} does not match ${DDRR_REVIEWER_VERSION}`,
      };
    }
    return null;
  },
  envelopeExtras: () => ({ reviewerVersion: DDRR_REVIEWER_VERSION }),
};

export async function loadDepegResolverReviewSnapshot(db: D1Database): Promise<DdrrSnapshotCacheLoadResult> {
  return loadVersionedSnapshotCache(db, DDRR_SNAPSHOT_CACHE_OPTIONS);
}

export async function writeDepegResolverReviewSnapshot(db: D1Database, snapshot: DdrrResponse): Promise<void> {
  await writeVersionedSnapshotCache(db, snapshot, DDRR_SNAPSHOT_CACHE_OPTIONS);
}
