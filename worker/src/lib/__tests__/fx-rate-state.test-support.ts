import { sha256Hex } from "@shared/lib/sha256";

/**
 * One published FX generation as the two `cache` rows `persistFxRateState()` writes:
 * the rates plus digest-bound metadata sharing its clock, with fresh live intraday
 * provenance for every peg unless `metaOverrides` says otherwise.
 */
export function fxRatesCacheRows(
  updatedAt: number,
  rates: Record<string, number> = { peggedEUR: 1.08 },
  metaOverrides: Record<string, unknown> = {},
): Array<{ key: string; updated_at: number; value: string }> {
  const ratesValue = JSON.stringify(rates);
  const pegKeys = Object.keys(rates);
  return [
    { key: "fx-rates", updated_at: updatedAt, value: ratesValue },
    {
      key: "fx-rates-meta",
      updated_at: updatedAt,
      value: JSON.stringify({
        usableSyncAt: updatedAt,
        mode: "live",
        sourceUpdatedAtByPeg: Object.fromEntries(pegKeys.map((pegKey) => [pegKey, updatedAt])),
        sourceModeByPeg: Object.fromEntries(pegKeys.map((pegKey) => [pegKey, "live"])),
        sourceCadenceByPeg: Object.fromEntries(pegKeys.map((pegKey) => [pegKey, "intraday"])),
        sourceDateByPeg: Object.fromEntries(pegKeys.map((pegKey) => [pegKey, null])),
        consecutiveFallbackRuns: 0,
        ...metaOverrides,
        ratesSha256: sha256Hex(ratesValue),
      }),
    },
  ];
}
