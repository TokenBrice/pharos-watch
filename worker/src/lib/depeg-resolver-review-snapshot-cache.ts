import {
  DDR_METHODOLOGY_VERSION,
  DDRR_REVIEWER_VERSION,
  DDRR_SNAPSHOT_CACHE_GENERATION as CURRENT_DDRR_SNAPSHOT_CACHE_GENERATION,
} from "@shared/lib/depeg-resolver-version";
import { DdrrResponseSchema, type DdrrResponse } from "@shared/types/depeg-resolver-review";
import { decodeCachedJson } from "./cache-json";
import { getCache, setCache } from "./db-cache";

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

interface DdrrSnapshotCacheEnvelope {
  generation: number;
  methodologyVersion: string;
  reviewerVersion: string;
  payload: DdrrResponse;
}

export type DdrrSnapshotCacheLoadResult =
  | { kind: "ok"; payload: DdrrResponse; updatedAt: number }
  | { kind: "error"; reason: DdrrSnapshotCacheFailureReason; updatedAt: number | null };

export async function loadDepegResolverReviewSnapshot(db: D1Database): Promise<DdrrSnapshotCacheLoadResult> {
  const decoded = decodeCachedJson<DdrrResponse, DdrrSnapshotCacheFailureReason>(
    await getCache(db, DDRR_SNAPSHOT_CACHE_KEY),
    {
      mode: "strict",
      missingReason: "missing-cache",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        if (!parsed || typeof parsed !== "object" || !("payload" in parsed)) {
          return { ok: false, reason: "invalid-envelope" };
        }
        const envelope = parsed as Partial<DdrrSnapshotCacheEnvelope>;
        if (envelope.generation !== DDRR_SNAPSHOT_CACHE_GENERATION) {
          return { ok: false, reason: "generation-mismatch" };
        }
        if (envelope.methodologyVersion !== DDR_METHODOLOGY_VERSION) {
          return { ok: false, reason: "methodology-mismatch" };
        }
        if (envelope.reviewerVersion !== DDRR_REVIEWER_VERSION) {
          return { ok: false, reason: "reviewer-version-mismatch" };
        }
        const result = DdrrResponseSchema.safeParse(envelope.payload);
        if (!result.success) {
          return { ok: false, reason: "invalid-payload" };
        }
        if (result.data.methodology.version !== DDR_METHODOLOGY_VERSION) {
          return { ok: false, reason: "methodology-mismatch" };
        }
        if (result.data._meta.reviewerVersion !== DDRR_REVIEWER_VERSION) {
          return { ok: false, reason: "reviewer-version-mismatch" };
        }
        return { ok: true, payload: result.data };
      },
    },
  );

  if (!decoded.ok) {
    return { kind: "error", reason: decoded.reason, updatedAt: decoded.updatedAt };
  }
  return { kind: "ok", payload: decoded.payload, updatedAt: decoded.payload._meta.computedAt };
}

export async function writeDepegResolverReviewSnapshot(db: D1Database, snapshot: DdrrResponse): Promise<void> {
  const result = DdrrResponseSchema.safeParse(snapshot);
  if (!result.success) {
    throw new Error(`Invalid depeg-resolver-review snapshot payload: ${result.error.message}`);
  }
  if (result.data.methodology.version !== DDR_METHODOLOGY_VERSION) {
    throw new Error(
      `Depeg-resolver-review snapshot methodology ${result.data.methodology.version} does not match ${DDR_METHODOLOGY_VERSION}`,
    );
  }
  if (result.data._meta.reviewerVersion !== DDRR_REVIEWER_VERSION) {
    throw new Error(
      `Depeg-resolver-review snapshot version ${result.data._meta.reviewerVersion} does not match ${DDRR_REVIEWER_VERSION}`,
    );
  }
  const envelope: DdrrSnapshotCacheEnvelope = {
    generation: DDRR_SNAPSHOT_CACHE_GENERATION,
    methodologyVersion: DDR_METHODOLOGY_VERSION,
    reviewerVersion: DDRR_REVIEWER_VERSION,
    payload: result.data,
  };
  await setCache(db, DDRR_SNAPSHOT_CACHE_KEY, JSON.stringify(envelope));
}
