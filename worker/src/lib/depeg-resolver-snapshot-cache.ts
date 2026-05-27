import { DdrResponseSchema, type DdrResponse } from "@shared/types/depeg-resolver";
import {
  DDR_METHODOLOGY_VERSION,
  DDR_SNAPSHOT_CACHE_GENERATION as CURRENT_DDR_SNAPSHOT_CACHE_GENERATION,
} from "@shared/lib/depeg-resolver-version";
import { decodeCachedJson } from "./cache-json";
import { getCache, setCache } from "./db-cache";

const DDR_SNAPSHOT_CACHE_KEY = "depeg-resolver:snapshot";
export const DDR_SNAPSHOT_CACHE_GENERATION = CURRENT_DDR_SNAPSHOT_CACHE_GENERATION;

export type DdrSnapshotCacheFailureReason =
  | "missing-cache"
  | "json-parse-failed"
  | "invalid-payload"
  | "invalid-envelope"
  | "generation-mismatch"
  | "methodology-mismatch";

interface DdrSnapshotCacheEnvelope {
  generation: number;
  methodologyVersion: string;
  payload: DdrResponse;
}

export type DdrSnapshotCacheLoadResult =
  | { kind: "ok"; payload: DdrResponse; updatedAt: number }
  | { kind: "error"; reason: DdrSnapshotCacheFailureReason; updatedAt: number | null };

export async function loadDepegResolverSnapshot(db: D1Database): Promise<DdrSnapshotCacheLoadResult> {
  const decoded = decodeCachedJson<DdrResponse, DdrSnapshotCacheFailureReason>(
    await getCache(db, DDR_SNAPSHOT_CACHE_KEY),
    {
      mode: "strict",
      missingReason: "missing-cache",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        if (!parsed || typeof parsed !== "object" || !("payload" in parsed)) {
          return { ok: false, reason: "invalid-envelope" };
        }
        const envelope = parsed as Partial<DdrSnapshotCacheEnvelope>;
        if (envelope.generation !== DDR_SNAPSHOT_CACHE_GENERATION) {
          return { ok: false, reason: "generation-mismatch" };
        }
        if (envelope.methodologyVersion !== DDR_METHODOLOGY_VERSION) {
          return { ok: false, reason: "methodology-mismatch" };
        }
        const result = DdrResponseSchema.safeParse(envelope.payload);
        if (!result.success) {
          return { ok: false, reason: "invalid-payload" };
        }
        if (result.data.methodology.version !== DDR_METHODOLOGY_VERSION) {
          return { ok: false, reason: "methodology-mismatch" };
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

export async function writeDepegResolverSnapshot(db: D1Database, snapshot: DdrResponse): Promise<void> {
  const result = DdrResponseSchema.safeParse(snapshot);
  if (!result.success) {
    throw new Error(`Invalid depeg-resolver snapshot payload: ${result.error.message}`);
  }
  if (result.data.methodology.version !== DDR_METHODOLOGY_VERSION) {
    throw new Error(
      `Depeg-resolver snapshot methodology ${result.data.methodology.version} does not match ${DDR_METHODOLOGY_VERSION}`,
    );
  }
  const envelope: DdrSnapshotCacheEnvelope = {
    generation: DDR_SNAPSHOT_CACHE_GENERATION,
    methodologyVersion: DDR_METHODOLOGY_VERSION,
    payload: result.data,
  };
  await setCache(db, DDR_SNAPSHOT_CACHE_KEY, JSON.stringify(envelope));
}
