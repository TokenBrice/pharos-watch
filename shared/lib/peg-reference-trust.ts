import type { PegRateSource } from "./peg-rates";

export interface PegReferenceTrustInput {
  pegCurrency?: string | null;
  pegType?: string | null;
  pegRateSource?: PegRateSource | null;
  pegRateContributorCount?: number | null;
  pegRateAvailable?: boolean;
}

/**
 * Minimum live contributors before a peer median may stand in for a missing
 * direct reference. A 1-coin median is the coin's own price (deviation always
 * ~0) and a 2-coin median mirrors half of any real move onto the healthy peer.
 */
export const MIN_PEER_MEDIAN_CONTRIBUTORS = 3;

/**
 * Whether a derived peg reference is trustworthy enough to anchor deviation
 * numbers. USD pegs anchor at 1; commodity and non-USD fiat pegs use live
 * FX/spot when available, otherwise they need a peer-group median of at least
 * `MIN_PEER_MEDIAN_CONTRIBUTORS` coins. The depeg detection engine has always
 * failed closed on this; display surfaces share the same gate (depeg-dews
 * v6.08). The legacy `fallback` source remains accepted for cached payload
 * compatibility.
 */
export function isAuthoritativeDepegPegReference(input: PegReferenceTrustInput): boolean {
  const isCommodityPeg =
    input.pegCurrency === "GOLD" || input.pegCurrency === "SILVER" ||
    input.pegType === "peggedGOLD" || input.pegType === "peggedSILVER";
  if (isCommodityPeg) {
    const available = input.pegRateAvailable ?? input.pegRateSource != null;
    if (!available) return false;
    // A commodity peer median may stand in for spot only with a real quorum;
    // a direct spot/fx/fallback rate does not need peers.
    return input.pegRateSource !== "median"
      || (input.pegRateContributorCount ?? 0) >= MIN_PEER_MEDIAN_CONTRIBUTORS;
  }

  // Only an explicit USD identity anchors at 1 without a peg type. An absent
  // peg type for any other currency is missing evidence, not a reference.
  if (!input.pegType) {
    return input.pegCurrency === "USD";
  }
  if (input.pegType === "peggedUSD") {
    return true;
  }

  const pegCurrency = input.pegCurrency ?? null;
  if (
    pegCurrency === "USD" ||
    pegCurrency === "VAR" ||
    pegCurrency === "OTHER" ||
    pegCurrency === "GOLD" ||
    pegCurrency === "SILVER"
  ) {
    return true;
  }

  return input.pegRateSource === "fx" || input.pegRateSource === "fallback" ||
    (input.pegRateContributorCount ?? 0) >= MIN_PEER_MEDIAN_CONTRIBUTORS;
}
