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
