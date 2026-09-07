import {
  PENDING_NEAR_TTL_WINDOW_SEC,
  PENDING_OLD_AGE_ALERT_SEC,
  PENDING_TTL_SEC,
  TELEGRAM_DISPATCH_INTERVAL_SEC,
  TELEGRAM_PENDING_DRAIN_BUDGET,
} from "./constants";
import { logTelegramEvent } from "./log";

export const TELEGRAM_EXECUTION_UNKNOWN_SAMPLE_LIMIT = 5_001;

export interface TelegramPendingCapacitySnapshot {
  total: number;
  active: number;
  due: number;
  deferred: number;
  expired: number;
  nearTtl: number;
  sending: number;
  pendingSending: number;
  freshSending: number;
  pendingExecutionUnknown: number;
  freshExecutionUnknown: number;
  executionUnknown: number;
  sentCleanup: number;
  oldestExecutionUnknownAgeSec: number | null;
  executionUnknownSampleLimit: number;
  executionUnknownLowerBound: boolean;
  oldestPendingAgeSec: number | null;
  oldestDuePendingAgeSec: number | null;
  estimatedDrainTimeSec: number;
  drainBudgetPerRun: number;
  dispatchIntervalSec: number;
}

export type TelegramPendingCapacityReadResult =
  | { status: "available"; value: TelegramPendingCapacitySnapshot }
  | { status: "unknown"; errorClass: "query_failed" };

interface TelegramPendingCapacityRow {
  total: number | string | null;
  expired: number | string | null;
  due: number | string | null;
  deferred: number | string | null;
  near_ttl: number | string | null;
  oldest_pending_created_at: number | string | null;
  oldest_due_created_at: number | string | null;
  pending_sending: number | string | null;
  pending_execution_unknown: number | string | null;
  sent_cleanup: number | string | null;
  oldest_pending_execution_unknown_at: number | string | null;
  fresh_sending: number | string | null;
  fresh_execution_unknown: number | string | null;
  oldest_fresh_execution_unknown_at: number | string | null;
  fresh_uncertain_sample_count: number | string | null;
}

