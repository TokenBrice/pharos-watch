import { logTelegramEvent } from "./telegram-log";

const QUIET_HOURS_TZ_FALLBACK_LOG_WINDOW_MS = 60 * 60 * 1000;

// Intentional per-isolate cache to avoid logging the same broken timezone on
// every quiet-hours evaluation while still surfacing novel fallback zones.
const quietHoursTzFallbackLastLoggedAt = new Map<string, number>();

function logQuietHoursTimezoneFallback(timezone: string): void {
  const nowMs = Date.now();
  const lastLoggedAt = quietHoursTzFallbackLastLoggedAt.get(timezone);
  if (lastLoggedAt != null && nowMs - lastLoggedAt < QUIET_HOURS_TZ_FALLBACK_LOG_WINDOW_MS) {
    return;
  }
  quietHoursTzFallbackLastLoggedAt.set(timezone, nowMs);
  logTelegramEvent({
    level: "warn",
    message: "quiet-hours timezone fallback to UTC",
    action: "quiet-hours-timezone-fallback",
    timezone,
    quietHoursTzFallback: true,
  });
}

/** @internal Exported for tests only. */
export function resetQuietHoursFallbackTelemetryForTests(): void {
  quietHoursTzFallbackLastLoggedAt.clear();
}

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
    if (resolved == null) {
      logQuietHoursTimezoneFallback(timezone);
    }
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
