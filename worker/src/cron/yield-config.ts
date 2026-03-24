// worker/src/cron/yield-config.ts
// Static configuration for the yield intelligence pipeline.

/** Yield variant: maps a tracked Pharos coin to its untracked yield wrapper. */
export interface YieldVariant {
  variantSymbol: string;
  /** Phase 2: used for on-chain rate queries when expanding Tier 1 coverage. */
  variantAddress?: string;
  /** Phase 2: chain for on-chain rate queries. */
  variantChain?: string;
  /** Label used as yield_source when this wrapper is the source row. */
  yieldSource?: string;
  /** Yield mechanism type for this wrapper. */
  yieldType?: string;
}

/**
 * Coins whose yield comes from a SEPARATE wrapper token that Pharos does not track.
 * Used for DL pool matching (search variantSymbol) and on-chain rate queries.
 * Coins NOT here are their own yield token (e.g., USDY, OUSD, BUIDL).
 */
export const YIELD_VARIANT_MAP: Record<string, YieldVariant> = {
  // USDe -> sUSDe (Ethena staked wrapper)
  "usde-ethena": {
    variantSymbol: "sUSDe",
    variantAddress: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
    variantChain: "ethereum",
  },
  // reUSD -> stUSR (Resolv staked wrapper)
  "reusd-re-protocol": {
    variantSymbol: "stUSR",
    variantAddress: "0x1202f5c7B4b9E47a1A9837B26881B7C20112BD51",
    variantChain: "ethereum",
  },
  // AZND -> loAZND (Mu Digital locked/staking wrapper)
  "aznd-mu-digital": {
    variantSymbol: "loAZND",
    variantChain: "monad",
  },
  // USDS -> sUSDS (Sky Savings Rate wrapper)
  "usds-sky": {
    variantSymbol: "sUSDS",
    variantAddress: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
    variantChain: "ethereum",
  },
  // GHO -> sGHO (Aave Safety Module staking wrapper)
  "gho-aave": {
    variantSymbol: "sGHO",
    variantChain: "ethereum",
  },
  // DAI -> sDAI (Dai Savings Rate wrapper)
  "dai-makerdao": {
    variantSymbol: "sDAI",
    variantAddress: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
    variantChain: "ethereum",
  },
  // crvUSD -> scrvUSD (Curve Savings vault)
  "crvusd-curve": {
    variantSymbol: "scrvUSD",
    variantAddress: "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367",
    variantChain: "ethereum",
  },
  // FRXUSD -> sfrxUSD (Frax Staking wrapper)
  "frxusd-frax": {
    variantSymbol: "sfrxUSD",
    variantAddress: "0xcf62f905562626cfcdd2261162a51fd02fc9c5b6",
    variantChain: "ethereum",
  },
  // DOLA -> sDOLA (Inverse Finance Savings)
  "dola-inverse-finance": {
    variantSymbol: "sDOLA",
    variantAddress: "0xb45ad160634c528cc3d2926d9807104fa3157305",
    variantChain: "ethereum",
  },
  // BOLD -> yBOLD (Yearn vault over Liquity Stability Pool)
  "bold-liquity": {
    variantSymbol: "yBOLD",
    variantAddress: "0x9F4330700a36B29952869fac9b33f45EEdd8A3d8",
    variantChain: "ethereum",
  },
  // USBD -> sUSBD (BIMA savings wrapper)
  "usbd-bima": {
    variantSymbol: "sUSBD",
    yieldSource: "BIMA savings (sUSBD)",
    yieldType: "lending-vault",
  },

  // USD.AI -> sUSDai (savings wrapper, $338M TVL on Stablewatch)
  "usdai-usd-ai": {
    variantSymbol: "sUSDai",
    variantChain: "ethereum",
    yieldSource: "USD.AI savings (sUSDai)",
    yieldType: "lending-vault",
  },
  // Neutrl USD -> sNUSD (savings wrapper, $188M TVL)
  "nusd-neutrl": {
    variantSymbol: "sNUSD",
    variantChain: "ethereum",
    yieldSource: "Neutrl savings (sNUSD)",
    yieldType: "lending-vault",
  },
  // Avalon USDa -> sUSDa (savings wrapper, $162M TVL)
  "usda-avalon": {
    variantSymbol: "sUSDa",
    variantChain: "ethereum",
    yieldSource: "Avalon savings (sUSDa)",
    yieldType: "lending-vault",
  },
  // infiniFi USD -> siUSD (savings wrapper, $157M TVL)
  "iusd-infinifi": {
    variantSymbol: "siUSD",
    variantAddress: "0xDBDC1Ef57537E34680B898E1FEBD3D68c7389bCB",
    variantChain: "ethereum",
    yieldSource: "infiniFi savings (siUSD)",
    yieldType: "lending-vault",
  },
  // Falcon USD -> sUSDf (savings wrapper, $87M TVL)
  "usdf-falcon": {
    variantSymbol: "sUSDf",
    variantAddress: "0xc8cf6d7991f15525488b2a83df53468d682ba4b0",
    variantChain: "ethereum",
    yieldSource: "Falcon Finance savings (sUSDf)",
    yieldType: "lending-vault",
  },
  // Avant USD -> savUSD (savings wrapper, $86M TVL)
  "avusd-avant": {
    variantSymbol: "savUSD",
    variantChain: "ethereum",
    yieldSource: "Avant savings (savUSD)",
    yieldType: "lending-vault",
  },
  // Unitas -> sUSDu (savings wrapper, $64M TVL — governance-set rate)
  "usdu-unitas": {
    variantSymbol: "sUSDu",
    variantChain: "solana",
    yieldSource: "Unitas savings (sUSDu)",
    yieldType: "governance-set",
  },
  // Yuzu USD -> syzUSD (savings wrapper, $56M TVL)
  "yzusd-yuzu": {
    variantSymbol: "syzUSD",
    variantChain: "ethereum",
    yieldSource: "Yuzu savings (syzUSD)",
    yieldType: "lending-vault",
  },
  // fxUSD -> fxSAVE (savings wrapper, $31M TVL — second source alongside Stability Pool)
  "fxusd-f-x-protocol": {
    variantSymbol: "fxSAVE",
    variantChain: "ethereum",
    yieldSource: "f(x) Protocol Savings (fxSAVE)",
    yieldType: "lending-vault",
  },
  // Noon USN -> sUSN (savings wrapper, $24M TVL — governance-set rate)
  "usn-noon": {
    variantSymbol: "sUSN",
    variantAddress: "0xE24a3DC889621612422A64E6388927901608B91D",
    variantChain: "ethereum",
    yieldSource: "Noon savings (sUSN)",
    yieldType: "governance-set",
  },
  // Main Street USD -> msY (savings wrapper, $23M TVL)
  "msusd-main-street": {
    variantSymbol: "msY",
    variantChain: "ethereum",
    yieldSource: "Main Street savings (msY)",
    yieldType: "lending-vault",
  },
  // GAIB AID -> sAID (savings wrapper, $15M TVL)
  "aid-gaib": {
    variantSymbol: "sAID",
    variantChain: "ethereum",
    yieldSource: "GAIB savings (sAID)",
    yieldType: "lending-vault",
  },
  // dUSD -> sdUSD (dTRINITY dStake ERC-4626 vault)
  "dusd-dtrinity": {
    variantSymbol: "sdUSD",
    variantAddress: "0x4aCBcFa29fb085097c5f31783403EF7A7930F6Fe",
    variantChain: "ethereum",
    yieldSource: "dTRINITY dStake (sdUSD)",
    yieldType: "lending-vault",
  },
  // USDp -> sUSDp (Parallel Savings ERC-4626 vault — captures 70% of Parallelizer/bridge/flashloan fees)
  "usdp-parallel": {
    variantSymbol: "sUSDp",
    variantAddress: "0x472ed57b376fe400259fb28e5c46eb53f0e3e7e7",
    variantChain: "base",
    yieldSource: "Parallel Savings (sUSDp)",
    yieldType: "governance-set",
  },
};

