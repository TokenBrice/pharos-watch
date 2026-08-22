import type { PegRateSource } from "./peg-rates";

export interface PegReferenceTrustInput {
  pegCurrency?: string | null;
  pegType?: string | null;
  pegRateSource?: PegRateSource | null;
  pegRateContributorCount?: number | null;
  pegRateAvailable?: boolean;
}

/**
 * Whether a derived peg reference is trustworthy enough to anchor deviation
 * numbers. USD pegs anchor at 1; commodity pegs use an available arbitraged peer median;
 * non-USD fiat pegs use live FX when available, otherwise they need a peer-group median of
 * at least 3 coins — a 1-coin median is the coin's own price (deviation
 * always ~0) and a 2-coin median mirrors half of any real move onto the
 * healthy peer. The depeg detection engine has always failed closed on this;
 * display surfaces share the same gate (depeg-dews v6.08). The legacy
 * `fallback` source remains accepted for cached payload compatibility.
 */
export function isAuthoritativeDepegPegReference(input: PegReferenceTrustInput): boolean {
  const isCommodityPeg =
    input.pegCurrency === "GOLD" || input.pegCurrency === "SILVER" ||
    input.pegType === "peggedGOLD" || input.pegType === "peggedSILVER";
  if (isCommodityPeg) {
    return input.pegRateAvailable ?? input.pegRateSource != null;
  }

  if (!input.pegType || input.pegType === "peggedUSD") {
    return true;
  }

  const pegCurrency = input.pegCurrency ?? null;
  if (
    pegCurrency == null ||
    pegCurrency === "USD" ||
    pegCurrency === "VAR" ||
    pegCurrency === "OTHER" ||
    pegCurrency === "GOLD" ||
    pegCurrency === "SILVER"
  ) {
    return true;
  }

  return input.pegRateSource === "fx" || input.pegRateSource === "fallback" ||
    (input.pegRateContributorCount ?? 0) >= 3;
}
