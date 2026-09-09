import type { ReserveSyncAdapterReliability } from "@shared/types/live-reserves";
import { runWithOverloadRetry } from "../d1-overload-retry";
import { LIVE_RESERVE_HISTORY_RETENTION_SEC, type ReserveSyncStatus } from "./store-shared";

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
  /** Adapter/cron wall-clock instrumentation, only present once adapters emit it under `metadata.diag`. */
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
  error_count: number;
  skipped_count: number;
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseDiagDurationMs(metadata: Record<string, unknown>): number | null {
  const diag = metadata.diag;
  if (diag == null || typeof diag !== "object" || Array.isArray(diag) || !("durationMs" in diag)) {
    return null;
  }
  const durationMs = diag.durationMs;
  return typeof durationMs === "number" && Number.isFinite(durationMs) ? durationMs : null;
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
  for (const item of parsed) {
    if (item == null || typeof item !== "object" || !("code" in item)) continue;
    const code = item.code;
    if (typeof code === "string") codes.push(code);
  }
  return codes;
}

function mapTimelineRow(row: AttemptHistoryRow): ReserveSyncAttemptTimelineEntry {
  const metadata = parseJsonObject(row.metadata);
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

/**
 * 30-day per-adapter reliability rollup: one grouped scan over the attempt
 * ledger. `successRate` is `ok / attempts` (all attempts in the window,
 * including breaker-skipped rows) and is `null` only when an adapter has no
 * attempts. The result feeds the admin reserve card and is cached with the
 * hourly status snapshot.
 */
export async function loadReserveSyncReliabilityRollup(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  windowSec = LIVE_RESERVE_HISTORY_RETENTION_SEC,
): Promise<ReserveSyncAdapterReliability[]> {
  const cutoff = now - windowSec;
  const result = await runWithOverloadRetry(() => db
    .prepare(
      `SELECT adapter_key,
              COUNT(*) AS attempts,
              SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
              SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) AS degraded_count,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
              SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count
         FROM reserve_sync_attempt_history
        WHERE attempted_at >= ?
        GROUP BY adapter_key
        ORDER BY attempts DESC, adapter_key ASC`,
    )
    .bind(cutoff)
    .all<ReliabilityRow>());
  return (result.results ?? []).map((row) => {
    const attempts = row.attempts;
    return {
      adapterKey: row.adapter_key,
      attempts,
      ok: row.ok_count,
      degraded: row.degraded_count,
      error: row.error_count,
      skipped: row.skipped_count,
      successRate: attempts > 0 ? row.ok_count / attempts : null,
    };
  });
}
