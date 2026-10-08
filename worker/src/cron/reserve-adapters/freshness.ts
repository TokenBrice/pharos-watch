import { isValidCalendarDate, isValidIsoDateOnly } from "@shared/types/date-primitives";

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

export interface SourceTimestampCoverageSummary {
  sourceTimestamp: number | null;
  latestSourceTimestamp: number | null;
  sourceTimestampSpreadSec: number | null;
  timestampCount: number;
  /** One submitted value per material row; any missing clock prevents verified freshness. */
  untimestampedCount: number;
}

/** Only a source-reviewed caller may interpret a zoneless wall clock as UTC. */
export type SourceTimestampZonelessPolicy = "require-zone" | "assumed-utc";

function summarizeTimestampCoverage(
  values: readonly unknown[],
  zonelessPolicy: SourceTimestampZonelessPolicy,
): SourceTimestampCoverageSummary {
  let sourceTimestamp: number | null = null;
  let latestSourceTimestamp: number | null = null;
  let timestampCount = 0;
  let untimestampedCount = 0;
  for (const value of values) {
    const parsed = parseTimestampLikeToUnixSeconds(value, zonelessPolicy);
    if (parsed == null) {
      untimestampedCount += 1;
    } else {
      timestampCount += 1;
      if (sourceTimestamp == null || parsed < sourceTimestamp) sourceTimestamp = parsed;
      if (latestSourceTimestamp == null || parsed > latestSourceTimestamp) latestSourceTimestamp = parsed;
    }
  }
  return {
    sourceTimestamp,
    latestSourceTimestamp,
    sourceTimestampSpreadSec: sourceTimestamp != null && latestSourceTimestamp != null
      ? latestSourceTimestamp - sourceTimestamp
      : null,
    timestampCount,
    untimestampedCount,
  };
}

/** Optional alternative clocks: ignore missing values, return null only if none parse. */
export function summarizeSourceTimestamps(
  values: readonly unknown[],
  zonelessPolicy: SourceTimestampZonelessPolicy = "require-zone",
): SourceTimestampSummary | null {
  const summary = summarizeTimestampCoverage(values, zonelessPolicy);
  if (summary.sourceTimestamp == null || summary.latestSourceTimestamp == null) return null;
  return {
    sourceTimestamp: summary.sourceTimestamp,
    latestSourceTimestamp: summary.latestSourceTimestamp,
    sourceTimestampSpreadSec: summary.latestSourceTimestamp - summary.sourceTimestamp,
    timestampCount: summary.timestampCount,
  };
}

/**
 * {@link summarizeSourceTimestamps} variant for callers that submit one value
 * per material row: unparseable timestamps are counted in
 * `untimestampedCount` instead of being dropped, so the caller can withhold
 * verified freshness when any material row lacks a clock.
 */
export function summarizeSourceTimestampsRequiringCoverage(
  values: readonly unknown[],
  zonelessPolicy: SourceTimestampZonelessPolicy = "require-zone",
): SourceTimestampCoverageSummary {
  return summarizeTimestampCoverage(values, zonelessPolicy);
}

function normalizeUnixTimestampSeconds(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value >= 1_000_000_000_000 ? value / 1000 : value);
}

const MONTH_NUMBERS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function calendarTimestampSeconds(milliseconds: number): number | null {
  return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.floor(milliseconds / 1000) : null;
}

/**
 * Parse source epochs, calendar dates and explicitly zoned datetimes into Unix
 * seconds. Calendar dates normalize to UTC midnight; zoneless datetimes require
 * a source-reviewed `assumed-utc` policy and never inherit the host timezone.
 *
 * Short `DD/MM/YY` dates are deliberately rejected (return `null`) whenever both
 * the day and month are <= 12 (e.g. `05/11/24`), because the field order is then
 * ambiguous between DD/MM and MM/DD and silently guessing would risk an off-by-
 * months timestamp. This is a conservative, intentional choice: callers that
 * know the field order in advance (e.g. `ripple-transparency.ts`) should parse
 * with their own format-specific parser rather than relying on this helper, and
 * an adapter that hits this path falls back to `unverified` freshness.
 */
