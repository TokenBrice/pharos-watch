import type { TelegramPendingDeliveryBacklog } from "@shared/types/status";

import {
  PENDING_NEAR_TTL_WINDOW_SEC,
  PENDING_OLD_AGE_ALERT_SEC,
  TELEGRAM_DISPATCH_INTERVAL_SEC,
  TELEGRAM_PENDING_DRAIN_BUDGET,
} from "../common/constants";
import { logTelegramEvent } from "../common/log";

const TELEGRAM_EXECUTION_UNKNOWN_SAMPLE_LIMIT = 5_001;

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

/**
 * Flattened capacity projection published in dispatch run metadata. It is the
 * single snapshot → fields mapping: a new snapshot field is threaded through
 * here once instead of in every dispatch projection that consumes it.
 */
export interface TelegramPendingCapacityProgressFields {
  pendingTotal: number;
  pendingDue: number;
  pendingDeferredCount: number;
  pendingExpiredCount: number;
  pendingNearTtlCount: number;
  oldestPendingAgeSec: number | null;
  oldestDuePendingAgeSec: number | null;
  estimatedDrainTimeSec: number;
  pendingDrainBudgetPerRun: number;
}

export function pendingCapacityProgressFields(
  capacity: TelegramPendingCapacitySnapshot,
): TelegramPendingCapacityProgressFields {
  return {
    pendingTotal: capacity.active,
    pendingDue: capacity.due,
    pendingDeferredCount: capacity.deferred,
    pendingExpiredCount: capacity.expired,
    pendingNearTtlCount: capacity.nearTtl,
    oldestPendingAgeSec: capacity.oldestPendingAgeSec,
    oldestDuePendingAgeSec: capacity.oldestDuePendingAgeSec,
    estimatedDrainTimeSec: capacity.estimatedDrainTimeSec,
    pendingDrainBudgetPerRun: capacity.drainBudgetPerRun,
  };
}
export function toPendingDeliveryBacklog(
  capacity: TelegramPendingCapacitySnapshot,
): TelegramPendingDeliveryBacklog & { claimable: number } {
  return {
    claimable: capacity.due,
    due: capacity.due,
    deferred: capacity.deferred,
    expired: capacity.expired,
    nearTtl: capacity.nearTtl,
    sending: capacity.sending,
    pendingSending: capacity.pendingSending,
    freshSending: capacity.freshSending,
    executionUnknown: capacity.executionUnknown,
    pendingExecutionUnknown: capacity.pendingExecutionUnknown,
    freshExecutionUnknown: capacity.freshExecutionUnknown,
    oldestExecutionUnknownAgeSec: capacity.oldestExecutionUnknownAgeSec,
    executionUnknownSampleLimit: capacity.executionUnknownSampleLimit,
    executionUnknownLowerBound: capacity.executionUnknownLowerBound,
    sentCleanup: capacity.sentCleanup,
  };
}


/** Zeroed capacity snapshot for dispatch results that never read the queue. */
export function emptyPendingCapacitySnapshot(): TelegramPendingCapacitySnapshot {
  return {
    total: 0,
    active: 0,
    due: 0,
    deferred: 0,
    expired: 0,
    nearTtl: 0,
    sending: 0,
    pendingSending: 0,
    freshSending: 0,
    pendingExecutionUnknown: 0,
    freshExecutionUnknown: 0,
    executionUnknown: 0,
    sentCleanup: 0,
    oldestExecutionUnknownAgeSec: null,
    executionUnknownSampleLimit: TELEGRAM_EXECUTION_UNKNOWN_SAMPLE_LIMIT,
    executionUnknownLowerBound: false,
    oldestPendingAgeSec: null,
    oldestDuePendingAgeSec: null,
    estimatedDrainTimeSec: 0,
    drainBudgetPerRun: TELEGRAM_PENDING_DRAIN_BUDGET,
    dispatchIntervalSec: TELEGRAM_DISPATCH_INTERVAL_SEC,
  };
}

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

/**
 * Delivery v2 backlog over `telegram_deliveries` (open = pending/retry). The
 * `fresh_*` columns are zero: the v2 pipeline has no second effect ledger.
 */
export const TELEGRAM_PENDING_CAPACITY_SQL = `WITH p(now_sec, near_ttl_at, stale_before) AS (SELECT ?, ?, ?),
rows AS (
  SELECT CASE WHEN state IN ('pending', 'retry') THEN 'pending' ELSE state END AS state,
         created_at, expires_at, next_attempt_at AS next_at, sending_at AS started_at
    FROM telegram_deliveries
   WHERE state IN ('pending', 'retry', 'sending', 'unknown', 'sent')
     AND (state IN ('pending', 'retry', 'sending') OR done_at >= (SELECT now_sec FROM p) - 86400)
)
SELECT
  SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS total,
  SUM(CASE WHEN state = 'pending' AND expires_at <= p.now_sec THEN 1 ELSE 0 END) AS expired,
  SUM(CASE WHEN state = 'pending' AND expires_at > p.now_sec AND next_at <= p.now_sec THEN 1 ELSE 0 END) AS due,
  SUM(CASE WHEN state = 'pending' AND expires_at > p.now_sec AND next_at > p.now_sec THEN 1 ELSE 0 END) AS deferred,
  SUM(CASE WHEN state = 'pending' AND expires_at > p.now_sec AND expires_at <= p.near_ttl_at THEN 1 ELSE 0 END) AS near_ttl,
  MIN(CASE WHEN state = 'pending' AND expires_at > p.now_sec THEN created_at END) AS oldest_pending_created_at,
  MIN(CASE WHEN state = 'pending' AND expires_at > p.now_sec AND next_at <= p.now_sec THEN created_at END) AS oldest_due_created_at,
  SUM(CASE WHEN state = 'sending' AND started_at > p.stale_before THEN 1 ELSE 0 END) AS pending_sending,
  SUM(CASE
        WHEN (state = 'sending' AND started_at <= p.stale_before)
          OR (state = 'unknown' AND expires_at > p.now_sec)
        THEN 1 ELSE 0
      END) AS pending_execution_unknown,
  SUM(CASE WHEN state = 'sent' THEN 1 ELSE 0 END) AS sent_cleanup,
  MIN(CASE
        WHEN (state = 'sending' AND started_at <= p.stale_before)
          OR (state = 'unknown' AND expires_at > p.now_sec)
        THEN started_at
      END) AS oldest_pending_execution_unknown_at,
  0 AS fresh_sending,
  0 AS fresh_execution_unknown,
  NULL AS oldest_fresh_execution_unknown_at,
  0 AS fresh_uncertain_sample_count
 FROM rows CROSS JOIN p`;

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
    .bind(nowSec, nowSec + PENDING_NEAR_TTL_WINDOW_SEC, nowSec - PENDING_OLD_AGE_ALERT_SEC)
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
