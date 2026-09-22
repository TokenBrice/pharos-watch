import { getCache } from "../../lib/db-cache";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import {
  PENDING_BACKOFF_SCHEDULE_SEC,
} from "../../lib/telegram/constants";
import { logTelegramEvent } from "../../lib/telegram/log";

const PENDING_BACKOFF_CAP_SEC = PENDING_BACKOFF_SCHEDULE_SEC[PENDING_BACKOFF_SCHEDULE_SEC.length - 1];
export const TELEGRAM_GLOBAL_BACKOFF_CACHE_KEY = "telegram:global-send-backoff-until";

/**
 * Backoff seconds for the *next* attempt given the prior attempt count.
 * Honors Telegram's `Retry-After` when provided; otherwise indexes into
 * `PENDING_BACKOFF_SCHEDULE_SEC` and caps at the schedule's last value.
 */
export function pendingBackoffSec(priorAttempts: number, retryAfterSec: number | null): number {
  if (retryAfterSec != null && retryAfterSec > 0) return retryAfterSec;
  const idx = Math.min(Math.max(priorAttempts, 0), PENDING_BACKOFF_SCHEDULE_SEC.length - 1);
  return PENDING_BACKOFF_SCHEDULE_SEC[idx] ?? PENDING_BACKOFF_CAP_SEC;
}

/**
 * Raise the durable global send gate to at least `notBeforeAt`.
 *
 * The upsert folds the maximum into the row itself (`MAX` over the cached and
 * excluded values), so two overlapping writers can never lower the durable
 * value the way a read-then-write max could. Returns whether the write
 * landed; a `false` return must be answered with a per-row `not_before_at`
 * fallback by the caller, otherwise the next drain would send immediately.
 */
export async function setTelegramGlobalBackoff(db: D1Database, notBeforeAt: number | null): Promise<boolean> {
  if (notBeforeAt == null) return true;
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    const result = await runWithOverloadRetry(
      () =>
        db
          .prepare(
            `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
               value = CAST(MAX(CAST(cache.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT),
               updated_at = MAX(cache.updated_at, excluded.updated_at)`,
          )
          .bind(TELEGRAM_GLOBAL_BACKOFF_CACHE_KEY, String(notBeforeAt), nowSec)
          .run(),
      3,
    );
    return Number(result.meta?.changes ?? 0) > 0;
  } catch {
    logTelegramEvent({
      level: "warn",
      message: "Failed to set global Telegram backoff",
      action: "set-global-backoff",
      module: "telegram-pending-backoff",
    });
    return false;
  }
}

export async function readTelegramGlobalBackoff(db: D1Database, nowSec: number): Promise<number | null> {
  try {
    const cached = await getCache(db, TELEGRAM_GLOBAL_BACKOFF_CACHE_KEY);
    if (!cached) return null;
    const parsed = Number(cached.value);
    return Number.isFinite(parsed) && parsed > nowSec ? Math.floor(parsed) : null;
  } catch {
    logTelegramEvent({
      level: "warn",
      message: "Failed to read global Telegram backoff",
      action: "read-global-backoff",
      module: "telegram-pending-backoff",
    });
    return null;
  }
}

