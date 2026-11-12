import { LIVE_RESERVE_STRUCTURAL_DEGRADED_WARNING_CODES } from "@shared/lib/live-reserve-reliability";
import { LIVE_RESERVE_WARNING_EFFECT_VALUES } from "@shared/types/live-reserve-core";
import { ReserveSyncAdapterReliabilitySchema, type ReserveSyncAdapterReliability, type ReserveSyncStatus } from "@shared/types/live-reserves";
import { getCaches, setCache } from "../db-cache";
import { sleepWithSignal } from "../abort";
import { D1_RESOURCE_WINDOW_MS, runWithOverloadRetry } from "../d1-overload-retry";
import { parseJsonObject } from "../json-parse";
import { logWorkerEvent } from "../structured-log";
import { LIVE_RESERVE_HISTORY_RETENTION_SEC } from "./store-shared";

/**
 * Read surfaces for `reserve_sync_attempt_history`, the append-only per-attempt
 * ledger. The table retains ~46k rows over its 30-day retention window but had
 * no production read path; these two queries turn it from write-only forensics
 * into operator-facing triage and coverage-ranking signals.
 */

export interface ReserveSyncAttemptTimelineEntry {
  stablecoinId: string;
  attemptedAt: number;
  adapterKey: string;
  breakerKey: string;
  attemptId: string | null;
  status: ReserveSyncStatus;
  failureCategory: string | null;
  warningCodes: string[];
  lastError: string | null;
  /** Adapter/cron wall-clock instrumentation, read from current top-level metadata with legacy `metadata.diag` fallback. */
  durationMs: number | null;
}

interface AttemptHistoryRow {
  stablecoin_id: string;
  attempted_at: number;
  adapter_key: string;
  breaker_key: string;
  attempt_id: string | null;
  status: string;
  warnings: string | null;
  last_error: string | null;
  metadata: string | null;
}

interface ReliabilityRow {
  adapter_key: string;
  attempts: number;
  ok_count: number;
  degraded_count: number;
  degraded_by_design_count: number;
  error_count: number;
  skipped_count: number;
}


function parseDiagDurationMs(metadata: Record<string, unknown>): number | null {
  const current = metadata.durationMs;
  if (typeof current === "number" && Number.isFinite(current) && current >= 0) return current;
  const diag = metadata.diag;
  if (diag == null || typeof diag !== "object" || Array.isArray(diag) || !("durationMs" in diag)) {
    return null;
  }
  const durationMs = diag.durationMs;
  return typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null;
}

function parseWarningCodes(value: string | null | undefined): string[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const codes: string[] = [];
  for (const item of parsed as unknown[]) {
    if (item == null || typeof item !== "object" || !("code" in item)) continue;
    const code = item.code;
    if (typeof code === "string") codes.push(code);
  }
  return codes;
}

function mapTimelineRow(row: AttemptHistoryRow): ReserveSyncAttemptTimelineEntry {
  const metadata = parseJsonObject(row.metadata, "reserve-sync-attempt-history.metadata") ?? {};
  return {
    stablecoinId: row.stablecoin_id,
    attemptedAt: row.attempted_at,
    adapterKey: row.adapter_key,
    breakerKey: row.breaker_key,
    attemptId: row.attempt_id ?? null,
    status: row.status as ReserveSyncStatus,
    failureCategory: typeof metadata.failureCategory === "string" ? metadata.failureCategory : null,
    warningCodes: parseWarningCodes(row.warnings),
    lastError: row.last_error ?? null,
    durationMs: parseDiagDurationMs(metadata),
  };
}

/**
 * Last-N attempt timeline for one coin, newest first. Served only through the
 * admin API; it is the first per-coin failure history the reserve lane exposes
 * without log grep.
 */
export async function loadReserveSyncAttemptTimeline(
  db: D1Database,
  stablecoinId: string,
  limit = 50,
): Promise<ReserveSyncAttemptTimelineEntry[]> {
  const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const result = await runWithOverloadRetry(() => db
    .prepare(
      `SELECT stablecoin_id, attempted_at, adapter_key, breaker_key, attempt_id,
              status, warnings, last_error, metadata
         FROM reserve_sync_attempt_history
        WHERE stablecoin_id = ?
        ORDER BY attempted_at DESC, id DESC
        LIMIT ?`,
    )
    .bind(stablecoinId, boundedLimit)
    .all<AttemptHistoryRow>());
  return (result.results ?? []).map(mapTimelineRow);
}