export function parseTimestampLikeToUnixSeconds(
  value: unknown,
  zonelessPolicy: SourceTimestampZonelessPolicy = "require-zone",
): number | null {
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
    const fullYear = 2000 + Number(year);
    if (
      (dayNumber <= 12 && monthNumber <= 12)
      || !isValidCalendarDate(fullYear, monthNumber, dayNumber)
    ) return null;
    return calendarTimestampSeconds(Date.UTC(fullYear, monthNumber - 1, dayNumber));
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return isValidIsoDateOnly(trimmed)
      ? calendarTimestampSeconds(Date.parse(`${trimmed}T00:00:00Z`))
      : null;
  }

  // Includes Accountable's captured `YYYY.MM.DD HH:mm:ss UTC` clock.
  const datetime = /^(\d{4})[-.](\d{2})[-.](\d{2})[Tt ](\d{2}):(\d{2})(.*)$/i.exec(trimmed);
  if (datetime) {
    const year = Number(datetime[1]);
    const month = Number(datetime[2]);
    const day = Number(datetime[3]);
    const hour = Number(datetime[4]);
    const minute = Number(datetime[5]);
    let suffix = datetime[6];
    let second = 0;
    if (suffix.startsWith(":")) {
      const seconds = /^:(\d{2})/.exec(suffix);
      if (!seconds) return null;
      second = Number(seconds[1]);
      suffix = suffix.slice(seconds[0].length);
      if (suffix.startsWith(".")) {
        const fraction = /^\.\d+/.exec(suffix);
        if (!fraction) return null;
        suffix = suffix.slice(fraction[0].length);
      }
    }
    const zone = suffix.trim();
    if (zone && !/^(?:Z|UTC|GMT|[+-]\d{2}:?\d{2})$/i.test(zone)) return null;
    if (
      !isValidCalendarDate(year, month, day)
      || hour > 23 || minute > 59 || second > 59
      || (!zone && zonelessPolicy !== "assumed-utc")
    ) return null;
    let offsetMinutes = 0;
    if (zone && /^[+-]/.test(zone)) {
      const offsetHour = Number(zone.slice(1, 3));
      const offsetMinute = Number(zone.slice(-2));
      if (offsetHour > 23 || offsetMinute > 59) return null;
      offsetMinutes = (zone[0] === "+" ? 1 : -1) * (offsetHour * 60 + offsetMinute);
    }
    return calendarTimestampSeconds(
      Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000,
    );
  }

  // Validate month-name calendars before Date.parse can roll an impossible day.
  // Both month-first disclosure dates and explicit-zone RFC dates remain usable.
  const monthFirst = /\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/.exec(trimmed);
  const dayFirst = /\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b/.exec(trimmed);
  if (monthFirst || dayFirst) {
    const monthName = monthFirst ? monthFirst[1] : dayFirst![2];
    const day = Number(monthFirst ? monthFirst[2] : dayFirst![1]);
    const year = Number(monthFirst ? monthFirst[3] : dayFirst![3]);
    const month = MONTH_NUMBERS[monthName.toLowerCase()];
    if (month == null || !isValidCalendarDate(year, month, day)) return null;
  }
  const yearFirst = /^(\d{4})[-.](\d{1,2})[-.](\d{1,2})(?=$|[Tt\s])/.exec(trimmed);
  if (yearFirst && !isValidCalendarDate(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]))) return null;
  // Localized slash dates belong to reviewed caller-specific parsers (SG Forge).
  if (/\d\s*\/\s*\d/.test(trimmed)) return null;
  const time = /\b(\d{1,2}):(\d{2})/.exec(trimmed);
  if (time) {
    const seconds = /^:(\d{2})/.exec(trimmed.slice(time.index + time[0].length));
    if (Number(time[1]) > 23 || Number(time[2]) > 59 || Number(seconds?.[1] ?? 0) > 59) return null;
  }
  const zoneText = trimmed.replace(/\s*\([^)]*\)$/, "").trim();
  const offset = /[+-](\d{2}):?(\d{2})$/.exec(zoneText);
  if (offset && (Number(offset[1]) > 23 || Number(offset[2]) > 59)) return null;
  const explicitZone = /(?:Z|UTC|GMT|[+-]\d{2}:?\d{2}|[ECMP][SD]T)$/i.test(zoneText);
  if (time && !explicitZone && zonelessPolicy !== "assumed-utc") return null;
  // Retain other previously tolerated source forms, but never consult host timezone.
  const parsed = Date.parse(explicitZone ? trimmed : `${trimmed} UTC`);
  return calendarTimestampSeconds(parsed);
}
