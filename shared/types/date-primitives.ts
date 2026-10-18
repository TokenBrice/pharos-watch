/** Validate Gregorian calendar components without Date's rollover or 0–99 year remapping. */
export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (
    !Number.isInteger(year) || year < 1 || year > 9999
    || !Number.isInteger(month) || month < 1 || month > 12
    || !Number.isInteger(day) || day < 1
  ) return false;
  const daysInMonth = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : (month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31);
  return day <= daysInMonth;
}

/** Strict YYYY-MM-DD Gregorian calendar-date validation. */
export function isValidIsoDateOnly(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isValidCalendarDate(year, month, day);
}

/** Parse a strict calendar date or UTC instant (seconds, optionally 1–3 fractional digits). */
export function parseIsoDateOrUtcInstantSec(value: unknown): number {
  if (typeof value !== "string") return NaN;
  if (isValidIsoDateOnly(value)) return Date.parse(`${value}T00:00:00.000Z`) / 1_000;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:Z|\.\d{1,3}Z)$/.exec(value);
  if (!match || !isValidIsoDateOnly(match[1])
    || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return NaN;
  return Date.parse(value) / 1_000;
}

/** Date-only evidence waits for its UTC day to elapse; an exact UTC pin needs no delay. */
export function reviewAdmissionSec(value: string): number {
  return parseIsoDateOrUtcInstantSec(value) + (value.length === 10 ? 86_400 : 0);
}
