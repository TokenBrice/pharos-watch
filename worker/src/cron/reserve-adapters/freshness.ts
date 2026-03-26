export function verifiedFreshnessMetadata(
  sourceTimestamp: number,
): { sourceTimestamp: number; freshnessMode: "verified" } {
  return {
    sourceTimestamp,
    freshnessMode: "verified",
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

function normalizeUnixTimestampSeconds(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value >= 1_000_000_000_000 ? value / 1000 : value);
}

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

  const shortDateMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (shortDateMatch) {
    const [, day, month, year] = shortDateMatch;
    const parsed = Date.UTC(2000 + Number(year), Number(month) - 1, Number(day));
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
