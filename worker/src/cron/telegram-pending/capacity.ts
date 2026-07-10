import {
  PENDING_NEAR_TTL_WINDOW_SEC,
  PENDING_OLD_AGE_ALERT_SEC,
  PENDING_TTL_SEC,
  TELEGRAM_DISPATCH_INTERVAL_SEC,
  TELEGRAM_PENDING_DRAIN_BUDGET,
} from "../../lib/telegram-constants";
import { logTelegramEvent } from "../../lib/telegram-log";
import type { PendingCapacityReadResult, PendingCapacitySnapshot } from "./types";

export const EXECUTION_UNKNOWN_SAMPLE_LIMIT = 5_001;

export function estimateTelegramDrainTimeSec(
  messageCount: number,
  drainBudgetPerRun: number = TELEGRAM_PENDING_DRAIN_BUDGET,
  dispatchIntervalSec: number = TELEGRAM_DISPATCH_INTERVAL_SEC,
): number {
  if (!Number.isFinite(messageCount) || messageCount <= 0) return 0;
  const budget = Math.max(1, Math.floor(drainBudgetPerRun));
  return Math.ceil(messageCount / budget) * dispatchIntervalSec;
}

function normalizeCapacityNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalizeCapacityTimestamp(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

export async function readPendingCapacity(
  db: D1Database,
  nowSec: number,
  drainBudgetPerRun: number = TELEGRAM_PENDING_DRAIN_BUDGET,
): Promise<PendingCapacityReadResult> {
  try {
    const row = await db
      .prepare(
        `SELECT SUM(CASE WHEN delivery_state = 'pending' THEN 1 ELSE 0 END) AS total,
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
                    END) AS oldest_due_created_at
               ,SUM(CASE
                      WHEN delivery_state = 'sending'
                       AND COALESCE(delivery_started_at, created_at) > ?
                      THEN 1 ELSE 0
                    END) AS pending_sending
               ,SUM(CASE
                      WHEN delivery_state = 'sending'
                       AND COALESCE(delivery_started_at, created_at) <= ?
                      THEN 1 ELSE 0
                    END) AS pending_execution_unknown
               ,SUM(CASE WHEN delivery_state = 'sent' THEN 1 ELSE 0 END) AS sent_cleanup
               ,MIN(CASE
                      WHEN delivery_state = 'sending'
                       AND COALESCE(delivery_started_at, created_at) <= ?
                      THEN COALESCE(delivery_started_at, created_at)
                    END) AS oldest_pending_execution_unknown_at
               ,(SELECT SUM(CASE
                              WHEN effect_state = 'sending' AND effect_at > ?
                              THEN 1 ELSE 0
                            END)
                   FROM (
                     SELECT effect_state, COALESCE(effect_started_at, effect_completed_at, created_at) AS effect_at
                       FROM telegram_alert_job_targets
                      WHERE effect_state IN ('sending', 'execution_unknown')
                      ORDER BY COALESCE(effect_started_at, effect_completed_at, created_at) ASC
                      LIMIT ?
                   )) AS fresh_sending
               ,(SELECT SUM(CASE
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
                   )) AS fresh_execution_unknown
               ,(SELECT MIN(CASE
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
                   )) AS oldest_fresh_execution_unknown_at
               ,(SELECT COUNT(*)
                   FROM (
                     SELECT 1
                       FROM telegram_alert_job_targets
                      WHERE effect_state IN ('sending', 'execution_unknown')
                      LIMIT ?
                   )) AS fresh_uncertain_sample_count
           FROM telegram_pending_alerts`,
      )
      .bind(
        PENDING_TTL_SEC, nowSec,
        PENDING_TTL_SEC, nowSec, nowSec,
        PENDING_TTL_SEC, nowSec, nowSec,
        PENDING_TTL_SEC, nowSec, PENDING_TTL_SEC, nowSec + PENDING_NEAR_TTL_WINDOW_SEC,
        PENDING_TTL_SEC, nowSec,
        PENDING_TTL_SEC, nowSec, nowSec,
        nowSec - PENDING_OLD_AGE_ALERT_SEC,
        nowSec - PENDING_OLD_AGE_ALERT_SEC,
        nowSec - PENDING_OLD_AGE_ALERT_SEC,
        nowSec - PENDING_OLD_AGE_ALERT_SEC,
        EXECUTION_UNKNOWN_SAMPLE_LIMIT,
        nowSec - PENDING_OLD_AGE_ALERT_SEC,
        EXECUTION_UNKNOWN_SAMPLE_LIMIT,
        nowSec - PENDING_OLD_AGE_ALERT_SEC,
        EXECUTION_UNKNOWN_SAMPLE_LIMIT,
        EXECUTION_UNKNOWN_SAMPLE_LIMIT,
      )
      .first<{
        total: number | null;
        expired: number | null;
        due: number | null;
        deferred: number | null;
        near_ttl: number | null;
        oldest_pending_created_at: number | null;
        oldest_due_created_at: number | null;
        pending_sending: number | null;
        pending_execution_unknown: number | null;
        sent_cleanup: number | null;
        oldest_pending_execution_unknown_at: number | null;
        fresh_sending: number | null;
        fresh_execution_unknown: number | null;
        oldest_fresh_execution_unknown_at: number | null;
        fresh_uncertain_sample_count: number | null;
      }>();

    const total = normalizeCapacityNumber(row?.total);
    const expired = normalizeCapacityNumber(row?.expired);
    const due = normalizeCapacityNumber(row?.due);
    const deferred = normalizeCapacityNumber(row?.deferred);
    const nearTtl = normalizeCapacityNumber(row?.near_ttl);
    const pendingSending = normalizeCapacityNumber(row?.pending_sending);
    const pendingExecutionUnknown = normalizeCapacityNumber(row?.pending_execution_unknown);
    const freshSending = normalizeCapacityNumber(row?.fresh_sending);
    const freshExecutionUnknown = normalizeCapacityNumber(row?.fresh_execution_unknown);
    const executionUnknown = pendingExecutionUnknown + freshExecutionUnknown;
    const freshUncertainSampleCount = normalizeCapacityNumber(row?.fresh_uncertain_sample_count);
    const active = Math.max(0, total - expired);
    const oldestPendingCreatedAt = normalizeCapacityTimestamp(row?.oldest_pending_created_at);
    const oldestDueCreatedAt = normalizeCapacityTimestamp(row?.oldest_due_created_at);
    const oldestExecutionUnknownAt = [
      normalizeCapacityTimestamp(row?.oldest_pending_execution_unknown_at),
      normalizeCapacityTimestamp(row?.oldest_fresh_execution_unknown_at),
    ].filter((value): value is number => value != null).sort((a, b) => a - b)[0] ?? null;

    return { status: "available", value: {
      total,
      active,
      due,
      deferred,
      expired,
      nearTtl,
      sending: pendingSending + freshSending,
      pendingExecutionUnknown,
      freshExecutionUnknown,
      executionUnknown,
      sentCleanup: normalizeCapacityNumber(row?.sent_cleanup),
      oldestExecutionUnknownAgeSec: oldestExecutionUnknownAt == null
        ? null
        : Math.max(0, nowSec - oldestExecutionUnknownAt),
      executionUnknownSampleLimit: EXECUTION_UNKNOWN_SAMPLE_LIMIT,
      executionUnknownLowerBound: freshUncertainSampleCount >= EXECUTION_UNKNOWN_SAMPLE_LIMIT,
      oldestPendingAgeSec: oldestPendingCreatedAt == null ? null : Math.max(0, nowSec - oldestPendingCreatedAt),
      oldestDuePendingAgeSec: oldestDueCreatedAt == null ? null : Math.max(0, nowSec - oldestDueCreatedAt),
      estimatedDrainTimeSec: estimateTelegramDrainTimeSec(active, drainBudgetPerRun),
      drainBudgetPerRun,
      dispatchIntervalSec: TELEGRAM_DISPATCH_INTERVAL_SEC,
    } };
  } catch (error) {
    logTelegramEvent({
      level: "warn",
      message: "Failed to read pending capacity snapshot",
      action: "read-pending-capacity",
      module: "telegram-pending-capacity",
    });
    return { status: "unknown", errorClass: "query_failed" };
  }
}

export async function readPendingCapacitySnapshot(
  db: D1Database,
  nowSec: number,
  drainBudgetPerRun: number = TELEGRAM_PENDING_DRAIN_BUDGET,
): Promise<PendingCapacitySnapshot> {
  const result = await readPendingCapacity(db, nowSec, drainBudgetPerRun);
  if (result.status === "unknown") {
    throw new Error(`Pending capacity unavailable: ${result.errorClass}`);
  }
  return result.value;
}
