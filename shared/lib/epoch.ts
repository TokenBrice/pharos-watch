import { isValidCalendarDate } from "../types/date-primitives";

export type EpochNumericTextPolicy = "any" | "digits-only";

export interface EpochParserOptions {
  numericTextPolicy: EpochNumericTextPolicy;
  millisecondsThreshold: number;
  millisecondsThresholdInclusive: boolean;
}

export type EpochParseResult =
  | { kind: "seconds"; seconds: number }
  | { kind: "invalid" };

function numericValueToSeconds(value: number, options: EpochParserOptions): EpochParseResult {
  if (!Number.isFinite(value)) return { kind: "invalid" };
  const isMilliseconds = options.millisecondsThresholdInclusive
    ? value >= options.millisecondsThreshold
    : value > options.millisecondsThreshold;
  return { kind: "seconds", seconds: isMilliseconds ? value / 1000 : value };
}

/** Parse an epoch number/string or ISO date into a tagged Unix-seconds result. */
export function parseEpoch(value: unknown, options: EpochParserOptions): EpochParseResult {
  if (typeof value === "number") {
    return numericValueToSeconds(value, options);
  }

  if (typeof value !== "string") return { kind: "invalid" };
  const trimmed = value.trim();
  if (!trimmed) return { kind: "invalid" };

  const isNumericText = options.numericTextPolicy === "digits-only" ? /^\d+$/.test(trimmed) : true;
  if (isNumericText) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numericValueToSeconds(numeric, options);
    }
    if (options.numericTextPolicy === "digits-only") return { kind: "invalid" };
  }

  // Only ISO date/date-time grammar may follow a failed numeric parse.
  // Date.parse alone accepts signed/decimal tokens and rolls impossible days.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(trimmed);
  // Separate fractional seconds from optional time components so quantifiers
  // never nest; both forms retain the same ISO grammar.
  const validTime = iso != null && (
    iso[4] === ""
    || /^T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(iso[4])
    || /^T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d+(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(iso[4])
  );
  if (!iso || !validTime || !isValidCalendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))) {
    return { kind: "invalid" };
  }

  const parsedMs = Date.parse(trimmed);
  return Number.isFinite(parsedMs)
    ? { kind: "seconds", seconds: parsedMs / 1000 }
    : { kind: "invalid" };
}

export function parseEpochSeconds(
  value: unknown, options: EpochParserOptions & { floor: boolean; minExclusive?: number },
): number | null {
  const parsed = parseEpoch(value, options);
  if (parsed.kind !== "seconds") return null;
  const seconds = options.floor ? Math.floor(parsed.seconds) : parsed.seconds;
  return options.minExclusive == null || seconds > options.minExclusive ? seconds : null;
}
