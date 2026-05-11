import { DISAMBIGUATION_TTL_SEC } from "../api/telegram-webhook-shared";
import { throwIfAborted } from "../lib/abort";
import { runWithOverloadRetry } from "../lib/cron-lease";
import type { CronResult } from "../lib/cron-logger";

export function isQuietHoursActive(
  nowSec: number,
  quietHoursEnabled: boolean,
  quietHoursStartUtc: number | null,
  quietHoursEndUtc: number | null,
): boolean {
  if (!quietHoursEnabled || quietHoursStartUtc == null || quietHoursEndUtc == null) return false;
  if (
    quietHoursStartUtc < 0 ||
    quietHoursStartUtc > 23 ||
    quietHoursEndUtc < 0 ||
    quietHoursEndUtc > 23 ||
    quietHoursStartUtc === quietHoursEndUtc
  ) {
    return false;
  }

  const hourUtc = Math.floor((nowSec % 86_400) / 3600);
  if (quietHoursStartUtc < quietHoursEndUtc) {
    return hourUtc >= quietHoursStartUtc && hourUtc < quietHoursEndUtc;
  }
  return hourUtc >= quietHoursStartUtc || hourUtc < quietHoursEndUtc;
}

// Grace window past `expires_at` before a disambiguation row is eligible for
// cleanup. Two TTLs gives a slow user mid-selection room to finish, with a
// 10-minute floor so the guard remains meaningful if the TTL is ever shortened.
const DISAMBIGUATION_CLEANUP_GRACE_SEC = Math.max(2 * DISAMBIGUATION_TTL_SEC, 600);

/**
 * Deletes expired rows from `telegram_pending_disambiguation`. Rows are only
 * removed once `expires_at` is older than `2 * DISAMBIGUATION_TTL_SEC` (10 min
 * minimum) to avoid racing a slow user mid-selection.
 *
 * Runs on the existing 5-minute Telegram cron slot. Returns a `CronResult`
 * with `disambiguationRowsCleaned` in metadata for observability.
 */
export async function cleanExpiredDisambiguations(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  throwIfAborted(signal);
  const cutoffSec = Math.floor(Date.now() / 1000) - DISAMBIGUATION_CLEANUP_GRACE_SEC;
  const result = await runWithOverloadRetry(() =>
    db
      .prepare("DELETE FROM telegram_pending_disambiguation WHERE expires_at < ?")
      .bind(cutoffSec)
      .run(),
  );
  const disambiguationRowsCleaned = result.meta?.changes ?? 0;
  return {
    status: "ok",
    itemCount: disambiguationRowsCleaned,
    metadata: JSON.stringify({ disambiguationRowsCleaned, cutoffSec }),
  };
}
