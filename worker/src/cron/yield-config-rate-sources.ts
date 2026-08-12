import type { YieldAdapterLifecycleReason } from "@shared/types/yield";
import {
  type OnChainRateConfig,
  type RateDerivedConfig,
  type YieldAdapterLifecycleEntry,
} from "./yield-config-registry";
import { buildOnChainSourceKey } from "../lib/yield-utils";

/**
 * Tier 1: On-chain exchange rate sources.
 * These produce the highest-fidelity APY by reading vault exchange rates directly.
 */
export const ON_CHAIN_RATE_CONFIGS: OnChainRateConfig[] = [
  {
    stablecoinId: "susde-ethena",
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
    stablecoinId: "susds-sky",
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
    stablecoinId: "sdai-sky",
    chain: "ethereum",
    contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "sfrxusd-frax",
    chain: "ethereum",
    contract: "0xcf62f905562626cfcdd2261162a51fd02fc9c5b6",
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
    stablecoinId: "susn-noon",
    chain: "ethereum",
    contract: "0xE24a3DC889621612422A64E6388927901608B91D",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
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
  {
    stablecoinId: "susdc-spark",
    chain: "ethereum",
    contract: "0x28b3a8fb53b741a8fd78c0fb9a6b2393d896a43d",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x00000000000000000000000000000000000000000000000000000000000f4240",
  },
  {
    stablecoinId: "susdt-spark",
    chain: "ethereum",
    contract: "0xe2e7a17dff93280dec073c995595155283e3c372",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x00000000000000000000000000000000000000000000000000000000000f4240",
  },
  {
    stablecoinId: "syrupusdc-maple",
    chain: "ethereum",
    contract: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x00000000000000000000000000000000000000000000000000000000000f4240",
  },
  {
    stablecoinId: "syrupusdt-maple",
    chain: "ethereum",
    contract: "0x356b8d89c1e1239cbbb9de4815c39a1474d5ba7d",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x00000000000000000000000000000000000000000000000000000000000f4240",
  },
  {
    stablecoinId: "yvusdc-yearn",
    chain: "ethereum",
    contract: "0xbe53a109b494e5c9f97b9cd39fe969be68bf6204",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x00000000000000000000000000000000000000000000000000000000000f4240",
  },
  {
    stablecoinId: "gtusdc-gauntlet",
    chain: "ethereum",
    contract: "0xdd0f28e19c1780eb6396170735d45153d261490d",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "bbqusdc-steakhouse",
    chain: "ethereum",
    contract: "0xbeefff209270748ddd194831b3fa287a5386f5bc",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "sgho-aave",
    chain: "ethereum",
    contract: "0xe1753f2e00940cc31213dd92013cf019dfe4ca1d",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "wsrusd-reservoir",
    chain: "ethereum",
    contract: "0xd3fd63209fa2d55b07a0f6db36c2f43900be3094",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "stcusd-cap",
    chain: "ethereum",
    contract: "0x88887be419578051ff9f4eb6c858a951921d8888",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "savusd-avant",
    chain: "avalanche",
    contract: "0x06d47f3fb376649c3a9dafe069b3d6e35572219e",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "yousd-yield-optimizer",
    chain: "base",
    contract: "0x0000000f2eb9f69274678c76222b35eec7588a65",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x00000000000000000000000000000000000000000000000000000000000f4240",
  },
];

export const PRICE_DERIVED_FALLBACK_IDS = new Set([
  "usdb-blast",
  "usda-avalon",
]);

export const RATE_DERIVED_CONFIGS: RateDerivedConfig[] = [
  { stablecoinId: "buidl-blackrock", spreadBps: 20, label: "T-bill proxy (net of 0.20% fee)", benchmarkOverrideKey: "USD_EFFR" },
  { stablecoinId: "cgusd-cygnus-finance", spreadBps: 35, label: "T-bill proxy (net of 0.35% protocol fee)", benchmarkOverrideKey: "USD_EFFR" },
  { stablecoinId: "ylds-figure", spreadBps: 50, label: "T-bill proxy (net of 0.50% fee)", benchmarkOverrideKey: "USD_EFFR" },
  { stablecoinId: "mtbill-midas", spreadBps: 0, label: "T-bill proxy", benchmarkOverrideKey: "USD_EFFR" },
  { stablecoinId: "usdn-noble", spreadBps: 0, label: "M0 T-bill rebase proxy", benchmarkOverrideKey: "USD_EFFR" },
  { stablecoinId: "ousg-ondo-finance", spreadBps: 50, label: "T-bill proxy (net of 0.50% fee)", benchmarkOverrideKey: "USD_EFFR" },
  { stablecoinId: "susd-solayer", spreadBps: 0, label: "T-bill proxy", benchmarkOverrideKey: "USD_EFFR" },
  { stablecoinId: "benji-franklin-templeton", spreadBps: 20, label: "T-bill proxy (net of 0.20% fee)", benchmarkOverrideKey: "USD_EFFR" },
  { stablecoinId: "wtgxx-wisdomtree", spreadBps: 25, label: "T-bill proxy (net of 0.25% fee)", benchmarkOverrideKey: "USD_EFFR" },
  { stablecoinId: "ustbl-spiko", spreadBps: 10, label: "T-bill proxy (net of 0.10% fee)", benchmarkOverrideKey: "USD_EFFR" },
  { stablecoinId: "eutbl-spiko", spreadBps: 15, label: "EUR T-bill proxy (net of 0.15% fee)", benchmarkCurrency: "EUR", benchmarkOverrideKey: "EUR" },
  { stablecoinId: "uktbl-spiko", spreadBps: 15, label: "GBP T-bill proxy (net of 0.15% fee)", benchmarkCurrency: "GBP", benchmarkOverrideKey: "GBP" },
  { stablecoinId: "eursafo-spiko", spreadBps: 0, label: "Amundi Smart Cash overnight swap proxy (EUR)", benchmarkCurrency: "EUR" },
  { stablecoinId: "gbpsafo-spiko", spreadBps: 0, label: "Amundi Smart Cash overnight swap proxy (GBP)", benchmarkCurrency: "GBP" },
  { stablecoinId: "eurspkcc-spiko", spreadBps: 0, label: "Cash-and-carry strategy proxy (EUR risk-free leg)", benchmarkCurrency: "EUR" },
  { stablecoinId: "fusd-finchain", spreadBps: 0, label: "Tokenized T-bill/MMF reserve-yield proxy", benchmarkOverrideKey: "USD_EFFR" },
  { stablecoinId: "safo-spiko-usd", spreadBps: 0, label: "Amundi Smart Cash overnight swap proxy (USD)" },
  { stablecoinId: "spkcc-spiko", spreadBps: 0, label: "Cash-and-carry strategy proxy (USD risk-free leg)" },
  { stablecoinId: "usdgo-osl", spreadBps: 38, label: "EFFR-linked reserve-yield proxy (net of 0.38% fee)", benchmarkCurrency: "USD_EFFR", benchmarkOverrideKey: "USD_EFFR" },
  { stablecoinId: "witry-brix", spreadBps: 0, label: "BIST TLREF overnight proxy (TRY)", benchmarkCurrency: "TRY" },
  { stablecoinId: "a7a5-old-vector", spreadBps: 100, label: "CBR key-rate reserve-yield proxy (net of 1.00pp)", benchmarkCurrency: "RUB", benchmarkOverrideKey: "RUB" },
];

/**
 * Known deterministic candidates intentionally excluded from ON_CHAIN_RATE_CONFIGS.
 *
 * These remain yield-bearing assets with other source paths, but are quarantined
 * from the generic ERC-4626 reader until they have protocol-specific adapters:
 * - scrvusd-curve: uses a dedicated scrvUSD profit-unlock current-rate reader;
 *   generic 7-day convertToAssets deltas understate Curve's current savings APY
 * - ustb-superstate: the tracked USTB token is not an ERC-4626 vault
 */
const QUARANTINED_DETERMINISTIC_ADAPTERS_TYPED: Record<string, YieldAdapterLifecycleReason> = {
  "scrvusd-curve": {
    code: "wrapper-not-yet-supported",
    since: "2026-04-11",
    nextReviewAt: "2026-10-09",
    note: "2026-07-09 review: keep quarantined because the dedicated current-rate reader remains canonical; generic 7-day convertToAssets delta understates Curve's scrvUSD current profit-unlock APY",
  },
  "ustb-superstate": {
    code: "token-not-erc4626",
    since: "2026-07-15",
    nextReviewAt: "2026-10-15",
    note: "The tracked USTB token does not implement ERC-4626 convertToAssets; keep the generic reader disabled until a dedicated Superstate NAV-oracle adapter is implemented",
  },
};

export const QUARANTINED_DETERMINISTIC_PROBE_CONFIGS: OnChainRateConfig[] = [];

/**
 * Legacy free-form rationale map kept for backward compatibility with
 * `deriveYieldRegistry` and existing manifest `rationale` fields. New code
 * should consume `QUARANTINED_DETERMINISTIC_ADAPTERS_TYPED` (or the typed
 * `YIELD_ADAPTER_LIFECYCLE` registry exported from yield-config-registry).
 */
export const QUARANTINED_DETERMINISTIC_ADAPTERS: Record<string, string> = Object.fromEntries(
  Object.entries(QUARANTINED_DETERMINISTIC_ADAPTERS_TYPED).map(([id, reason]) => [id, reason.note ?? reason.code]),
);

export const DIRECT_PROTOCOL_API_STRATEGIES: Record<string, string> = {
  "scrvusd-curve": "Curve scrvUSD current-rate reader",
  "lusd-liquity": "B.Protocol LQTY-only",
  "usbd-bima": "BIMA savings",
  "cetes-etherfuse": "Etherfuse CETES current issuance",
  "usyc-hashnote": "Hashnote NAV feed",
  "mmev-midas": "Midas mMEV NAV oracle",
  "usdy-ondo-finance": "Ondo USDY oracle",
  "reusd-re-protocol": "Re Protocol Basis-Plus (reUSD)",
  "zys-zephyr-protocol": "Zephyr Scanner ZYS returns",
};

export const DIRECT_PROTOCOL_API_SOURCE_KEYS: Record<string, string> = {
  "scrvusd-curve": "onchain:scrvusd-curve:scrvusd-current-rate",
  "lusd-liquity": buildOnChainSourceKey("lusd-liquity"),
  "usbd-bima": "protocol-api:bima-susbd",
  "cetes-etherfuse": "protocol-api:etherfuse-cetes-current-issuance",
  "usyc-hashnote": "protocol-api:hashnote-usyc",
  "mmev-midas": "protocol-api:midas-mmev-nav-oracle",
  "usdy-ondo-finance": "protocol-api:ondo-usdy-oracle",
  "reusd-re-protocol": "protocol-api:re-protocol-reusd",
  "zys-zephyr-protocol": "protocol-api:zys-zephyr-protocol",
};

const INTENTIONAL_GAP_REASONS_TYPED: Record<string, YieldAdapterLifecycleReason> = {
  "bfusd-binance": {
    code: "off-chain-account-product",
    since: "2026-04-14",
    nextReviewAt: "2026-10-09",
    note: "2026-07-09 review: keep intentional gap for off-chain Binance account yield product; no public runtime APY feed is wired or confirmed for holder-rate resolution",
  },
  "bd-basedollar": {
    code: "no-public-yield-source",
    since: "2026-04-03",
    note: "asset with no reliable runtime yield source yet",
  },
  "brd-volpon": {
    code: "pre-launch",
    since: "2026-04-14",
    note: "pre-launch yield-bearing BRL asset with no reliable runtime yield source yet",
  },
  "dusd-standx": {
    code: "no-public-yield-source",
    since: "2026-06-23",
    nextReviewAt: "2026-09-12",
    note: "2026-08-12 review: official StandX docs still describe seven-day holder reward cycles and revenue sources, but the documented public Perps API exposes market/funding data rather than a current holder APY; keep the intentional gap pending a stable machine-readable rate contract",
  },
  "gldy-streamex": {
    code: "issuer-distributed-yield",
    since: "2026-04-14",
    nextReviewAt: "2026-10-09",
    note: "2026-07-09 review: keep intentional gap for issuer-distributed gold leasing yield; no public runtime APY feed is wired or confirmed for holder-rate resolution",
  },
  "gynusd-gyndore": {
    code: "pre-launch",
    since: "2026-05-19",
    note: "pre-launch stability-pool yield with no reliable runtime APY source yet",
  },
  "hbd-hive": {
    code: "source-family-adapter-unimplemented",
    since: "2026-06-21",
    nextReviewAt: "2026-09-12",
    note: "2026-08-12 review: the official Hive RPC exposes the protocol-set hbd_interest_rate through dynamic global properties, but Pharos has no reviewed Hive savings-rate adapter or freshness contract yet; keep uncovered until that reusable reader is implemented",
  },
  "home-homecoin": {
    code: "issuer-distributed-yield",
    since: "2026-05-22",
    nextReviewAt: "2026-10-09",
    note: "2026-07-09 review: keep intentional gap for issuer-distributed home-loan payment yield; no public runtime APY feed is wired or confirmed for holder-rate resolution",
  },
  "gusd-gate": {
    code: "off-chain-account-product",
    since: "2026-04-14",
    nextReviewAt: "2026-10-09",
    note: "2026-07-09 review: keep intentional gap for Gate account-product yield; no public runtime APY feed is wired or confirmed for holder-rate resolution",
  },
  "pc0000031-tradable": {
    code: "private-credit-note",
    since: "2026-04-14",
    nextReviewAt: "2026-10-09",
    note: "2026-07-09 review: keep intentional gap for reviewed Tradable private-credit note; no public runtime APY feed is wired or confirmed for holder-rate resolution",
  },
  "pc0000033-tradable": {
    code: "private-credit-note",
    since: "2026-04-14",
    nextReviewAt: "2026-10-09",
    note: "2026-07-09 review: keep intentional gap for reviewed Tradable private-credit note; no public runtime APY feed is wired or confirmed for holder-rate resolution",
  },
  "pc0000089-tradable": {
    code: "private-credit-note",
    since: "2026-04-14",
    nextReviewAt: "2026-10-09",
    note: "2026-07-09 review: keep intentional gap for reviewed Tradable private-credit note; no public runtime APY feed is wired or confirmed for holder-rate resolution",
  },
  "pc0000101-tradable": {
    code: "private-credit-note",
    since: "2026-04-14",
    nextReviewAt: "2026-10-09",
    note: "2026-07-09 review: keep intentional gap for reviewed Tradable private-credit note; no public runtime APY feed is wired or confirmed for holder-rate resolution",
  },
  "pusd-polaris": {
    code: "no-public-yield-source",
    since: "2026-04-14",
    note: "asset with no reliable runtime yield source yet",
  },
  "stkgho-umbrella-aave": {
    code: "external-emissions-only",
    since: "2026-04-14",
    nextReviewAt: "2026-09-12",
    note: "2026-08-12 review: current Aave Umbrella docs confirm dynamic on-chain rewards plus slashing/cooldown exposure, but Pharos still lacks an emissions-aware adapter that combines every reward stream with the holder-risk contract; keep the intentional gap until that reader is scoped",
  },
  "trusd-tori": {
    code: "pre-launch",
    since: "2026-04-14",
    note: "pre-launch asset with no reliable runtime yield source yet",
  },
};

/**
 * Legacy free-form rationale map kept for backward compatibility with
 * `deriveYieldRegistry` and existing manifest `rationale` fields.
 */
export const INTENTIONAL_GAP_REASONS: Record<string, string> = Object.fromEntries(
  Object.entries(INTENTIONAL_GAP_REASONS_TYPED).map(([id, reason]) => [id, reason.note ?? reason.code]),
);

/**
 * Typed lifecycle entries derived from the two typed reason maps above, so the
 * registry derivation, coverage audit, manifest endpoint, and any future admin
 * UI read the same source of truth without re-deriving from the legacy strings.
 *
 * Built eagerly as a plain const: `deriveYieldRegistry` takes it as a parameter,
 * so there is no import-order hazard between this module and the registry.
 */
export const YIELD_ADAPTER_LIFECYCLE: Record<string, YieldAdapterLifecycleEntry> = {
  ...Object.fromEntries(
    Object.entries(QUARANTINED_DETERMINISTIC_ADAPTERS_TYPED).map(
      ([id, reason]) => [id, { lifecycle: "quarantined", reason }] as const,
    ),
  ),
  ...Object.fromEntries(
    Object.entries(INTENTIONAL_GAP_REASONS_TYPED).map(
      ([id, reason]) => [id, { lifecycle: "intentional-gap", reason }] as const,
    ),
  ),
};
