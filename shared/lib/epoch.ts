export type EpochNumericTextPolicy = "any" | "digits-only";

export interface EpochParserOptions {
  numericTextPolicy: EpochNumericTextPolicy;
  millisecondsThreshold: number;
  millisecondsThresholdInclusive: boolean;
}

export interface EpochSecondsParserOptions extends EpochParserOptions {
  floor: boolean;
  minExclusive?: number;
  isoMinExclusive?: number | null;
  numericTextMinRejectionPolicy?: "invalid" | "iso-fallback";
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

  const parsedMs = Date.parse(trimmed);
  return Number.isFinite(parsedMs)
    ? { kind: "seconds", seconds: parsedMs / 1000 }
    : { kind: "invalid" };
}

function finalizeSeconds(value: number, floor: boolean, minExclusive?: number): number | null {
  const seconds = floor ? Math.floor(value) : value;
  return minExclusive == null || seconds > minExclusive ? seconds : null;
}

/** Parse an epoch number/string or ISO date into Unix seconds under an explicit adapter policy. */
export function parseEpochSeconds(value: unknown, options: EpochSecondsParserOptions): number | null {
  if (typeof value === "number") {
    const parsed = numericValueToSeconds(value, options);
    return parsed.kind === "seconds"
      ? finalizeSeconds(parsed.seconds, options.floor, options.minExclusive)
      : null;
  }

  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const isNumericText = options.numericTextPolicy === "digits-only" ? /^\d+$/.test(trimmed) : true;
  if (isNumericText) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      const parsed = numericValueToSeconds(numeric, options);
      const seconds = parsed.kind === "seconds"
        ? finalizeSeconds(parsed.seconds, options.floor, options.minExclusive)
        : null;
      if (seconds != null || options.numericTextMinRejectionPolicy !== "iso-fallback") return seconds;
    } else if (options.numericTextPolicy === "digits-only") {
      return null;
    }
  }

  const parsedMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedMs)) return null;
  const isoMinExclusive = options.isoMinExclusive === undefined
    ? options.minExclusive
    : options.isoMinExclusive ?? undefined;
  return finalizeSeconds(parsedMs / 1000, options.floor, isoMinExclusive);
}