/**
 * Maps Pharos stablecoin ID -> DeFiLlama pool UUID for deterministic yield matching.
 * Entries below are curated; count grows as new yield-bearing coins are added.
 * Commented-out IDs = no DL pool found (comment explains why).
 *
 * Selection criteria for each coin:
 *   - Prefer the NATIVE/protocol pool (e.g., ethena-usde for sUSDe, ondo-yield-assets for USDY)
 *   - Prefer single-exposure pools over multi-exposure (LP pairs)
 *   - Prefer highest-TVL pool on the primary chain (usually Ethereum)
 *   - For yield-wrapper coins, use the wrapper's native staking pool
 */
export const YIELD_POOL_MAP: Record<string, string> = {
  // USDe (sUSDe) - ethena-usde native staking, Ethereum, $3.5B TVL, ~3.6% APY
  "usde-ethena": "66985a81-9c51-46ca-9977-42b4fe7bc6df",

  // USYC - ondo-yield-assets (listed as USDYC), Ethereum, $602M TVL, ~3.6% APY
  "usyc-hashnote": "ee457473-3b5f-4b53-8c8a-fde6b2e16c8a",

  // USDY - ondo-yield-assets native, Ethereum, $149M TVL, ~3.6% APY
  "usdy-ondo-finance": "ac61ee82-2fe4-4f9b-a9cd-7fb33f598859",

  // BUIDL (173) - no DL pool; Blackrock/Securitize fund not tracked by DL Yields
  // YLDS (272) - no DL pool; Figure Markets not tracked by DL Yields

  // reUSD -> stUSR - resolv native staking, Ethereum, $109M TVL, ~0.6% APY
  "reusd-re-protocol": "0aedb3f6-9298-49de-8bb0-2f611a4df784",

  // TBILL - openeden-tbill native, Ethereum, $27M TVL, ~3.0% APY
  "tbill-openeden": "e140f3b2-0327-46ea-93f5-88b17b0a0a16",

  // YUSD - aegis native, Ethereum, $36M TVL, ~5.7% APY
  "yusd-aegis": "f91b2168-c279-475c-a98a-673220f4fee7",

  // USDB (172) - no native DL pool; Blast native yield is not tracked by DL Yields

  // AZND -> loAZND - mu-digital native, Monad, $7.4M TVL, ~6.7% APY
  "aznd-mu-digital": "0a05f2ee-e182-476a-9cdc-2fed86fcd765",

  // OUSD - origin-dollar native, Ethereum, $7M TVL, ~5.4% APY
  "ousd-origin-protocol": "529258ee-9b27-4fcf-a32c-b82abb3fda68",

  // USP - merkl pool, Ethereum, $12M TVL, ~23.5% APY
  "usp-pikudao": "2fb2f840-9be7-4de9-b29a-ea928205c476",

  // syrupUSDC - maple native USDC pool, Ethereum, $3.2B TVL, ~4.6% APY
  //             (syrupUSDC is the yield wrapper for USDC deposits into Maple)
  "syrupusdc-maple": "43641cf5-a92e-416b-bce9-27113d3c0db6",

  // syrupUSDT - maple native USDT pool, Ethereum, $1.4B TVL, ~4.4% APY
  //             (syrupUSDT is the yield wrapper for USDT deposits into Maple)
  "syrupusdt-maple": "8edfdf02-cdbb-43f7-bca6-954e5fe56813",

  // yoUSD - pendle SY yield token, Base, $1.3M TVL, ~8.0% APY
  "yousd-yield-optimizer": "c7c9e2c5-a3ea-4e6e-80d7-090fd2d604c5",

  // ── Wave 1: Native yield coins (C+ or above) ─────────────────────

  // USDS -> sUSDS - sky-lending, Ethereum, $5.3B TVL, ~4.0% APY
  "usds-sky": "d8c4eff5-c8a9-46fc-a888-057c4c668e72",

  // GHO -> sGHO - aave-v3 staking, Ethereum, $266M TVL, ~5.3% APY
  "gho-aave": "ff2a68af-030c-4697-b0a1-b62a738eaef0",

  // DAI -> sDAI - sdai native, Gnosis, $86M TVL, ~5.5% APY
  "dai-makerdao": "13392973-be6e-4b2f-bce9-4f7dd53d1c3a",

  // crvUSD -> scrvUSD - crvusd native savings, Ethereum, $40M TVL, ~6.7% APY
  "crvusd-curve": "5fd328af-4203-471b-bd16-1705c726d926",

  // FRXUSD -> sfrxUSD - frax native staking, Ethereum, $26M TVL, ~4.3% APY
  "frxusd-frax": "42523cca-14b0-44f6-95fb-4781069520a5",

  // DOLA -> sDOLA - inverse-finance-firm, Ethereum, $14M TVL, ~4.3% APY
  "dola-inverse-finance": "bf0f95c9-bc46-467d-9762-1d80ff50cd74",

  // BOLD -> yBOLD - yearn-finance vault, Ethereum, $4.5M TVL, ~9.8% APY
  "bold-liquity": "4c29f645-12db-461f-a1d7-16900d624271",

  // ZCHF - frankencoin native savings (no wrapper), Ethereum, $7.1M TVL, ~3.8% APY
  "zchf-frankencoin": "8b427366-7bfb-4c61-88be-8dc004fdc3da",

  // fxUSD - fx-protocol Stability Pool, Ethereum, $33.9M TVL, ~4.0% APY
  //         (DL symbol is FXUSDSTABILITYPOOLV2.0, not fxUSD — must use static map)
  "fxusd-f-x-protocol": "abd6c9e1-3b52-459a-a31b-9022a4dcf7e2",

  // ── Stablewatch Wave 1: New wrapper pools ─────────────────────────

  // infiniFi USD -> siUSD - infinifi native savings, Ethereum, $121M TVL, ~4.8% APY
  "iusd-infinifi": "8fa2e60e-365a-41fc-8d50-fadde5041f94",

  // Falcon USD -> sUSDf - falcon-finance native savings, Ethereum, $87M TVL, ~5.9% APY
  "usdf-falcon": "0f67a08c-3f24-4a4b-963e-541f5a5c0364",

  // Unitas -> sUSDu - unitas native savings, Solana, $49M TVL, ~12.9% APY
  "usdu-unitas": "7f980c43-5b87-4690-a11a-b0e8a5e37a63",

  // GAIB AID -> sAID - gaib native savings, Ethereum, $15M TVL, ~11.4% APY
  "aid-gaib": "e575606e-5642-4f87-b9ad-3e53d6f83c82",

  // OUSG - ondo-yield-assets native, Ethereum, $519M TVL, ~3.1% APY
  "ousg-ondo-finance": "7436db9b-2872-46c8-81a2-da6baff902b7",

  // USD.AI -> sUSDai - usd-ai native savings, Arbitrum, $217M TVL, ~7.7% APY
  "usdai-usd-ai": "712ce948-bd9e-4f4a-8916-b72c447f7578",

  // wsrUSD - reservoir-protocol native, Ethereum, $159M TVL, ~4.8% APY
  "wsrusd-reservoir": "d646f32f-d5af-4e34-a29f-8ebeea6a8520",

  // avUSD -> savUSD - merkl HOLD pool, Avalanche, $72M TVL, APY via on-chain rate
  "avusd-avant": "2fe112ff-95a5-4ba0-8ee3-a741e6a8f7c9",

  // Neutrl USD -> sNUSD - pendle PT-buying pool, Ethereum, $41M TVL, ~7.5% APY
  "nusd-neutrl": "0f38d9a4-8e34-4abc-b9ba-25f326ef7828",

  // Main Street USD - mainstreet native pool, Ethereum, $29M TVL, ~12.0% APY
  "msusd-main-street": "8a28570f-2316-488a-94a7-67c87e76c1f1",

  // Yuzu USD -> syzUSD - yuzu-money native savings, Plasma, $28M TVL, ~7.3% APY
  "yzusd-yuzu": "6174b1d6-8212-4964-95bf-ca9c539864ba",

  // Noon USN -> sUSN - morpho-v1 collateral, Ethereum, $10M TVL, APY via on-chain rate
  "usn-noon": "a18a761b-49cd-416d-8342-839cac722094",
};

