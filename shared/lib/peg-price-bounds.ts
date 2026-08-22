import {
  PEG_FX_RATE_BOUNDS,
  getPegTaxonomyByCurrency,
  getPegTaxonomyByType,
  normalizePegTypeAlias,
  pegTypeFromCurrency,
  type PegClass,
} from "./peg-taxonomy";

export type { PegClass } from "./peg-taxonomy";

/** Live FX/commodity reference bounds keyed by canonical DefiLlama peg type. */
export const FX_RATE_BOUNDS = PEG_FX_RATE_BOUNDS;

/** Normalize legacy peg-type aliases through the canonical peg taxonomy. */
export function normalizeLegacyPegType(pegType: string): string {
  return normalizePegTypeAlias(pegType);
}

export function normalizePegTypeFromCurrency(pegCurrency: string | undefined): string | undefined {
  return pegTypeFromCurrency(pegCurrency);
}

export function classifyPegClass(
  pegCurrency: string | undefined,
  pegType: string | undefined,
  navToken: boolean,
): PegClass {
  if (navToken) return "nav";
  const currencyEntry = getPegTaxonomyByCurrency(pegCurrency);
  if (currencyEntry?.pegClass === "variable") return "variable";
  if (!pegType) return "unknown";
  return getPegTaxonomyByType(pegType)?.pegClass ?? "unknown";
}
