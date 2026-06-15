import type { SupplementalSourceFamilyKey } from "./supplemental-source-families";

/**
 * Canonical source-key prefix routing table.
 *
 * Auto-discovered yield pools carry a `sourceKey` whose prefix identifies the
 * venue protocol, the supplemental fetch family, and where the chain segment
 * lives in the colon-delimited key. Three call sites used to re-implement this
 * prefix→{protocol, chain, family} mapping independently
 * (`inferVenueProtocol`, `inferVenueChain`, `getSupplementalCandidateFamily`);
 * they now all derive from this single table so a new family only needs one
 * edit here. See audit R-080.
 */
export interface YieldSourceKeyRoute {
  /** The literal `sourceKey` prefix this route matches. */
  prefix: string;
  /** Venue protocol attributed to the source (feeds venue-risk scoring). */
  venueProtocol: string;
  /** Index of the chain segment when the key is split on ":". */
  chainSegmentIndex: number;
  /** Supplemental fetch family this prefix backfills (partial-family cache). */
  family: SupplementalSourceFamilyKey;
}

export const YIELD_SOURCE_KEY_ROUTES: readonly YieldSourceKeyRoute[] = [
  { prefix: "protocol-api:morpho-vault:", venueProtocol: "morpho-blue", chainSegmentIndex: 2, family: "morpho" },
  { prefix: "protocol-api:pendle:", venueProtocol: "pendle", chainSegmentIndex: 2, family: "pendle" },
  { prefix: "protocol-api:yearn:", venueProtocol: "yearn", chainSegmentIndex: 2, family: "yearnKong" },
  { prefix: "protocol-api:kong:", venueProtocol: "kong", chainSegmentIndex: 2, family: "yearnKong" },
  { prefix: "protocol-api:k3:", venueProtocol: "k3", chainSegmentIndex: 2, family: "yearnKong" },
  { prefix: "protocol-api:beefy:", venueProtocol: "beefy", chainSegmentIndex: 2, family: "beefy" },
  { prefix: "protocol-api:compound-v3-supply:", venueProtocol: "compound-v3", chainSegmentIndex: 2, family: "compoundV3" },
  { prefix: "aave-v3-onchain:", venueProtocol: "aave-v3", chainSegmentIndex: 1, family: "aaveV3" },
  { prefix: "royco-dawn:", venueProtocol: "royco-dawn", chainSegmentIndex: 1, family: "roycoDawn" },
];

export function resolveYieldSourceKeyRoute(
  sourceKey: string | null | undefined,
): YieldSourceKeyRoute | null {
  if (!sourceKey) return null;
  return YIELD_SOURCE_KEY_ROUTES.find((route) => sourceKey.startsWith(route.prefix)) ?? null;
}
