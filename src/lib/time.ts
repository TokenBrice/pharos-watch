/**
 * Normalize a loosely-typed timestamp (epoch seconds, epoch millis, numeric
 * string, or ISO date string) to epoch milliseconds. Returns NaN when the
 * value cannot be interpreted as a date.
 *
 * Values below 10_000_000_000 are treated as epoch seconds and scaled to millis.
 */
export function toTimestampMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    }

    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return Number.NaN;
}
