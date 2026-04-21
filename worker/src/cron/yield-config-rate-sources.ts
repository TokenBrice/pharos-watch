import type { OnChainRateConfig, RateDerivedConfig } from "./yield-config-registry";

/**
 * Tier 1: On-chain exchange rate sources.
 * These produce the highest-fidelity APY by reading vault exchange rates directly.
 */
export const ON_CHAIN_RATE_CONFIGS: OnChainRateConfig[] = [
  {
    stablecoinId: "usde-ethena",
    chain: "ethereum",
    contract: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "iusd-infinifi",
    chain: "ethereum",
    contract: "0xDBDC1Ef57537E34680B898E1FEBD3D68c7389bCB",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "usdp-parallel",
    chain: "base",
    contract: "0x472ed57b376fe400259fb28e5c46eb53f0e3e7e7",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "usds-sky",
    chain: "ethereum",
    contract: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "stusds-sky",
    chain: "ethereum",
    contract: "0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "dai-makerdao",
    chain: "ethereum",
    contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "frxusd-frax",
    chain: "ethereum",
    contract: "0xcf62f905562626cfcdd2261162a51fd02fc9c5b6",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "dola-inverse-finance",
    chain: "ethereum",
    contract: "0xb45ad160634c528cc3d2926d9807104fa3157305",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "bold-liquity",
    chain: "ethereum",
    contract: "0x9F4330700a36B29952869fac9b33f45EEdd8A3d8",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "usdf-falcon",
    chain: "ethereum",
    contract: "0xc8cf6d7991f15525488b2a83df53468d682ba4b0",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "usn-noon",
    chain: "ethereum",
    contract: "0xE24a3DC889621612422A64E6388927901608B91D",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "ustb-superstate",
    chain: "ethereum",
    contract: "0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x00000000000000000000000000000000000000000000000000000000000f4240",
  },
  {
    stablecoinId: "thbill-theo",
    chain: "ethereum",
    contract: "0x5FA487BCa6158c64046B2813623e20755091DA0b",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x00000000000000000000000000000000000000000000000000000000000f4240",
  },
];

export const PRICE_DERIVED_FALLBACK_IDS = new Set([
  "usdb-blast",
  "usda-avalon",
  "buck-buck-assets",
]);

export const RATE_DERIVED_CONFIGS: RateDerivedConfig[] = [
  { stablecoinId: "buidl-blackrock", spreadBps: 20, label: "T-bill proxy (net of 0.20% fee)" },
  { stablecoinId: "usyc-hashnote", spreadBps: 50, label: "T-bill proxy (net of 0.50% performance fee)" },
  { stablecoinId: "ylds-figure", spreadBps: 50, label: "T-bill proxy (net of 0.50% fee)" },
  { stablecoinId: "mtbill-midas", spreadBps: 0, label: "T-bill proxy" },
  { stablecoinId: "ousg-ondo-finance", spreadBps: 50, label: "T-bill proxy (net of 0.50% fee)" },
];

/**
 * Known deterministic candidates intentionally excluded from ON_CHAIN_RATE_CONFIGS.
 *
 * These remain yield-bearing assets with other source paths, but are quarantined
 * from the generic ERC-4626 reader until they have protocol-specific adapters:
 * - crvusd-curve: uses a dedicated scrvUSD profit-unlock current-rate reader;
 *   generic 7-day convertToAssets deltas understate Curve's current savings APY
 * - dusd-dtrinity: current convertToAssets probe reverts
 * - reusd-re-protocol: current convertToAssets probe returns empty data
 */
export const QUARANTINED_DETERMINISTIC_ADAPTERS: Record<string, string> = {
  "crvusd-curve":
    "generic 7-day convertToAssets delta understates Curve's scrvUSD current profit-unlock APY; uses dedicated current-rate reader",
  "dusd-dtrinity": "generic convertToAssets probe reverts; requires protocol-specific deterministic reader",
  "reusd-re-protocol": "generic convertToAssets probe returns empty data; requires protocol-specific deterministic reader",
};

export const DIRECT_PROTOCOL_API_STRATEGIES: Record<string, string> = {
  "crvusd-curve": "Curve scrvUSD current-rate reader",
  "lusd-liquity": "B.Protocol LQTY-only",
  "usbd-bima": "BIMA savings",
  "usyc-hashnote": "Hashnote NAV feed",
  "usdy-ondo-finance": "Ondo USDY oracle",
};

export const INTENTIONAL_GAP_REASONS: Record<string, string> = {
  "bd-basedollar": "pre-launch asset with no reliable runtime yield source yet",
  "pusd-polaris": "pre-launch asset with no reliable runtime yield source yet",
  "stkgho-umbrella-aave": "Umbrella rewards are external emissions over a 1:1 GHO staking receipt; no reliable APY source is wired yet",
  "trusd-tori": "pre-launch asset with no reliable runtime yield source yet",
  "usg-tangent": "pre-launch asset with no reliable runtime yield source yet",
};
