import { getCoreNonUsdPeg } from "../lib/alt-peg-snapshot";
import { CLIENT_CORE_AGGREGATE_ACTIVE_IDS } from "../lib/stablecoins/aggregate-client-registry";

/** Every core member whose registry peg is not USD: the non-USD reducer's expected set. */
export const CORE_NON_USD_IDS: readonly string[] = [...CLIENT_CORE_AGGREGATE_ACTIVE_IDS].filter(
  (id) => getCoreNonUsdPeg(id) !== null,
);

/**
 * One row per core non-USD member, so a fixture reads as complete unless a test
 * says otherwise. `caps[id]`: a number is an observed supply, `null` an empty
 * bucket, `"omit"` drops the row; everyone else gets `fallback` (an observed
 * zero by default, which keeps sums unchanged).
 */
export function coreNonUsdRows<T>(
  make: (id: string, marketCap: number | null) => T,
  caps: Readonly<Record<string, number | null | "omit">> = {},
  fallback = 0,
): T[] {
  return CORE_NON_USD_IDS.flatMap((id) => {
    const cap = id in caps ? caps[id] : fallback;
    return cap === "omit" ? [] : [make(id, cap ?? null)];
  });
}
