import { toErrorMessage } from "@shared/lib/error-utils";
import type { ZodType } from "zod";
import { assessFreshnessTimestamp } from "../api-freshness-age";
import { getCache, setCacheIfNewer } from "../db-cache";
import { parseJsonObjectWithSchema } from "../json-parse";
import { logWorkerEvent } from "../structured-log";

/**
 * Shared admission for the self-check's persisted status snapshots. Each key has
 * its own writer and schema; a reader validates only the payload it needs.
 * Payloads share a versioned generation envelope; each schema owns its version.
 */
export interface FreshStatusSnapshot<T> {
  kind: "fresh";
  payload: T;
  updatedAt: number;
  ageSec: number;
  maxAgeSec: number;
}

export interface UnavailableStatusSnapshot<T = never> {
  kind: "missing" | "stale" | "unreadable" | "read-error";
  updatedAt: number | null;
  ageSec: number | null;
  maxAgeSec: number;
  error?: string;
  /** Stale only: the last publication, never served as fresh (a hold applies it over a live read). */
  payload?: T;
}

export type StatusSnapshotLoadResult<T> = FreshStatusSnapshot<T> | UnavailableStatusSnapshot<T>;

interface StatusSnapshotEnvelope {
  version: number;
  producedAt: number;
}

export async function loadStatusSnapshotPayload<T extends Record<string, unknown> & StatusSnapshotEnvelope>(
  db: D1Database,
  key: string,
  schema: ZodType<T>,
  now: number,
  maxAgeSec: number,
): Promise<StatusSnapshotLoadResult<T>> {
  try {
    const cached = await getCache(db, key);
    if (!cached) return { kind: "missing", updatedAt: null, ageSec: null, maxAgeSec };

    const timestamp = assessFreshnessTimestamp(now, cached.updatedAt);
    if (timestamp.reason != null) {
      return { kind: "unreadable", updatedAt: cached.updatedAt, ageSec: null, maxAgeSec, error: timestamp.reason };
    }
    const ageSec = timestamp.ageSeconds;
    const payload = parseJsonObjectWithSchema(cached.value, schema);
    const generationTimestamp = assessFreshnessTimestamp(now, payload?.producedAt);
    if (ageSec > maxAgeSec) {
      // A stale payload is usable only with an admitted generation clock.
      const usable = payload && generationTimestamp.reason == null ? { payload } : {};
      return { kind: "stale", updatedAt: cached.updatedAt, ageSec, maxAgeSec, ...usable };
    }
    if (!payload) {
      return { kind: "unreadable", updatedAt: cached.updatedAt, ageSec, maxAgeSec, error: `invalid ${key} payload` };
    }
    if (generationTimestamp.reason != null) {
      return { kind: "unreadable", updatedAt: cached.updatedAt, ageSec: null, maxAgeSec, error: generationTimestamp.reason };
    }
    return { kind: "fresh", payload, updatedAt: cached.updatedAt, ageSec, maxAgeSec };
  } catch (error) {
    return { kind: "read-error", updatedAt: null, ageSec: null, maxAgeSec, error: toErrorMessage(error) };
  }
}

/** Monotonic write (`setCacheIfNewer`); `false` when not written or the write failed. */
export async function writeStatusSnapshotPayload<T extends StatusSnapshotEnvelope>(
  db: D1Database,
  key: string,
  now: number,
  payload: T,
): Promise<boolean> {
  try {
    const { written } = await setCacheIfNewer(db, key, JSON.stringify(payload), now);
    return written;
  } catch (error) {
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "status_snapshot_persist_failed",
      route: "status",
      source: key,
      message: "Failed to persist status snapshot",
      error,
    });
    return false;
  }
}
