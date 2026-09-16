export interface StrictAmountEntry {
  amount?: number | string;
}

export interface ParseFiniteNumberOptions {
  label: string;
  min?: number;
  allowGrouped?: boolean;
}

function isAsciiDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function isDecimal(value: string): boolean {
  const unsigned = value[0] === "+" || value[0] === "-" ? value.slice(1) : value;
  const parts = unsigned.split(".");
  return parts.length <= 2 && parts.every(isAsciiDigits);
}

function isGroupedDecimal(value: string): boolean {
  const unsigned = value[0] === "+" || value[0] === "-" ? value.slice(1) : value;
  const parts = unsigned.split(".");
  if (parts.length > 2 || (parts.length === 2 && !isAsciiDigits(parts[1]))) return false;
  const groups = parts[0].split(",");
  return groups.length > 1
    && groups[0].length <= 3
    && isAsciiDigits(groups[0])
    && groups.slice(1).every((group) => group.length === 3 && isAsciiDigits(group));
}

export function parseFiniteNumber(value: unknown, options: ParseFiniteNumberOptions): number {
  let parsed = Number.NaN;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    const trimmed = value.trim();
    if (!options.allowGrouped || isDecimal(trimmed) || isGroupedDecimal(trimmed)) {
      parsed = Number(options.allowGrouped ? trimmed.replaceAll(",", "") : trimmed);
    }
  }
  if (!Number.isFinite(parsed) || (options.min != null && parsed < options.min)) {
    throw new Error(`${options.label} is not a finite number: ${String(value)}`);
  }
  return parsed;
}

export function requireRecord(
  value: unknown,
  errorMessage: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(errorMessage);
  }
  return value as Record<string, unknown>;
}

export function parseDigitString(value: unknown, errorMessage: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(errorMessage);
  }
  return BigInt(value);
}

/**
 * Binds a strict amount parser to an adapter key so error messages keep the
 * adapter's own prefix. Finite numbers pass through, numeric strings are
 * converted, and anything else throws so a malformed payload can never
 * silently read as zero.
 */
export function strictAmountParser(adapterKey: string): (value: unknown, label: string) => number {
  return (value, label) => parseFiniteNumber(value, { label: `${adapterKey} ${label}` });
}

/**
 * Sums the USD amounts of one backing-asset entry list, rejecting a
 * non-array list and any negative or non-finite amount.
 */
export function sumBackingAssetAmounts(
  adapterKey: string,
  assetKey: string,
  entries: readonly StrictAmountEntry[] | undefined,
): number {
  if (!Array.isArray(entries)) {
    throw new Error(`${adapterKey} backing asset ${assetKey} entry list is not an array`);
  }
  const parseAmount = strictAmountParser(adapterKey);
  return entries.reduce((total, entry, index) => {
    const amount = parseAmount(entry?.amount, `backing asset ${assetKey} entry ${index} amount`);
    if (amount < 0) {
      throw new Error(`${adapterKey} backing asset ${assetKey} entry ${index} has a negative amount`);
    }
    return total + amount;
  }, 0);
}