/** On-chain exchange rate config for Tier 1 vault tokens. */
export interface OnChainRateConfig {
  stablecoinId: string;
  chain: string;
  contract: string;
  /** 4-byte function selector (e.g., "0x07a2d13a" for convertToAssets) */
  selector: string;
  decimals: number;
  /** Hex-encoded input amount (e.g., 1e18 = "0x0de0b6b3a7640000") */
  inputAmount: string;
}

/**
 * Tier 1: On-chain exchange rate sources.
 * These produce the highest-fidelity APY by reading vault exchange rates directly.
 */
export const ON_CHAIN_RATE_CONFIGS: OnChainRateConfig[] = [
  {
    stablecoinId: "usde-ethena", // USDe -> sUSDe
    chain: "ethereum",
    contract: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
    // convertToAssets(uint256) selector
    selector: "0x07a2d13a",
    decimals: 18,
    // 1e18 in hex (zero-padded to 32 bytes)
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "iusd-infinifi", // iUSD — reads siUSD vault exchange rate to derive APY
    chain: "ethereum",
    contract: "0xDBDC1Ef57537E34680B898E1FEBD3D68c7389bCB",
    selector: "0x07a2d13a", // convertToAssets(uint256)
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "usdp-parallel", // USDp — reads sUSDp vault exchange rate on Base to derive APY
    chain: "base",
    contract: "0x472ed57b376fe400259fb28e5c46eb53f0e3e7e7",
    selector: "0x07a2d13a", // convertToAssets(uint256)
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
    stablecoinId: "dai-makerdao",
    chain: "ethereum",
    contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  },
  {
    stablecoinId: "crvusd-curve",
    chain: "ethereum",
    contract: "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367",
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
];

/**
 * Known deterministic candidates intentionally excluded from ON_CHAIN_RATE_CONFIGS.
 *
 * These remain yield-bearing assets with other source paths, but are quarantined
 * from the generic ERC-4626 reader until they have protocol-specific adapters:
 * - dusd-dtrinity: current convertToAssets probe reverts
 * - reusd-re-protocol: current convertToAssets probe returns empty data
 */

/**
 * Deterministic price-derived fallback for yield-bearing coins that have no
 * usable on-chain rate source and no DeFiLlama pool.
 */
export const PRICE_DERIVED_FALLBACK_IDS = new Set([
  "usdb-blast", // USDB - Blast native yield (not tracked in DL Yields)
  "usda-avalon", // USDa - Avalon (no DL protocol pool; sUSDa Pendle pool too small at $55K)
]);

/**
 * Rate-derived yield config for dividend-distributing tokens (rebasing at $1 NAV)
 * and T-bill-backed NAV tokens whose yield mechanically tracks short-term rates.
 *
 * APY = max(0, cachedTbillRate - spreadBps / 100).
 * Uses the risk_free_rate already cached daily by fetch-tbill-rate (FRED DGS3MO).
 */
export interface RateDerivedConfig {
  stablecoinId: string;
  /** Basis points subtracted from the cached T-bill rate (management fee / spread). */
  spreadBps: number;
  /** Human-readable label surfaced as yield_source in yield_data. */
  label: string;
}

export const RATE_DERIVED_CONFIGS: RateDerivedConfig[] = [
  { stablecoinId: "buidl-blackrock", spreadBps: 20, label: "T-bill proxy (net of 0.20% fee)" },
  { stablecoinId: "usyc-hashnote", spreadBps: 50, label: "T-bill proxy (net of 0.50% performance fee)" },
  { stablecoinId: "ylds-figure", spreadBps: 50, label: "T-bill proxy (net of 0.50% fee)" },
  { stablecoinId: "ustb-superstate", spreadBps: 15, label: "T-bill proxy (net of 0.15% fee)" },
  { stablecoinId: "mtbill-midas", spreadBps: 0, label: "T-bill proxy" },
  { stablecoinId: "ousg-ondo-finance", spreadBps: 50, label: "T-bill proxy (net of 0.50% fee)" },
  { stablecoinId: "thbill-theo", spreadBps: 0, label: "T-bill proxy" },
];

/**
 * Curated protocol allowlist for automatic lending pool discovery (Wave 2).
 * Only pools from these protocols are considered for non-yield-bearing coins.
 */
const LENDING_PROTOCOLS = {
  "aave-v3": { label: "Aave v3" },
  "compound-v3": { label: "Compound v3" },
  "sparklend": { label: "SparkLend" },
  "spark-savings": { label: "Spark Savings" },
  "maple": { label: "Maple Finance" },
  "yearn-finance": { label: "Yearn" },
  "compound-v2": { label: "Compound v2" },
  "dolomite": { label: "Dolomite" },
  "fluid-lending": { label: "Fluid" },
  "euler-v2": { label: "Euler v2" },
  "venus-core-pool": { label: "Venus" },
  "kamino-lend": { label: "Kamino" },
  "morpho-v1": { label: "Morpho" },
  "morpho-blue": { label: "Morpho Blue" },
  "pendle": { label: "Pendle" },
  "curve-llamalend": { label: "Curve LlamaLend" },
  "exactly": { label: "Exactly" },
  "flux-finance": { label: "Flux Finance" },
  "gains-network": { label: "Gains Network" },
  "lazy-summer-protocol": { label: "Lazy Summer" },
  "moonwell-lending": { label: "Moonwell" },
  "silo-v2": { label: "Silo v2" },
  "justlend": { label: "JustLend" },
  "openeden-usdo": { label: "OpenEden" },
  "multipli.fi": { label: "Multipli" },
  "jupiter-lend": { label: "Jupiter Lend" },
  "stables-labs-usdx": { label: "Stables Labs" },
  "benqi-lending": { label: "BENQI" },
  "radiant-v2": { label: "Radiant v2" },
  "fraxlend-v2": { label: "Fraxlend" },
  "clearpool": { label: "Clearpool" },
  "centrifuge": { label: "Centrifuge" },
  "sturdy-v2": { label: "Sturdy v2" },
  "goldfinch": { label: "Goldfinch" },
  "truefi": { label: "TrueFi" },
  "lagoon": { label: "Lagoon" },
  "liqwid": { label: "Liqwid" },
  "lista-lending": { label: "Lista Lending" },
  "loopscale": { label: "Loopscale" },
  "more-markets": { label: "More Markets" },
  "navi-lending": { label: "NAVI Lending" },
  "overnight-finance": { label: "Overnight" },
  "smardex-usdn": { label: "SmarDex USDN" },
  "vesper": { label: "Vesper" },
} as const;

export const LENDING_PROTOCOL_ALLOWLIST = new Set(Object.keys(LENDING_PROTOCOLS));

/** Human-readable display names for DeFiLlama lending protocol slugs. */
export const LENDING_PROTOCOL_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(LENDING_PROTOCOLS).map(([slug, config]) => [slug, config.label]),
);