/** Circuit skips may inherit only the latest actual attempt, never an older matching failure. */
export async function loadLatestNonSkippedReserveAttempt(
  db: D1Database,
  stablecoinId: string,
): Promise<ReserveSyncAttemptTimelineEntry | null> {
  const row = await db.prepare(
    `SELECT stablecoin_id, attempted_at, adapter_key, breaker_key, attempt_id,
            status, warnings, last_error, metadata
       FROM reserve_sync_attempt_history
      WHERE stablecoin_id = ? AND status != 'skipped'
      ORDER BY attempted_at DESC, id DESC LIMIT 1`,
  ).bind(stablecoinId).first<AttemptHistoryRow>();
  if (!row) return null;
  const metadata = parseJsonObject(row.metadata, "reserve-feed-review-attempt.metadata");
  if (!metadata || metadata.uncertainWrite === true) return null;
  if (row.warnings) {
    try {
      const warnings: unknown = JSON.parse(row.warnings);
      if (!Array.isArray(warnings) || warnings.some((warning: unknown) =>
        warning == null || typeof warning !== "object" || !("code" in warning) || typeof warning.code !== "string"
        || ("effect" in warning && (warning.effect === "fatal"
          || !LIVE_RESERVE_WARNING_EFFECT_VALUES.some((effect) => effect === warning.effect))))) return null;
    } catch { return null; }
  }
  return mapTimelineRow(row);
}

const RESERVE_SYNC_RELIABILITY_ROLLUP_CACHE_KEY = "reserve-sync-reliability-rollup:v1";
const RELIABILITY_REFRESH_ATTEMPT_KEY = "reserve-sync-reliability-rollup:refresh-attempt:v1";
const RESERVE_SYNC_RELIABILITY_ROLLUP_MAX_AGE_SEC = 3_600;

interface ReliabilityRollupCachePayload {
  computedAt: number;
  windowSec: number;
  rows: ReserveSyncAdapterReliability[];
}

// Retain observations across invocation-local D1 wrappers, never refresh authority.
const reliabilityRollups = new Map<number, ReliabilityRollupCachePayload>();

function parseReliabilityRollupCache(value: string): ReliabilityRollupCachePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { computedAt, windowSec, rows } = parsed as Record<string, unknown>;
  if (typeof computedAt !== "number" || !Number.isFinite(computedAt)) return null;
  if (typeof windowSec !== "number" || !Number.isFinite(windowSec)) return null;
  const parsedRows = ReserveSyncAdapterReliabilitySchema.array().safeParse(rows);
  return parsedRows.success ? { computedAt, windowSec, rows: parsedRows.data } : null;
}

/** Status reads retain any-age observations and never claim, scan or write. */
export async function loadReserveSyncReliabilityRollup(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  windowSec = LIVE_RESERVE_HISTORY_RETENTION_SEC,
): Promise<ReliabilityRollupCachePayload> {
  let memo = reliabilityRollups.get(windowSec);
  try {
    const cached = await getCaches(db, [RESERVE_SYNC_RELIABILITY_ROLLUP_CACHE_KEY]);
    const value = cached.get(RESERVE_SYNC_RELIABILITY_ROLLUP_CACHE_KEY)?.value;
    const stored = value ? parseReliabilityRollupCache(value) : null;
    if (stored?.windowSec === windowSec && stored.computedAt <= now
      && (!memo || stored.computedAt > memo.computedAt)) {
      memo = stored;
      reliabilityRollups.set(windowSec, memo);
    }
  } catch { /* A failed cache read cannot invalidate the retained observation. */ }
  if (!memo) throw new Error("Reserve sync reliability rollup unavailable");
  return memo;
}

/** Best-effort event tail; the durable marker admits at most one refresh/hour. */
export async function refreshReserveSyncReliabilityRollup(
  db: D1Database,
  deadlineMs: number,
  signal?: AbortSignal,
  now = Math.floor(Date.now() / 1000),
  windowSec = LIVE_RESERVE_HISTORY_RETENTION_SEC,
): Promise<ReliabilityRollupCachePayload | null> {
  // Leave five seconds for the ~1s scan, retried write and caller settlement.
  const minimumRemainingMs = D1_RESOURCE_WINDOW_MS + 5_000;
  let reason = "deadline-insufficient";
  let payload: ReliabilityRollupCachePayload | null = null;
  let error: unknown;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (signal?.aborted || deadlineMs - Date.now() < minimumRemainingMs) return null;
    const controller = new AbortController();
    deadlineTimer = setTimeout(() => controller.abort(), deadlineMs - Date.now());
    const refreshSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    reason = "marker-claim-failed";
    const claim = await runWithOverloadRetry(() => db.prepare(
      `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        WHERE cache.updated_at <= excluded.updated_at - ?`,
    ).bind(RELIABILITY_REFRESH_ATTEMPT_KEY, String(now), now, RESERVE_SYNC_RELIABILITY_ROLLUP_MAX_AGE_SEC).run(), 3, refreshSignal);
    reason = "refresh-interval-not-elapsed";
    if (claim.meta.changes !== 1) return null;
    reason = "deadline-insufficient";
    if (deadlineMs - Date.now() < minimumRemainingMs) return null;
    // Finalization/pruning/sealing can fill D1's rolling resource window.
    await sleepWithSignal(D1_RESOURCE_WINDOW_MS, refreshSignal);
    if (deadlineMs - Date.now() < 5_000) return null;
    reason = "scan-failed";
    payload = await scanReliabilityRollup(db, now, windowSec, refreshSignal);
    reliabilityRollups.set(windowSec, payload);
    reason = "memo-write-failed";
    await setCache(db, RESERVE_SYNC_RELIABILITY_ROLLUP_CACHE_KEY, JSON.stringify(payload), refreshSignal);
    reason = "refreshed";
    return payload;
  } catch (caught) {
    error = caught;
    return payload;
  } finally {
    clearTimeout(deadlineTimer);
    logWorkerEvent({
      scope: "lib",
      level: error ? "warn" : "info",
      event: "reserve_sync_reliability_rollup_refresh",
      message: "Reserve sync reliability rollup refresh outcome",
      error,
      metadata: { reason, computedAt: payload?.computedAt ?? null },
    });
  }
}

