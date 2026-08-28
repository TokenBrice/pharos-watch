export interface ParseRetryAfterOptions {
  nowMs?: number;
  /** Retains legacy parseInt-style handling where a caller historically accepted numeric prefixes. */
  allowNumericPrefix?: boolean;
  numericRounding?: "ceil" | "floor" | "none";
}

/** Parse Retry-After delta-seconds or an HTTP-date into non-negative seconds. */
export function parseRetryAfterSeconds(
  value: string | null | undefined,
  options: ParseRetryAfterOptions = {},
): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const numeric = options.allowNumericPrefix
    ? parseInt(trimmed, 10)
    : /^\d+(?:\.\d+)?$/.test(trimmed)
      ? Number(trimmed)
      : Number.NaN;
  if (Number.isFinite(numeric) && numeric >= 0) {
    if (options.numericRounding === "floor") return Math.floor(numeric);
    if (options.numericRounding === "none") return numeric;
    return Math.ceil(numeric);
  }
  if (/^[+-]?\d/.test(trimmed)) return null;

  const retryAtMs = Date.parse(trimmed);
  if (!Number.isFinite(retryAtMs)) return null;
  return Math.max(0, Math.ceil((retryAtMs - (options.nowMs ?? Date.now())) / 1000));
}
