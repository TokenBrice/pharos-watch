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
    variantChain: "ethereum",
  },
  // crvUSD -> scrvUSD (Curve Savings vault)
  "crvusd-curve": {
    variantSymbol: "scrvUSD",
    variantChain: "ethereum",
  },
  // FRXUSD -> sfrxUSD (Frax Staking wrapper)
  "frxusd-frax": {
    variantSymbol: "sfrxUSD",
    variantChain: "ethereum",
  },
  // DOLA -> sDOLA (Inverse Finance Savings)
  "dola-inverse-finance": {
    variantSymbol: "sDOLA",
    variantChain: "ethereum",
  },
  // BOLD -> yBOLD (Yearn vault over Liquity Stability Pool)
  "bold-liquity": {
    variantSymbol: "yBOLD",
    variantChain: "ethereum",
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
    variantChain: "ethereum",
    yieldSource: "infiniFi savings (siUSD)",
    yieldType: "lending-vault",
  },
  // Falcon USD -> sUSDf (savings wrapper, $87M TVL)
  "usdf-falcon": {
    variantSymbol: "sUSDf",
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
};

/**
 * Maps Pharos stablecoin ID -> DeFiLlama pool UUID for deterministic yield matching.
 * GATE: 21/24 coins matched (threshold: >=15/24).
 * Empty string = no DL pool found (comment explains why).
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
];

/**
 * Deterministic price-derived fallback for yield-bearing coins that have no
 * usable on-chain rate source and no DeFiLlama pool.
 */
export const PRICE_DERIVED_FALLBACK_IDS = new Set([
  "buidl-blackrock", // BUIDL - BlackRock/Securitize fund (not tracked in DL Yields)
]);

/**
 * Curated protocol allowlist for automatic lending pool discovery (Wave 2).
 * Only pools from these protocols are considered for non-yield-bearing coins.
 *
 * Tier 1 (battle-tested, $1B+ historical TVL):
 *   aave-v3, compound-v3, sparklend, spark-savings, maple, yearn-finance
 *
 * Tier 2 (established, well-audited):
 *   fluid-lending, euler-v2, venus-core-pool, kamino-lend, morpho-v1, pendle
 *
 * Tier 3 (targeted additions to expand coverage):
 *   justlend, openeden-usdo, multipli.fi, jupiter-lend, stables-labs-usdx
 */
export const LENDING_PROTOCOL_ALLOWLIST = new Set([
  // Tier 1
  "aave-v3",
  "compound-v3",
  "sparklend",
  "spark-savings",
  "maple",
  "yearn-finance",
  // Tier 2
  "fluid-lending",
  "euler-v2",
  "venus-core-pool",
  "kamino-lend",
  "morpho-v1",
  "pendle",
  // Tier 3
  "justlend",
  "openeden-usdo",
  "multipli.fi",
  "jupiter-lend",
  "stables-labs-usdx",
]);

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
  // pmUSD - yearn-finance (symbol drift: PMFRXUSD), Ethereum
  "pmusd-precious-metals": "099fab49-5103-4c85-b5e6-fff734eb1691",
  // USDH - morpho-v1 (symbol drift: FEUSDH), HyperEVM
  "usdh-native-markets": "1c9fb97d-f432-44fb-89a0-8120b4cae95c",
  // EURCV - morpho-v1 (symbol drift: STEAKEURCV), Ethereum
  "eurcv-societe-generale-forge": "d3b28212-a46b-4db8-8bb7-2c946b3cbe76",
  // EUSD - morpho-v1 (symbol drift: MEUSD), Base
  "eusd-electronic-usd": "44a4e84a-4ad1-4783-ac83-3d7e432220ea",
};

/**
 * Deterministic IDs that may bypass MIN_SAFETY_SCORE_FOR_YIELD.
 * Reserved for explicit edge-case inclusions.
 */
export const AUTO_LENDING_SAFETY_BYPASS_IDS = new Set([
  "u-united-stables", // U: explicitly requested inclusion despite D-grade score
]);
