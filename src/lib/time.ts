import { parseEpoch } from "@shared/lib/epoch";

/**
 * Normalize a loosely-typed timestamp (epoch seconds, epoch millis, numeric
 * string, or ISO date string) to epoch milliseconds. Returns NaN when the
 * value cannot be interpreted as a date.
 *
 * Values below 10_000_000_000 are treated as epoch seconds and scaled to millis.
 */
export function toTimestampMs(value: unknown) {
  const parsed = parseEpoch(value, {
    numericTextPolicy: "any",
    millisecondsThreshold: 10_000_000_000,
    millisecondsThresholdInclusive: true,
  });
  return parsed.kind === "seconds" ? parsed.seconds * 1000 : Number.NaN;
}