export const TELEGRAM_PENDING_CAPACITY_SQL = `SELECT
  SUM(CASE WHEN delivery_state = 'pending' THEN 1 ELSE 0 END) AS total,
  SUM(CASE
        WHEN delivery_state = 'pending'
         AND COALESCE(expires_at, created_at + ?) <= ?
        THEN 1 ELSE 0
      END) AS expired,
  SUM(CASE
        WHEN delivery_state = 'pending'
         AND COALESCE(expires_at, created_at + ?) > ?
         AND (not_before_at IS NULL OR not_before_at <= ?)
        THEN 1 ELSE 0
      END) AS due,
  SUM(CASE
        WHEN delivery_state = 'pending'
         AND COALESCE(expires_at, created_at + ?) > ?
         AND not_before_at IS NOT NULL
         AND not_before_at > ?
        THEN 1 ELSE 0
      END) AS deferred,
  SUM(CASE
        WHEN delivery_state = 'pending'
         AND COALESCE(expires_at, created_at + ?) > ?
         AND COALESCE(expires_at, created_at + ?) <= ?
        THEN 1 ELSE 0
      END) AS near_ttl,
  MIN(CASE
        WHEN delivery_state = 'pending'
         AND COALESCE(expires_at, created_at + ?) > ?
        THEN created_at
      END) AS oldest_pending_created_at,
  MIN(CASE
        WHEN delivery_state = 'pending'
         AND COALESCE(expires_at, created_at + ?) > ?
         AND (not_before_at IS NULL OR not_before_at <= ?)
        THEN created_at
      END) AS oldest_due_created_at,
  SUM(CASE
        WHEN delivery_state = 'sending'
         AND COALESCE(delivery_started_at, created_at) > ?
        THEN 1 ELSE 0
      END) AS pending_sending,
  SUM(CASE
        WHEN (delivery_state = 'sending'
          AND COALESCE(delivery_started_at, created_at) <= ?)
          OR (
            delivery_state = 'execution_unknown'
            AND COALESCE(expires_at, created_at + ?) > ?
          )
        THEN 1 ELSE 0
      END) AS pending_execution_unknown,
  SUM(CASE WHEN delivery_state = 'sent' THEN 1 ELSE 0 END) AS sent_cleanup,
  MIN(CASE
        WHEN (delivery_state = 'sending'
          AND COALESCE(delivery_started_at, created_at) <= ?)
          OR (
            delivery_state = 'execution_unknown'
            AND COALESCE(expires_at, created_at + ?) > ?
          )
        THEN COALESCE(delivery_started_at, created_at)
      END) AS oldest_pending_execution_unknown_at,
  (SELECT SUM(CASE
                WHEN effect_state = 'sending' AND effect_at > ?
                THEN 1 ELSE 0
              END)
     FROM (
       SELECT effect_state, COALESCE(effect_started_at, effect_completed_at, created_at) AS effect_at
         FROM telegram_alert_job_targets
        WHERE effect_state IN ('sending', 'execution_unknown')
        ORDER BY COALESCE(effect_started_at, effect_completed_at, created_at) ASC
        LIMIT ?
     )) AS fresh_sending,
  (SELECT SUM(CASE
                WHEN effect_state = 'execution_unknown'
                  OR (effect_state = 'sending' AND effect_at <= ?)
                THEN 1 ELSE 0
              END)
     FROM (
       SELECT effect_state, COALESCE(effect_started_at, effect_completed_at, created_at) AS effect_at
         FROM telegram_alert_job_targets
        WHERE effect_state IN ('sending', 'execution_unknown')
        ORDER BY COALESCE(effect_started_at, effect_completed_at, created_at) ASC
        LIMIT ?
     )) AS fresh_execution_unknown,
  (SELECT MIN(CASE
                WHEN effect_state = 'execution_unknown'
                  OR (effect_state = 'sending' AND effect_at <= ?)
                THEN effect_at
              END)
     FROM (
       SELECT effect_state, COALESCE(effect_started_at, effect_completed_at, created_at) AS effect_at
         FROM telegram_alert_job_targets
        WHERE effect_state IN ('sending', 'execution_unknown')
        ORDER BY COALESCE(effect_started_at, effect_completed_at, created_at) ASC
        LIMIT ?
     )) AS oldest_fresh_execution_unknown_at,
  (SELECT COUNT(*)
     FROM (
       SELECT 1
         FROM telegram_alert_job_targets
        WHERE effect_state IN ('sending', 'execution_unknown')
        LIMIT ?
     )) AS fresh_uncertain_sample_count
 FROM telegram_pending_alerts`;

function normalizedNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalizedTimestamp(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

export function estimateTelegramDrainTimeSec(
  messageCount: number,
  drainBudgetPerRun: number = TELEGRAM_PENDING_DRAIN_BUDGET,
  dispatchIntervalSec: number = TELEGRAM_DISPATCH_INTERVAL_SEC,
): number {
  if (!Number.isFinite(messageCount) || messageCount <= 0) return 0;
  const budget = Math.max(1, Math.floor(drainBudgetPerRun));
  return Math.ceil(messageCount / budget) * dispatchIntervalSec;
}

function mapTelegramPendingCapacity(
  row: TelegramPendingCapacityRow | null,
  nowSec: number,
  drainBudgetPerRun: number = TELEGRAM_PENDING_DRAIN_BUDGET,
): TelegramPendingCapacitySnapshot {
  const total = normalizedNumber(row?.total);
  const expired = normalizedNumber(row?.expired);
  const due = normalizedNumber(row?.due);
  const deferred = normalizedNumber(row?.deferred);
  const pendingExecutionUnknown = normalizedNumber(row?.pending_execution_unknown);
  const freshExecutionUnknown = normalizedNumber(row?.fresh_execution_unknown);
  const oldestExecutionUnknownAt = [
    normalizedTimestamp(row?.oldest_pending_execution_unknown_at),
    normalizedTimestamp(row?.oldest_fresh_execution_unknown_at),
  ].filter((value): value is number => value != null).sort((a, b) => a - b)[0] ?? null;
  const oldestPendingCreatedAt = normalizedTimestamp(row?.oldest_pending_created_at);
  const oldestDueCreatedAt = normalizedTimestamp(row?.oldest_due_created_at);
  const pendingSending = normalizedNumber(row?.pending_sending);
  const freshSending = normalizedNumber(row?.fresh_sending);
  const active = Math.max(0, total - expired);

  return {
    total,
    active,
    due,
    deferred,
    expired,
    nearTtl: normalizedNumber(row?.near_ttl),
    sending: pendingSending + freshSending,
    pendingSending,
    freshSending,
    pendingExecutionUnknown,
    freshExecutionUnknown,
    executionUnknown: pendingExecutionUnknown + freshExecutionUnknown,
    sentCleanup: normalizedNumber(row?.sent_cleanup),
    oldestExecutionUnknownAgeSec: oldestExecutionUnknownAt == null
      ? null
      : Math.max(0, nowSec - oldestExecutionUnknownAt),
    executionUnknownSampleLimit: TELEGRAM_EXECUTION_UNKNOWN_SAMPLE_LIMIT,
    executionUnknownLowerBound:
      normalizedNumber(row?.fresh_uncertain_sample_count) >= TELEGRAM_EXECUTION_UNKNOWN_SAMPLE_LIMIT,
    oldestPendingAgeSec: oldestPendingCreatedAt == null ? null : Math.max(0, nowSec - oldestPendingCreatedAt),
    oldestDuePendingAgeSec: oldestDueCreatedAt == null ? null : Math.max(0, nowSec - oldestDueCreatedAt),
    estimatedDrainTimeSec: estimateTelegramDrainTimeSec(active, drainBudgetPerRun),
    drainBudgetPerRun,
    dispatchIntervalSec: TELEGRAM_DISPATCH_INTERVAL_SEC,
  };
}

export async function loadTelegramPendingCapacity(
  db: D1Database,
  nowSec: number,
  drainBudgetPerRun: number = TELEGRAM_PENDING_DRAIN_BUDGET,
): Promise<TelegramPendingCapacitySnapshot> {
  const row = await db
    .prepare(TELEGRAM_PENDING_CAPACITY_SQL)
    .bind(
      PENDING_TTL_SEC, nowSec,
      PENDING_TTL_SEC, nowSec, nowSec,
      PENDING_TTL_SEC, nowSec, nowSec,
      PENDING_TTL_SEC, nowSec, PENDING_TTL_SEC, nowSec + PENDING_NEAR_TTL_WINDOW_SEC,
      PENDING_TTL_SEC, nowSec,
      PENDING_TTL_SEC, nowSec, nowSec,
      nowSec - PENDING_OLD_AGE_ALERT_SEC,
      nowSec - PENDING_OLD_AGE_ALERT_SEC, PENDING_TTL_SEC, nowSec,
      nowSec - PENDING_OLD_AGE_ALERT_SEC, PENDING_TTL_SEC, nowSec,
      nowSec - PENDING_OLD_AGE_ALERT_SEC,
      TELEGRAM_EXECUTION_UNKNOWN_SAMPLE_LIMIT,
      nowSec - PENDING_OLD_AGE_ALERT_SEC,
      TELEGRAM_EXECUTION_UNKNOWN_SAMPLE_LIMIT,
      nowSec - PENDING_OLD_AGE_ALERT_SEC,
      TELEGRAM_EXECUTION_UNKNOWN_SAMPLE_LIMIT,
      TELEGRAM_EXECUTION_UNKNOWN_SAMPLE_LIMIT,
    )
    .first<TelegramPendingCapacityRow>();
  return mapTelegramPendingCapacity(row, nowSec, drainBudgetPerRun);
}

export async function readTelegramPendingCapacity(
  db: D1Database,
  nowSec: number,
  drainBudgetPerRun?: number,
): Promise<TelegramPendingCapacityReadResult> {
  try {
    return {
      status: "available",
      value: await loadTelegramPendingCapacity(db, nowSec, drainBudgetPerRun),
    };
  } catch {
    logTelegramEvent({
      level: "warn",
      message: "Failed to read pending capacity snapshot",
      action: "read-pending-capacity",
      module: "telegram-pending-capacity",
      errorClass: "d1",
    });
    return { status: "unknown", errorClass: "query_failed" };
  }
}

export async function readTelegramPendingCapacitySnapshot(
  db: D1Database,
  nowSec: number,
  drainBudgetPerRun?: number,
): Promise<TelegramPendingCapacitySnapshot> {
  const result = await readTelegramPendingCapacity(db, nowSec, drainBudgetPerRun);
  if (result.status === "unknown") {
    throw new Error(`Pending capacity unavailable: ${result.errorClass}`);
  }
  return result.value;
}
