export const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;
const MS_PER_SECOND = 1000;

export const HOUR_SECONDS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
export const DAY_SECONDS = HOURS_PER_DAY * HOUR_SECONDS;
export const WEEK_SECONDS = 7 * DAY_SECONDS;
export const THIRTY_DAYS_SECONDS = 30 * DAY_SECONDS;

export const DAY_MS = DAY_SECONDS * MS_PER_SECOND;

/** Current Unix time in whole seconds — the epoch unit every Pharos store and API uses. */
export function unixNowSec(): number {
  return Math.floor(Date.now() / MS_PER_SECOND);
}
