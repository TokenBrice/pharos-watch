import type { RawStatusComputation } from "../status-evaluation";
import {
  STATUS_SYSTEM_FRESHNESS_SEC,
  type StatusLevel,
} from "../status-reliability-shared";
import { logWorkerEvent } from "../structured-log";

export const STATUS_RAW_SNAPSHOT_CACHE_KEY = "status:raw-snapshot:v1";
export const STATUS_RAW_SNAPSHOT_MAX_AGE_SEC = STATUS_SYSTEM_FRESHNESS_SEC;

interface StatusRawSnapshotPayload {
  version: 1;
  producedAt: number;
  raw: RawStatusComputation;
}

interface FreshStatusRawSnapshot {
  kind: "fresh";
  raw: RawStatusComputation;
  updatedAt: number;
  ageSec: number;
  maxAgeSec: number;
}

interface UnavailableStatusRawSnapshot {
  kind: "missing" | "stale" | "unreadable" | "read-error";
  updatedAt: number | null;
  ageSec: number | null;
  maxAgeSec: number;
  error?: string;
}

export type StatusRawSnapshotLoadResult = FreshStatusRawSnapshot | UnavailableStatusRawSnapshot;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatusLevel(value: unknown): value is StatusLevel {
  return value === "healthy" || value === "degraded" || value === "stale";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasRawStatusShape(value: unknown): value is RawStatusComputation {
  if (!isRecord(value)) return false;
  return (
    typeof value.dbHealthy === "boolean" &&
    isStatusLevel(value.availabilityStatus) &&
    isStatusLevel(value.dataQualityStatus) &&
    isStatusLevel(value.rawOverallStatus) &&
    typeof value.confidence === "number" &&
    isRecord(value.causes) &&
    isRecord(value.caches) &&
    isRecord(value.crons) &&
    isRecord(value.dataQuality) &&
    (value.telegramBot === null || isRecord(value.telegramBot)) &&
    isRecord(value.sectionErrors) &&
    isRecord(value.datasetFreshness) &&
    isRecord(value.summary) &&
    isRecord(value.reserveComposition) &&
    Array.isArray(value.freshnessDiagnostics)
  );
}

function parseStatusRawSnapshotPayload(value: string): StatusRawSnapshotPayload | null {
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    if (parsed.version !== 1) return null;
    if (typeof parsed.producedAt !== "number" || !Number.isFinite(parsed.producedAt)) return null;
    if (!hasRawStatusShape(parsed.raw)) return null;
    return {
      version: 1,
      producedAt: parsed.producedAt,
      raw: parsed.raw,
    };
  } catch {
    return null;
  }
}

export async function loadStatusRawSnapshot(
  db: D1Database,
  now: number,
  maxAgeSec = STATUS_RAW_SNAPSHOT_MAX_AGE_SEC,
): Promise<StatusRawSnapshotLoadResult> {
  try {
    const row = await db
      .prepare("SELECT value, updated_at FROM cache WHERE key = ?")
      .bind(STATUS_RAW_SNAPSHOT_CACHE_KEY)
      .first<{ value: string; updated_at: number }>();
    if (!row) {
      return {
        kind: "missing",
        updatedAt: null,
        ageSec: null,
        maxAgeSec,
      };
    }

    const ageSec = Math.max(0, now - row.updated_at);
    if (ageSec > maxAgeSec) {
      return {
        kind: "stale",
        updatedAt: row.updated_at,
        ageSec,
        maxAgeSec,
      };
    }

    const payload = parseStatusRawSnapshotPayload(row.value);
    if (!payload) {
      return {
        kind: "unreadable",
        updatedAt: row.updated_at,
        ageSec,
        maxAgeSec,
        error: "invalid status raw snapshot payload",
      };
    }

    return {
      kind: "fresh",
      raw: payload.raw,
      updatedAt: row.updated_at,
      ageSec,
      maxAgeSec,
    };
  } catch (error) {
    return {
      kind: "read-error",
      updatedAt: null,
      ageSec: null,
      maxAgeSec,
      error: getErrorMessage(error),
    };
  }
}

export async function writeStatusRawSnapshot(
  db: D1Database,
  now: number,
  raw: RawStatusComputation,
): Promise<boolean> {
  const payload: StatusRawSnapshotPayload = {
    version: 1,
    producedAt: now,
    raw,
  };

  try {
    const result = await db
      .prepare(
        `INSERT INTO cache (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
         WHERE cache.updated_at <= excluded.updated_at`,
      )
      .bind(STATUS_RAW_SNAPSHOT_CACHE_KEY, JSON.stringify(payload), now)
      .run();
    return (result.meta.changes ?? 0) > 0;
  } catch (error) {
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "raw_status_snapshot_persist_failed",
      route: "status",
      source: STATUS_RAW_SNAPSHOT_CACHE_KEY,
      message: "Failed to persist raw status snapshot",
      error,
    });
    return false;
  }
}
