import { getPegTaxonomyByCurrency } from "./peg-taxonomy";
import { isFiniteNumber } from "./type-guards";
import { formatPrice } from "./format";


export function pegCurrencySymbol(pegCurrency: string): string {
  return getPegTaxonomyByCurrency(pegCurrency)?.symbol ?? "$";
}


/**
 * Format a USD price in the peg's native unit (e.g. gold ounces for XAUT).
 *
 * Null/unusable `pegRef` contract: fall back to the observed USD price with an
 * explicit "$" symbol — real data, clearly USD-labeled, never a fabricated
 * native-unit figure. Reference-derived surfaces (deviation, depeg signals,
 * peg scores) must fail closed at their own call sites instead; callers whose
 * cell IS the native conversion render "—" themselves (see
 * stablecoin-table-row-model.ts priceCell).
 */
export function formatNativePrice(
  usdPrice: number | null | undefined,
  pegCurrency: string,
  pegRef: number | null,
  decimals = 4,
): string {
  if (!isFiniteNumber(usdPrice)) return "N/A";
  const taxonomy = getPegTaxonomyByCurrency(pegCurrency);
  const symbol = taxonomy?.symbol ?? "$";
  if (taxonomy?.nativePriceUsesUsdSymbol === true) {
    return formatPrice(usdPrice, "$", decimals);
  }
  if (pegRef == null || !Number.isFinite(pegRef) || pegRef <= 0) return formatPrice(usdPrice, "$", decimals);
  return formatPrice(usdPrice / pegRef, symbol, decimals);
}


/** Keep rounded at-peg occupancy distinguishable from a truly perfect record. */
export function formatPegOccupancy(value: number | null | undefined, decimals = 2): string {
  if (!isFiniteNumber(value)) return "-";
  const rounded = value.toFixed(decimals);
  return value < 100 && Number(rounded) === 100 ? "<100%" : `${rounded}%`;
}
