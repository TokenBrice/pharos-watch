import { DISAMBIGUATION_TTL_SEC } from "../api/telegram-webhook-shared";
import { throwIfAborted } from "../lib/abort";
import { runWithOverloadRetry } from "../lib/cron-lease";
import type { CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";

/**
 * Returns the current hour (0–23, h23 cycle) in the given IANA timezone.
 * Returns `null` if the zone is not recognized by the runtime ICU tables;
 * callers should fall back to UTC in that case.
 */
function resolveLocalHour(nowSec: number, timezone: string): number | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(new Date(nowSec * 1000));
    const hourPart = parts.find((part) => part.type === "hour")?.value ?? "";
    const hour = Number(hourPart);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
    return hour;
  } catch {
    return null;
  }
}

/**
 * Resolves whether the chat is currently inside its configured quiet window.
 *
 * `quietHoursStartUtc`/`quietHoursEndUtc` are stored as hour-of-day integers
 * (0–23) and are interpreted in `timezone` when provided (NULL = UTC, the
 * historical behavior). The "Utc" suffix on the parameter names is preserved
 * for column-name symmetry; the actual semantics are local to the resolved zone.
 */
export function isQuietHoursActive(
  nowSec: number,
  quietHoursEnabled: boolean,
  quietHoursStartUtc: number | null,
  quietHoursEndUtc: number | null,
  timezone: string | null = null,
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

  // NULL timezone keeps the legacy UTC interpretation. When a zone is set but
  // ICU rejects it (shouldn't happen post-registration validation, but Workers
  // ICU support is account-tier dependent), we silently fall back to UTC so the
  // user still gets *some* quiet-hours behavior rather than no muting at all.
  let hourLocal: number;
  if (timezone) {
    const resolved = resolveLocalHour(nowSec, timezone);
    hourLocal = resolved ?? Math.floor((nowSec % 86_400) / 3600);
  } else {
    hourLocal = Math.floor((nowSec % 86_400) / 3600);
  }

  if (quietHoursStartUtc < quietHoursEndUtc) {
    return hourLocal >= quietHoursStartUtc && hourLocal < quietHoursEndUtc;
  }
  return hourLocal >= quietHoursStartUtc || hourLocal < quietHoursEndUtc;
}

/**
 * Returns `true` when `zone` is accepted by the runtime as an IANA timezone.
 * Used by the `/timezone` command to reject obvious typos before persisting.
 */
export function isValidIanaTimezone(zone: string): boolean {
  if (!zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
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
    3,
    signal,
  );
  const disambiguationRowsCleaned = result.meta?.changes ?? 0;
  return createCronResult({
    status: "ok",
    itemCount: disambiguationRowsCleaned,
    metadata: { disambiguationRowsCleaned, cutoffSec },
  });
}
