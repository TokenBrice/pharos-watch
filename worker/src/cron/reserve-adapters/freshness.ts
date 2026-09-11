export function verifiedFreshnessMetadata(
  sourceTimestamp: number,
): { sourceTimestamp: number; freshnessMode: "verified" } {
  return {
    sourceTimestamp,
    freshnessMode: "verified",
  };
}

/**
 * Verified freshness whose timestamp is the source's own render/response
 * clock — the instant the payload was rendered or served — rather than an
 * independently dated as-of time for the reserve state. Render clocks are
 * accepted as `verified` per the settled policy (P1) and the basis is named
 * explicitly so consumers can tell a render clock from a dated disclosure.
 */
export function sameRunRenderClockFreshnessMetadata(
  sourceTimestamp: number,
): {
  sourceTimestamp: number;
  freshnessMode: "verified";
  details: { freshnessSource: "same-run-render-clock" };
} {
  return {
    ...verifiedFreshnessMetadata(sourceTimestamp),
    details: { freshnessSource: "same-run-render-clock" },
  };
}

export function unverifiedFreshnessMetadata(
  source: string,
  reason: string,
): { freshnessMode: "unverified"; details: { freshnessSource: string; freshnessReason: string } } {
  return {
    freshnessMode: "unverified",
    details: {
      freshnessSource: source,
      freshnessReason: reason,
    },
  };
}

export function freshnessMetadataFromTimestamp(
  sourceTimestamp: number | null | undefined,
  fallbackSource: string,
  fallbackReason: string,
):
  | { sourceTimestamp: number; freshnessMode: "verified" }
  | { freshnessMode: "unverified"; details: { freshnessSource: string; freshnessReason: string } } {
  return sourceTimestamp != null
    ? verifiedFreshnessMetadata(sourceTimestamp)
    : unverifiedFreshnessMetadata(fallbackSource, fallbackReason);
}

export function notApplicableFreshnessMetadata(
  details?: Record<string, unknown>,
): { freshnessMode: "not-applicable"; details?: Record<string, unknown> } {
  return details
    ? {
        freshnessMode: "not-applicable",
        details,
      }
    : {
        freshnessMode: "not-applicable",
      };
}

export const SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC = 60 * 60;

export interface SourceTimestampSummary {
  sourceTimestamp: number;
  latestSourceTimestamp: number;
  sourceTimestampSpreadSec: number;
  timestampCount: number;
}

export function summarizeSourceTimestamps(values: readonly unknown[]): SourceTimestampSummary | null {
  const timestamps = values
    .map((value) => parseTimestampLikeToUnixSeconds(value))
    .filter((value): value is number => value != null)
    .sort((left, right) => left - right);

  if (timestamps.length === 0) {
    return null;
  }

  const sourceTimestamp = timestamps[0];
  const latestSourceTimestamp = timestamps[timestamps.length - 1];
  return {
    sourceTimestamp,
    latestSourceTimestamp,
    sourceTimestampSpreadSec: latestSourceTimestamp - sourceTimestamp,
    timestampCount: timestamps.length,
  };
}

export interface SourceTimestampCoverageSummary extends SourceTimestampSummary {
  /** Submitted values that could not be parsed into a timestamp. Callers that
   *  submit one value per material row must treat a non-zero count as
   *  incomplete coverage rather than silently letting the remaining rows'
   *  clock stand in for the whole composition. */
  untimestampedCount: number;
}

/**
 * {@link summarizeSourceTimestamps} variant for callers that submit one value
 * per material row: unparseable timestamps are counted in
 * `untimestampedCount` instead of being dropped, so the caller can withhold
 * verified freshness when any material row lacks a clock.
 */
export function summarizeSourceTimestampsRequiringCoverage(
  values: readonly unknown[],
): SourceTimestampCoverageSummary | null {
  const timestamps: number[] = [];
  let untimestampedCount = 0;
  for (const value of values) {
    const parsed = parseTimestampLikeToUnixSeconds(value);
    if (parsed == null) {
      untimestampedCount += 1;
    } else {
      timestamps.push(parsed);
    }
  }
  if (timestamps.length === 0) {
    return null;
  }
  timestamps.sort((left, right) => left - right);
  return {
    sourceTimestamp: timestamps[0],
    latestSourceTimestamp: timestamps[timestamps.length - 1],
    sourceTimestampSpreadSec: timestamps[timestamps.length - 1] - timestamps[0],
    timestampCount: timestamps.length,
    untimestampedCount,
  };
}

function normalizeUnixTimestampSeconds(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value >= 1_000_000_000_000 ? value / 1000 : value);
}

/**
 * Parse a timestamp-like value (epoch number, epoch string, `DD/MM/YY`, or a
 * long date like `Jan 5, 2024`) into Unix seconds, or `null` when it can't be
 * parsed unambiguously.
 *
 * Short `DD/MM/YY` dates are deliberately rejected (return `null`) whenever both
 * the day and month are <= 12 (e.g. `05/11/24`), because the field order is then
 * ambiguous between DD/MM and MM/DD and silently guessing would risk an off-by-
 * months timestamp. This is a conservative, intentional choice: callers that
 * know the field order in advance (e.g. `ripple-transparency.ts`) should parse
 * with their own format-specific parser rather than relying on this helper, and
 * an adapter that hits this path falls back to `unverified` freshness.
 */
export function parseTimestampLikeToUnixSeconds(value: unknown): number | null {
  if (typeof value === "number") {
    return normalizeUnixTimestampSeconds(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    return normalizeUnixTimestampSeconds(Number(trimmed));
  }

  const shortDateMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (shortDateMatch) {
    const [, day, month, year] = shortDateMatch;
    const dayNumber = Number(day);
    const monthNumber = Number(month);
    if (
      !Number.isInteger(dayNumber) ||
      !Number.isInteger(monthNumber) ||
      dayNumber < 1 ||
      dayNumber > 31 ||
      monthNumber < 1 ||
      monthNumber > 12 ||
      (dayNumber <= 12 && monthNumber <= 12)
    ) {
      return null;
    }
    const fullYear = 2000 + Number(year);
    const parsed = Date.UTC(fullYear, monthNumber - 1, dayNumber);
    const parsedDate = new Date(parsed);
    if (
      parsedDate.getUTCFullYear() !== fullYear ||
      parsedDate.getUTCMonth() !== monthNumber - 1 ||
      parsedDate.getUTCDate() !== dayNumber
    ) {
      return null;
    }
    return normalizeUnixTimestampSeconds(parsed);
  }

  const longDateOnlyMatch = trimmed.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/);
  if (longDateOnlyMatch) {
    const parsed = Date.parse(`${trimmed} 00:00:00 UTC`);
    return Number.isFinite(parsed) ? normalizeUnixTimestampSeconds(parsed) : null;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? normalizeUnixTimestampSeconds(parsed) : null;
}
