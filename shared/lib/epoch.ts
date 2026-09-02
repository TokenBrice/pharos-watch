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
