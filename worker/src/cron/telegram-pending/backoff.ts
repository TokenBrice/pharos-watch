import { getCache, setCache } from "../../lib/db-cache";
import {
  PENDING_BACKOFF_SCHEDULE_SEC,
  PENDING_TTL_SEC,
} from "../../lib/telegram-constants";
import { logTelegramEvent } from "../../lib/telegram-log";

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

export async function setTelegramGlobalBackoff(db: D1Database, notBeforeAt: number | null): Promise<void> {
  if (notBeforeAt == null) return;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const existing = await readTelegramGlobalBackoff(db, nowSec);
    await setCache(db, TELEGRAM_GLOBAL_BACKOFF_CACHE_KEY, String(Math.max(existing ?? 0, notBeforeAt)));
  } catch {
    logTelegramEvent({
      level: "warn",
      message: "Failed to set global Telegram backoff",
      action: "set-global-backoff",
      module: "telegram-pending-backoff",
    });
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

export async function loadChatsInBackoff(
  db: D1Database,
  nowSec: number,
): Promise<Map<string, number>> {
  const rows = await db
    .prepare(
      `SELECT chat_id, MAX(not_before_at) AS not_before_at
         FROM telegram_pending_alerts
        WHERE COALESCE(expires_at, created_at + ?) > ?
          AND not_before_at IS NOT NULL
          AND not_before_at > ?
        GROUP BY chat_id`,
    )
    .bind(PENDING_TTL_SEC, nowSec, nowSec)
    .all<{ chat_id: string; not_before_at: number | null }>();
  return new Map(
    (rows.results ?? [])
      .filter((row): row is { chat_id: string; not_before_at: number } => row.not_before_at != null)
      .map((row) => [row.chat_id, row.not_before_at]),
  );
}
