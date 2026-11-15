import { DAY_MS, DAY_SECONDS } from "./time-constants";

function assertFiniteTimestamp(value: number, unit: "seconds" | "milliseconds"): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Unix timestamp in ${unit} must be finite`);
  }
}

/** Return the UTC-day boundary in epoch seconds for an epoch-seconds timestamp. */
export function bucketUnixSecondsToUtcDay(timestampSec: number): number {
  assertFiniteTimestamp(timestampSec, "seconds");
  return Math.floor(timestampSec / DAY_SECONDS) * DAY_SECONDS;
}

/** Return the UTC-day boundary in epoch milliseconds for an epoch-milliseconds timestamp. */
export function bucketUnixMillisecondsToUtcDay(timestampMs: number): number {
  assertFiniteTimestamp(timestampMs, "milliseconds");
  return Math.floor(timestampMs / DAY_MS) * DAY_MS;
}

/** Return the UTC-day boundary in epoch seconds for a Date. */
export function startOfUtcDaySec(date: Date): number {
  const timestampMs = date.getTime();
  assertFiniteTimestamp(timestampMs, "milliseconds");
  return bucketUnixMillisecondsToUtcDay(timestampMs) / 1000;
}

/** UTC midnight (epoch seconds) of Western Easter Sunday: Meeus/Jones/Butcher Gregorian computus. */
export function easterSundayUtcDaySec(year: number): number {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Math.floor(Date.UTC(year, month - 1, day) / 1000);
}