/**
 * Deterministic auto-discovery overrides for non-yield-bearing coins.
 * Maps Pharos stablecoin ID -> DeFiLlama lending pool UUID.
 *
 * Use this when symbol-based matching is ambiguous or prone to misses.
 * Guardrails are still enforced at runtime:
 * - pool must be stablecoin + single exposure
 * - pool project must be allowlisted
 * - pool must satisfy minimum APY and TVL thresholds
 */
export const AUTO_LENDING_POOL_MAP: Record<string, string> = {
  // U (United Stables) - venus-core-pool on BSC, ~$15M TVL, ~2.4% APY
  "u-united-stables": "d8e9bb79-79d3-4897-8a4f-8d489040097d",
  // pUSD - silo-v2 on Sonic, yield-bearing coin with missing report-card row
  "pusd-polaris": "add30093-8fb6-4972-bb6a-a0f3add8bfe8",
  // pmUSD - yearn-finance (symbol drift: PMFRXUSD), Ethereum
  "pmusd-precious-metals": "099fab49-5103-4c85-b5e6-fff734eb1691",
  // USDH - morpho-v1 (symbol drift: FEUSDH), HyperEVM
  "usdh-native-markets": "1c9fb97d-f432-44fb-89a0-8120b4cae95c",
  // EURCV - morpho-v1 (symbol drift: STEAKEURCV), Ethereum
  "eurcv-societe-generale-forge": "d3b28212-a46b-4db8-8bb7-2c946b3cbe76",
  // EUSD - morpho-v1 (symbol drift: MEUSD), Base
  "eusd-electronic-usd": "44a4e84a-4ad1-4783-ac83-3d7e432220ea",
  // USDX - stables-labs-usdx native single-asset market
  "usdx-hex-trust": "e7ac1a5f-f141-4c00-9a5d-2e2c505a800c",
  // USDO - OpenEden native single-asset market
  "usdo-openeden": "f083596e-032d-4d6b-a7a8-1836d3f99bcd",
  // USDM - Liqwid single-asset market on Cardano
  "usdm-moneta": "ce3021c9-af52-46b0-a61a-3e92acdfd79b",
};

