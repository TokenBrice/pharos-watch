import {
  PENDING_NEAR_TTL_WINDOW_SEC,
  PENDING_TTL_SEC,
  TELEGRAM_DISPATCH_INTERVAL_SEC,
  TELEGRAM_PENDING_DRAIN_BUDGET,
} from "../../lib/telegram-constants";
import { logTelegramEvent } from "../../lib/telegram-log";
import type { PendingCapacitySnapshot } from "./types";

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

export async function readPendingCapacitySnapshot(
  db: D1Database,
  nowSec: number,
  drainBudgetPerRun: number = TELEGRAM_PENDING_DRAIN_BUDGET,
): Promise<PendingCapacitySnapshot> {
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
           FROM telegram_pending_alerts`,
      )
      .bind(
        PENDING_TTL_SEC, nowSec,
        PENDING_TTL_SEC, nowSec, nowSec,
        PENDING_TTL_SEC, nowSec, nowSec,
        PENDING_TTL_SEC, nowSec, PENDING_TTL_SEC, nowSec + PENDING_NEAR_TTL_WINDOW_SEC,
        PENDING_TTL_SEC, nowSec,
        PENDING_TTL_SEC, nowSec, nowSec,
      )
      .first<{
        total: number | null;
        expired: number | null;
        due: number | null;
        deferred: number | null;
        near_ttl: number | null;
        oldest_pending_created_at: number | null;
        oldest_due_created_at: number | null;
      }>();

    const total = normalizeCapacityNumber(row?.total);
    const expired = normalizeCapacityNumber(row?.expired);
    const due = normalizeCapacityNumber(row?.due);
    const deferred = normalizeCapacityNumber(row?.deferred);
    const nearTtl = normalizeCapacityNumber(row?.near_ttl);
    const active = Math.max(0, total - expired);
    const oldestPendingCreatedAt = normalizeCapacityTimestamp(row?.oldest_pending_created_at);
    const oldestDueCreatedAt = normalizeCapacityTimestamp(row?.oldest_due_created_at);

    return {
      total,
      active,
      due,
      deferred,
      expired,
      nearTtl,
      oldestPendingAgeSec: oldestPendingCreatedAt == null ? null : Math.max(0, nowSec - oldestPendingCreatedAt),
      oldestDuePendingAgeSec: oldestDueCreatedAt == null ? null : Math.max(0, nowSec - oldestDueCreatedAt),
      estimatedDrainTimeSec: estimateTelegramDrainTimeSec(active, drainBudgetPerRun),
      drainBudgetPerRun,
      dispatchIntervalSec: TELEGRAM_DISPATCH_INTERVAL_SEC,
    };
  } catch (error) {
    logTelegramEvent({
      level: "warn",
      message: "Failed to read pending capacity snapshot",
      action: "read-pending-capacity",
      module: "telegram-pending-capacity",
    });
    return {
      total: 0,
      active: 0,
      due: 0,
      deferred: 0,
      expired: 0,
      nearTtl: 0,
      oldestPendingAgeSec: null,
      oldestDuePendingAgeSec: null,
      estimatedDrainTimeSec: 0,
      drainBudgetPerRun,
      dispatchIntervalSec: TELEGRAM_DISPATCH_INTERVAL_SEC,
    };
  }
}
