import type { PegCurrency } from "@shared/types";
import type { AltPegLinkHubItem } from "@/lib/alt-peg-market";

export type Iso2 = string;

/**
 * ISO-3166-1 alpha-2 countries where each fiat peg is the reference currency.
 * Extend when a new fiat peg is added to the taxonomy — the geography test
 * enforces coverage for every `AltPegRegion !== "Other"` fiat peg.
 */
export const PEG_COUNTRY_MAP: Partial<Record<PegCurrency, readonly Iso2[]>> = {
  EUR: ["DE","FR","IT","ES","NL","BE","AT","PT","IE","FI","GR","SK","SI","LU","EE","LV","LT","CY","MT","HR"],
  CHF: ["CH","LI"],
  GBP: ["GB"],
  RUB: ["RU"],
  TRY: ["TR"],
  JPY: ["JP"],
  IDR: ["ID"],
  SGD: ["SG"],
  CNH: ["CN","HK"],
  PHP: ["PH"],
  BRL: ["BR"],
  CAD: ["CA"],
  MXN: ["MX"],
  ZAR: ["ZA"],
  AUD: ["AU"],
};

export interface CountryFill {
  peg: PegCurrency;
  colorHex: string;
}

/**
 * Builds a Map<ISO-A2, CountryFill> from the taxonomy-driven link-hub items.
 * Only fiat pegs present in PEG_COUNTRY_MAP participate. The item's own
 * colorHex (from PEG_CHART_COLORS) is propagated to each country it covers.
 */
export function buildCountryColorMap(
  items: readonly AltPegLinkHubItem[],
): ReadonlyMap<Iso2, CountryFill> {
  const result = new Map<Iso2, CountryFill>();
  for (const item of items) {
    const countries = PEG_COUNTRY_MAP[item.peg];
    if (!countries) continue;
    for (const iso of countries) {
      result.set(iso, { peg: item.peg, colorHex: item.colorHex });
    }
  }
  return result;
}