/**
 * Deterministic IDs that may bypass MIN_SAFETY_SCORE_FOR_YIELD.
 * Reserved for explicit edge-case inclusions.
 */
export const AUTO_LENDING_SAFETY_BYPASS_IDS = new Set([
  "u-united-stables", // U: explicitly requested inclusion despite D-grade score
  "pusd-polaris", // Yield-bearing coin with missing report-card coverage; vetted Silo market keeps native yield visibility intact.
  "usdx-hex-trust", // Large protocol-native USDX market; keep visible despite D-grade issuer risk.
  "usdo-openeden", // OpenEden's native USDO market remains meaningful despite sub-C safety.
  "usdm-moneta", // Exact single-asset Liqwid market; explicit edge-case inclusion for yield coverage.
]);

export interface YieldAdapterManifestEntry {
  stablecoinId: string;
  variant?: YieldVariant;
  nativePoolId?: string;
  onChainRate?: OnChainRateConfig;
  priceDerivedFallback?: boolean;
  rateDerived?: RateDerivedConfig;
  autoLendingPoolId?: string;
  bypassesAutoLendingSafety?: boolean;
  deterministicQuarantineReason?: string;
}

const QUARANTINED_DETERMINISTIC_ADAPTERS: Record<string, string> = {
  "dusd-dtrinity": "generic convertToAssets probe reverts; requires protocol-specific deterministic reader",
  "reusd-re-protocol": "generic convertToAssets probe returns empty data; requires protocol-specific deterministic reader",
};

