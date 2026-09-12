import type { SupplementalSourceFamilyKey } from "./supplemental-source-family-keys";

/**
 * Canonical source-key prefix routing table.
 *
 * Auto-discovered yield pools carry a `sourceKey` whose prefix identifies the
 * venue protocol, the supplemental fetch family, and where the chain segment
 * lives in the colon-delimited key. Three call sites used to re-implement this
 * prefix→{protocol, chain, family} mapping independently
 * (`inferVenueProtocol`, `inferVenueChain`, `getSupplementalCandidateFamily`);
 * they now all derive from this single table so a new family only needs one
 * edit here. See audit R-080. B29 (yield v8.43) added the standalone
 * first-party readers, which have no chain segment and no supplemental family.
 */
export interface YieldSourceKeyRoute {
  /** The literal `sourceKey` prefix this route matches. */
  prefix: string;
  /** Venue protocol attributed to the source (feeds venue-risk scoring). */
  venueProtocol: string;
  /**
   * Index of the chain segment when the key is split on ":". `null` for
   * standalone `protocol-api:<source>` / `onchain:<coinId>` keys, whose middle
   * segment is the source or coin id rather than a chain.
   */
  chainSegmentIndex: number | null;
  /**
   * Supplemental fetch family this prefix backfills (partial-family cache).
   * `null` for standalone readers: no supplemental family lane produces them, so
   * attributing one would inflate that family's freshness accounting (B29).
   */
  family: SupplementalSourceFamilyKey | null;
}

export const YIELD_SOURCE_KEY_ROUTES: readonly YieldSourceKeyRoute[] = [
  { prefix: "protocol-api:morpho-vault:", venueProtocol: "morpho-blue", chainSegmentIndex: 2, family: "morpho" },
  { prefix: "protocol-api:pendle:", venueProtocol: "pendle", chainSegmentIndex: 2, family: "pendle" },
  { prefix: "protocol-api:yearn:", venueProtocol: "yearn", chainSegmentIndex: 2, family: "yearnKong" },
  { prefix: "protocol-api:kong:", venueProtocol: "kong", chainSegmentIndex: 2, family: "yearnKong" },
  { prefix: "protocol-api:k3:", venueProtocol: "k3", chainSegmentIndex: 2, family: "yearnKong" },
  { prefix: "protocol-api:beefy:", venueProtocol: "beefy", chainSegmentIndex: 2, family: "beefy" },
  { prefix: "protocol-api:vaults-fyi:", venueProtocol: "vaults-fyi", chainSegmentIndex: 2, family: "vaultsFyi" },
  { prefix: "protocol-api:compound-v3-supply:", venueProtocol: "compound-v3", chainSegmentIndex: 2, family: "compoundV3" },
  { prefix: "aave-v3-onchain:", venueProtocol: "aave-v3", chainSegmentIndex: 1, family: "aaveV3" },
  { prefix: "royco-dawn:", venueProtocol: "royco-dawn", chainSegmentIndex: 1, family: "roycoDawn" },
  // B29: standalone first-party readers. They carry no chain segment and belong
  // to no supplemental family, so `venueProtocol` is the only attribution they
  // can publish — unreviewed slugs keep the tier `unknown` (never guessed).
  { prefix: "protocol-api:bima-susbd", venueProtocol: "bima", chainSegmentIndex: null, family: null },
  { prefix: "protocol-api:etherfuse-cetes-current-issuance", venueProtocol: "etherfuse", chainSegmentIndex: null, family: null },
  { prefix: "protocol-api:hashnote-usyc", venueProtocol: "hashnote", chainSegmentIndex: null, family: null },
  { prefix: "protocol-api:ondo-usdy-oracle", venueProtocol: "ondo-yield-assets", chainSegmentIndex: null, family: null },
  { prefix: "protocol-api:midas-mmev-nav-oracle", venueProtocol: "midas-rwa", chainSegmentIndex: null, family: null },
  { prefix: "protocol-api:re-protocol-reusd", venueProtocol: "re-protocol", chainSegmentIndex: null, family: null },
  { prefix: "protocol-api:zys-zephyr-protocol", venueProtocol: "zephyr-protocol", chainSegmentIndex: null, family: null },
  { prefix: "onchain:scrvusd-curve:scrvusd-current-rate", venueProtocol: "curve-llamalend", chainSegmentIndex: null, family: null },
  { prefix: "onchain:lusd-liquity", venueProtocol: "liquity-v1", chainSegmentIndex: null, family: null },
  { prefix: "onchain:bold-liquity", venueProtocol: "liquity-v2", chainSegmentIndex: null, family: null },
  { prefix: "onchain:bd-basedollar", venueProtocol: "base-dollar", chainSegmentIndex: null, family: null },
];

export function resolveYieldSourceKeyRoute(
  sourceKey: string | null | undefined,
): YieldSourceKeyRoute | null {
  if (!sourceKey) return null;
  return YIELD_SOURCE_KEY_ROUTES.find((route) => sourceKey.startsWith(route.prefix)) ?? null;
}