/** Unchanged 30-day grouped scan; structural-only degraded attempts count as successes. */
async function scanReliabilityRollup(
  db: D1Database,
  now: number,
  windowSec: number,
  signal: AbortSignal,
): Promise<ReliabilityRollupCachePayload> {
  const cutoff = now - windowSec;
  const result = await runWithOverloadRetry(() => db
    .prepare(
      // Each warning member mirrors decodeStoredReserveWarnings(): a member that
      // decoder would reject (JS trim() whitespace included) is malformed and
      // disqualifies the attempt, and a missing `effect` defaults to `info` for
      // info severity, otherwise `degraded`. Code/effect vocabularies are bound
      // as JSON arrays (?2, ?3).
      `WITH attempts AS (
         SELECT id, adapter_key, status, warnings
           FROM reserve_sync_attempt_history
          WHERE attempted_at >= ?1
       ),
       members AS (
         SELECT a.id,
                w.type AS member_type,
                json_type(a.warnings, w.fullkey || '.code') AS code_type,
                trim(json_extract(a.warnings, w.fullkey || '.code'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) AS code_trimmed,
                json_extract(a.warnings, w.fullkey || '.code') AS code,
                json_type(a.warnings, w.fullkey || '.message') AS message_type,
                trim(json_extract(a.warnings, w.fullkey || '.message'), char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) AS message_trimmed,
                json_type(a.warnings, w.fullkey || '.severity') AS severity_type,
                json_extract(a.warnings, w.fullkey || '.severity') AS severity,
                json_type(a.warnings, w.fullkey || '.effect') AS effect_type,
                json_extract(a.warnings, w.fullkey || '.effect') AS effect
           FROM attempts a,
                json_each(CASE WHEN a.status = 'degraded' AND json_valid(a.warnings) THEN a.warnings END) w
       ),
       classified AS (
         SELECT id,
                (member_type <> 'object'
                  OR COALESCE(code_type <> 'text' OR code_trimmed = '', 1)
                  OR COALESCE(message_type <> 'text' OR message_trimmed = '', 1)
                  OR (severity_type IS NOT NULL AND COALESCE(severity NOT IN ('info', 'warning'), 1))
                  OR (effect_type IS NOT NULL AND COALESCE(effect NOT IN (SELECT value FROM json_each(?3)), 1))) AS malformed,
                (CASE WHEN effect_type IS NOT NULL THEN effect
                      WHEN severity = 'info' THEN 'info' ELSE 'degraded' END) = 'degraded' AS degrading,
                COALESCE(code IN (SELECT value FROM json_each(?2)), 0) AS structural
           FROM members
       ),
       verdicts AS (
         SELECT id,
                SUM(CASE WHEN malformed OR (degrading AND NOT structural) THEN 1 ELSE 0 END) AS disqualifying,
                SUM(CASE WHEN NOT malformed AND degrading AND structural THEN 1 ELSE 0 END) AS structural_count
           FROM classified
          GROUP BY id
       )
       SELECT a.adapter_key,
              COUNT(*) AS attempts,
              SUM(CASE WHEN a.status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
              SUM(CASE WHEN a.status = 'degraded' THEN 1 ELSE 0 END) AS degraded_count,
              SUM(CASE WHEN a.status = 'degraded'
                        AND (CASE WHEN json_valid(a.warnings) THEN json_type(a.warnings) END) = 'array'
                        AND v.disqualifying = 0 AND v.structural_count > 0
                       THEN 1 ELSE 0 END) AS degraded_by_design_count,
              SUM(CASE WHEN a.status = 'error' THEN 1 ELSE 0 END) AS error_count,
              SUM(CASE WHEN a.status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count
         FROM attempts a
         LEFT JOIN verdicts v ON v.id = a.id
        GROUP BY a.adapter_key
        ORDER BY attempts DESC, a.adapter_key ASC`,
    )
    .bind(
      cutoff,
      JSON.stringify(LIVE_RESERVE_STRUCTURAL_DEGRADED_WARNING_CODES),
      JSON.stringify(LIVE_RESERVE_WARNING_EFFECT_VALUES),
    )
    .all<ReliabilityRow>(), 3, signal);
  const rows = (result.results ?? []).map((row) => {
    const attempts = row.attempts;
    return {
      adapterKey: row.adapter_key,
      attempts,
      ok: row.ok_count,
      degraded: row.degraded_count,
      degradedByDesign: row.degraded_by_design_count,
      error: row.error_count,
      skipped: row.skipped_count,
      successRate: attempts > 0 ? (row.ok_count + row.degraded_by_design_count) / attempts : null,
    };
  });
  return { computedAt: now, windowSec, rows };
}
