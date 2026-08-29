import { isRecord } from "@shared/lib/type-guards";
import type { RawStatusComputation } from "../status-evaluation";
import { getCache, setCacheIfNewer } from "../db-cache";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  STATUS_SYSTEM_FRESHNESS_SEC,
  type StatusLevel,
} from "../status-reliability-shared";
import { logWorkerEvent } from "../structured-log";

export const STATUS_RAW_SNAPSHOT_CACHE_KEY = "status:raw-snapshot:v1";
export const STATUS_RAW_SNAPSHOT_MAX_AGE_SEC = STATUS_SYSTEM_FRESHNESS_SEC;
const SNAPSHOT_RECENT_RUN_LIMIT = 10;
const SNAPSHOT_STALE_ARTIFACT_LIMIT = 8;
const SNAPSHOT_METADATA_DEPTH_LIMIT = 5;
const SNAPSHOT_METADATA_ARRAY_LIMIT = 40;
const SNAPSHOT_METADATA_OBJECT_KEY_LIMIT = 80;
const SNAPSHOT_STRING_LIMIT = 2_000;

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

function isStatusLevel(value: unknown): value is StatusLevel {
  return value === "healthy" || value === "degraded" || value === "stale";
}

function truncateString(value: string, limit = SNAPSHOT_STRING_LIMIT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}... [truncated ${value.length - limit} chars]`;
}

function compactSnapshotValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= SNAPSHOT_METADATA_DEPTH_LIMIT) return "[truncated-depth]";
    return value
      .slice(0, SNAPSHOT_METADATA_ARRAY_LIMIT)
      .map((entry) => compactSnapshotValue(entry, depth + 1));
  }
  if (!isRecord(value)) return null;
  if (depth >= SNAPSHOT_METADATA_DEPTH_LIMIT) return "[truncated-depth]";

  const compacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, SNAPSHOT_METADATA_OBJECT_KEY_LIMIT)) {
    compacted[key] = compactSnapshotValue(entry, depth + 1);
  }
  return compacted;
}

function compactCronRunForSnapshot(run: unknown, options: { includeMetadata: boolean }): unknown {
  if (!isRecord(run)) return run;
  const compacted: Record<string, unknown> = {};
  for (const key of ["startedAt", "durationMs", "status", "itemCount"] as const) {
    if (key in run) compacted[key] = run[key];
  }
  if (typeof run.error === "string") {
    compacted.error = truncateString(run.error);
  } else if (run.error != null) {
    compacted.error = compactSnapshotValue(run.error);
  }
  if (options.includeMetadata && run.metadata != null) {
    compacted.metadata = compactSnapshotValue(run.metadata);
  }
  return compacted;
}

function compactCronStatusForSnapshot(status: unknown): unknown {
  if (!isRecord(status)) return status;
  const compacted: Record<string, unknown> = { ...status };

  if (status.lastRun != null) {
    compacted.lastRun = compactCronRunForSnapshot(status.lastRun, { includeMetadata: true });
  }
  if (Array.isArray(status.recentRuns)) {
    compacted.recentRuns = status.recentRuns
      .slice(0, SNAPSHOT_RECENT_RUN_LIMIT)
      .map((run, index) => compactCronRunForSnapshot(run, { includeMetadata: index === 0 }));
  }
  if (status.inFlight != null) {
    compacted.inFlight = compactSnapshotValue(status.inFlight);
  }
  if (Array.isArray(status.staleArtifacts)) {
    compacted.staleArtifacts = status.staleArtifacts
      .slice(0, SNAPSHOT_STALE_ARTIFACT_LIMIT)
      .map((artifact) => compactSnapshotValue(artifact));
  }
  return compacted;
}

function compactRawStatusForSnapshot(raw: RawStatusComputation): RawStatusComputation {
  if (!isRecord(raw.crons)) return raw;
  return {
    ...raw,
    crons: Object.fromEntries(
      Object.entries(raw.crons).map(([job, status]) => [job, compactCronStatusForSnapshot(status)]),
    ) as RawStatusComputation["crons"],
  };
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
      raw: {
        ...parsed.raw,
        budgetOnlySurfaces: Array.isArray(parsed.raw.budgetOnlySurfaces)
          ? parsed.raw.budgetOnlySurfaces as RawStatusComputation["budgetOnlySurfaces"]
          : [],
      },
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
    const cached = await getCache(db, STATUS_RAW_SNAPSHOT_CACHE_KEY);
    if (!cached) {
      return {
        kind: "missing",
        updatedAt: null,
        ageSec: null,
        maxAgeSec,
      };
    }

    const ageSec = Math.max(0, now - cached.updatedAt);
    if (ageSec > maxAgeSec) {
      return {
        kind: "stale",
        updatedAt: cached.updatedAt,
        ageSec,
        maxAgeSec,
      };
    }

    const payload = parseStatusRawSnapshotPayload(cached.value);
    if (!payload) {
      return {
        kind: "unreadable",
        updatedAt: cached.updatedAt,
        ageSec,
        maxAgeSec,
        error: "invalid status raw snapshot payload",
      };
    }

    return {
      kind: "fresh",
      raw: payload.raw,
      updatedAt: cached.updatedAt,
      ageSec,
      maxAgeSec,
    };
  } catch (error) {
    return {
      kind: "read-error",
      updatedAt: null,
      ageSec: null,
      maxAgeSec,
      error: toErrorMessage(error),
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
    raw: compactRawStatusForSnapshot(raw),
  };

  try {
    const { written } = await setCacheIfNewer(
      db,
      STATUS_RAW_SNAPSHOT_CACHE_KEY,
      JSON.stringify(payload),
      now,
    );
    return written;
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
