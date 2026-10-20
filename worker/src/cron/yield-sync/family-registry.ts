import {
  PENDLE_SUPPLEMENTAL_FETCH_CADENCE_SEC,
  PENDLE_SUPPLEMENTAL_STALE_THRESHOLD_MS,
  SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS,
} from "../../lib/yield-ranking-helpers";

export const COMPOUND_V3_COMETS = [
  { stablecoinId: "usdc-circle", chain: "ethereum", comet: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", symbol: "USDC" },
  { stablecoinId: "usdt-tether", chain: "ethereum", comet: "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840", symbol: "USDT" },
  { stablecoinId: "usdc-circle", chain: "base", comet: "0xb125E6687d4313864e53df431d5425969c15Eb2F", symbol: "USDC" },
  { stablecoinId: "usdc-circle", chain: "arbitrum", comet: "0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA", symbol: "USDC" },
] as const;

// Verified Aave V3 reserves (aave-address-book AaveV3Ethereum/Arbitrum/Base,
// 2026-09-27). Match these identities against the active tracked inventory.
export const AAVE_V3_PINNED_RESERVES = [
  { stablecoinId: "usdc-circle", chain: "ethereum", assetAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
  { stablecoinId: "usdt-tether", chain: "arbitrum", assetAddress: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9" },
  { stablecoinId: "usdc-circle", chain: "base", assetAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
] as const;

/** Low-level membership, ordering, retention and source-key authority; no family runners. */
export const SUPPLEMENTAL_SOURCE_FAMILY_REGISTRY = {
  morpho: {
    required: true,
    fetchCadenceSec: null,
    staleThresholdSec: SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS / 1000,
    routes: [
      { prefix: "protocol-api:morpho-vault:", venueProtocol: "morpho-blue", chainSegmentIndex: 2 },
    ],
  },
  pendle: {
    required: true,
    fetchCadenceSec: PENDLE_SUPPLEMENTAL_FETCH_CADENCE_SEC,
    staleThresholdSec: PENDLE_SUPPLEMENTAL_STALE_THRESHOLD_MS / 1000,
    routes: [
      { prefix: "protocol-api:pendle:", venueProtocol: "pendle", chainSegmentIndex: 2 },
    ],
  },
  yearnKong: {
    required: true,
    fetchCadenceSec: null,
    staleThresholdSec: SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS / 1000,
    routes: [
      { prefix: "protocol-api:yearn:", venueProtocol: "yearn", chainSegmentIndex: 2 },
      { prefix: "protocol-api:kong:", venueProtocol: "kong", chainSegmentIndex: 2 },
      { prefix: "protocol-api:k3:", venueProtocol: "k3", chainSegmentIndex: 2 },
    ],
  },
  beefy: {
    required: true,
    fetchCadenceSec: null,
    staleThresholdSec: SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS / 1000,
    routes: [
      { prefix: "protocol-api:beefy:", venueProtocol: "beefy", chainSegmentIndex: 2 },
    ],
  },
  compoundV3: {
    required: true,
    fetchCadenceSec: null,
    staleThresholdSec: SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS / 1000,
    routes: [
      { prefix: "protocol-api:compound-v3-supply:", venueProtocol: "compound-v3", chainSegmentIndex: 2 },
    ],
  },
  aaveV3: {
    required: true,
    fetchCadenceSec: null,
    staleThresholdSec: SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS / 1000,
    routes: [
      { prefix: "aave-v3-onchain:", venueProtocol: "aave-v3", chainSegmentIndex: 1 },
    ],
  },
  roycoDawn: {
    required: true,
    fetchCadenceSec: null,
    staleThresholdSec: SUPPLEMENTAL_SOURCE_STALE_THRESHOLD_MS / 1000,
    routes: [
      { prefix: "royco-dawn:", venueProtocol: "royco-dawn", chainSegmentIndex: 1 },
    ],
  },
} as const;

export type SupplementalSourceFamilyKey = keyof typeof SUPPLEMENTAL_SOURCE_FAMILY_REGISTRY;

export const SUPPLEMENTAL_SOURCE_FAMILY_KEYS = Object.keys(
  SUPPLEMENTAL_SOURCE_FAMILY_REGISTRY,
) as SupplementalSourceFamilyKey[];

/** Price-dependent Aave runs only after the stablecoins producer; siblings keep their existing slots. */
export const INDEPENDENT_SUPPLEMENTAL_SOURCE_FAMILY_KEYS = SUPPLEMENTAL_SOURCE_FAMILY_KEYS.filter(
  (family) => family !== "aaveV3",
);

/** Families whose retained snapshot gates the publication lane (partial-family-cache). */
export const REQUIRED_SUPPLEMENTAL_SOURCE_FAMILY_KEYS = SUPPLEMENTAL_SOURCE_FAMILY_KEYS.filter(
  (family) => SUPPLEMENTAL_SOURCE_FAMILY_REGISTRY[family].required,
);

export function getSupplementalFamilyStaleThresholdSec(family: SupplementalSourceFamilyKey): number {
  return SUPPLEMENTAL_SOURCE_FAMILY_REGISTRY[family].staleThresholdSec;
}

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

// Standalone and retired readers have no producing supplemental family. Match
// the specific yearn:ybold route before the family's broader yearn: prefix.
const YIELD_SOURCE_KEY_ROUTES: readonly YieldSourceKeyRoute[] = [
  { prefix: "protocol-api:yearn:ybold", venueProtocol: "yearn", chainSegmentIndex: null, family: null },
  { prefix: "protocol-api:vaults-fyi:", venueProtocol: "vaults-fyi", chainSegmentIndex: 2, family: null },
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
  ...SUPPLEMENTAL_SOURCE_FAMILY_KEYS.flatMap((family) =>
    SUPPLEMENTAL_SOURCE_FAMILY_REGISTRY[family].routes.map((route) => ({ ...route, family })),
  ),
];

export function resolveYieldSourceKeyRoute(
  sourceKey: string | null | undefined,
): YieldSourceKeyRoute | null {
  if (!sourceKey) return null;
  return YIELD_SOURCE_KEY_ROUTES.find((route) => sourceKey.startsWith(route.prefix)) ?? null;
}
