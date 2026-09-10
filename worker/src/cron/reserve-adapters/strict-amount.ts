export interface StrictAmountEntry {
  amount?: number | string;
}

/**
 * Binds a strict amount parser to an adapter key so error messages keep the
 * adapter's own prefix. Finite numbers pass through, numeric strings are
 * converted, and anything else throws so a malformed payload can never
 * silently read as zero.
 */
export function strictAmountParser(adapterKey: string): (value: unknown, label: string) => number {
  return (value, label) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
    throw new Error(`${adapterKey} ${label} is not a finite number: ${String(value)}`);
  };
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