export const YIELD_ADAPTER_MANIFEST: YieldAdapterManifestEntry[] = Array.from(new Set([
  ...Object.keys(YIELD_VARIANT_MAP),
  ...Object.keys(YIELD_POOL_MAP),
  ...ON_CHAIN_RATE_CONFIGS.map((config) => config.stablecoinId),
  ...RATE_DERIVED_CONFIGS.map((config) => config.stablecoinId),
  ...PRICE_DERIVED_FALLBACK_IDS,
  ...Object.keys(AUTO_LENDING_POOL_MAP),
  ...Object.keys(QUARANTINED_DETERMINISTIC_ADAPTERS),
])).sort().map((stablecoinId) => ({
  stablecoinId,
  variant: YIELD_VARIANT_MAP[stablecoinId],
  nativePoolId: YIELD_POOL_MAP[stablecoinId],
  onChainRate: ON_CHAIN_RATE_CONFIGS.find((config) => config.stablecoinId === stablecoinId),
  priceDerivedFallback: PRICE_DERIVED_FALLBACK_IDS.has(stablecoinId) || undefined,
  rateDerived: RATE_DERIVED_CONFIGS.find((config) => config.stablecoinId === stablecoinId),
  autoLendingPoolId: AUTO_LENDING_POOL_MAP[stablecoinId],
  bypassesAutoLendingSafety: AUTO_LENDING_SAFETY_BYPASS_IDS.has(stablecoinId) || undefined,
  deterministicQuarantineReason: QUARANTINED_DETERMINISTIC_ADAPTERS[stablecoinId],
}));
