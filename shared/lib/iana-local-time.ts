/** Runtime-neutral IANA timezone helpers shared by Telegram recap controls and planning. */

export interface IanaLocalDate {
  year: number;
  month: number;
  day: number;
}

const LOCAL_DATE_FORMATTER_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
};

const localFormatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * One formatter per timezone. The minute-by-minute due-time scan below asks for
 * local parts ~1,100 times per scheduling call, and constructing a formatter is
 * about ten times the cost of formatting with an existing one, so a fresh
 * formatter per candidate dominated the whole helper. Throws for a timezone the
 * runtime does not recognize, exactly as direct construction does, and only
 * caches zones that constructed successfully.
 */
function localFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = localFormatterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    ...LOCAL_DATE_FORMATTER_OPTIONS,
    timeZone: timezone,
  });
  localFormatterCache.set(timezone, formatter);
  return formatter;
}

function numberPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number | null {
  const value = parts.find((part) => part.type === type)?.value;
  const parsed = value == null ? Number.NaN : Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function localParts(atMs: number, timezone: string): IanaLocalDate & { hour: number; minute: number; second: number } | null {
  try {
    const parts = localFormatter(timezone).formatToParts(new Date(atMs));
    const year = numberPart(parts, "year");
    const month = numberPart(parts, "month");
    const day = numberPart(parts, "day");
    const hour = numberPart(parts, "hour");
    const minute = numberPart(parts, "minute");
    const second = numberPart(parts, "second");
    if ([year, month, day, hour, minute, second].some((value) => value == null)) return null;
    return { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second: second! };
  } catch {
    return null;
  }
}

function compareLocalParts(
  value: IanaLocalDate & { hour: number; minute: number; second: number },
  target: IanaLocalDate & { hour: number; minute: number; second: number },
): number {
  const left = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
  const right = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
  return Math.sign(left - right);
}

function followingLocalDate(date: IanaLocalDate): IanaLocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

/**
 * Returns whether the runtime recognizes the supplied IANA timezone. Resolving
 * the shared cached formatter keeps a repeated check free and warms the zone a
 * scheduling call is about to scan; only zone recognition can fail here, since
 * the fixed field options are always valid.
 */
export function isValidIanaTimezone(timezone: string): boolean {
  if (!timezone || timezone.length > 64) return false;
  try {
    localFormatter(timezone);
    return true;
  } catch {
    return false;
  }
}

/** Derive a stable `YYYY-MM-DD` local date at a UTC instant. */
export function localDateInIanaTimezone(atMs: number, timezone: string): string | null {
  const parts = localParts(atMs, timezone);
  if (!parts) return null;
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/**
 * Return the first UTC instant whose local time is at or after `date hour:00`.
 * An absent spring-forward hour therefore resolves to the first valid instant
 * after it. The forward scan also selects the first occurrence of a fall-back
 * hour, while target uniqueness enforces one recap per local date.
 */
function localHourOnOrAfter(date: IanaLocalDate, hour: number, timezone: string): number | null {
  const target = { ...date, hour, minute: 0, second: 0 };
  const nominalUtc = Date.UTC(date.year, date.month - 1, date.day, hour);
  const start = nominalUtc - 14 * 60 * 60 * 1000;
  const end = nominalUtc + 36 * 60 * 60 * 1000;

  for (let atMs = start; atMs <= end; atMs += 60_000) {
    const local = localParts(atMs, timezone);
    if (local && compareLocalParts(local, target) >= 0) return atMs;
  }
  return null;
}

/**
 * Compute the next due UTC epoch milliseconds for an hour-granular local
 * schedule. The result is strictly after `nowMs`; invalid inputs return null.
 */
export function nextIanaLocalHourDueAt(nowMs: number, timezone: string, deliveryHourLocal: number): number | null {
  if (!Number.isFinite(nowMs) || !isValidIanaTimezone(timezone)) return null;
  if (!Number.isInteger(deliveryHourLocal) || deliveryHourLocal < 0 || deliveryHourLocal > 23) return null;

  const now = localParts(nowMs, timezone);
  if (!now) return null;
  const today = { year: now.year, month: now.month, day: now.day };
  const todayDue = localHourOnOrAfter(today, deliveryHourLocal, timezone);
  if (todayDue != null && todayDue > nowMs) return todayDue;
  return localHourOnOrAfter(followingLocalDate(today), deliveryHourLocal, timezone);
}
