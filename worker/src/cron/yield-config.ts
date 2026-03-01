// worker/src/cron/yield-config.ts
// Static configuration for the yield intelligence pipeline.

/** Yield variant: maps a tracked Pharos coin to its untracked yield wrapper. */
export interface YieldVariant {
  variantSymbol: string;
  variantAddress?: string;
  variantChain?: string;
}

/**
 * Coins whose yield comes from a SEPARATE wrapper token that Pharos does not track.
 * Used for DL pool matching (search variantSymbol) and on-chain rate queries.
 * Coins NOT here are their own yield token (e.g., USDY, OUSD, BUIDL).
 */
export const YIELD_VARIANT_MAP: Record<string, YieldVariant> = {
  // USDe -> sUSDe (Ethena staked wrapper)
  "146": {
    variantSymbol: "sUSDe",
    variantAddress: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
    variantChain: "ethereum",
  },
  // reUSD -> stUSR (Resolv staked wrapper)
  "339": {
    variantSymbol: "stUSR",
    variantAddress: "0x1202f5c7B4b9E47a1A9837B26881B7C20112BD51",
    variantChain: "ethereum",
  },
  // AZND -> loAZND (Mu Digital locked/staking wrapper)
  "327": {
    variantSymbol: "loAZND",
    variantChain: "monad",
  },
};

/**
 * Maps Pharos stablecoin ID -> DeFiLlama pool UUID for deterministic yield matching.
 * GATE: 12/15 coins matched (threshold: >=10/15).
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
  "146": "66985a81-9c51-46ca-9977-42b4fe7bc6df",

  // USYC - ondo-yield-assets (listed as USDYC), Ethereum, $602M TVL, ~3.6% APY
  "237": "ee457473-3b5f-4b53-8c8a-fde6b2e16c8a",

  // USDY - ondo-yield-assets native, Ethereum, $149M TVL, ~3.6% APY
  "129": "ac61ee82-2fe4-4f9b-a9cd-7fb33f598859",

  // BUIDL - no DL pool; Blackrock/Securitize fund not tracked by DL Yields
  "173": "",

  // YLDS - no DL pool; Figure Markets not tracked by DL Yields
  "272": "",

  // reUSD -> stUSR - resolv native staking, Ethereum, $109M TVL, ~0.6% APY
  "339": "0aedb3f6-9298-49de-8bb0-2f611a4df784",

  // TBILL - openeden-tbill native, Ethereum, $27M TVL, ~3.0% APY
  "257": "e140f3b2-0327-46ea-93f5-88b17b0a0a16",

  // YUSD - aegis native, Ethereum, $36M TVL, ~5.7% APY
  "255": "f91b2168-c279-475c-a98a-673220f4fee7",

  // USDB - no native DL pool; Blast native yield is not tracked by DL Yields
  //        (only lending pools like wasabi/orbit-protocol exist with tiny TVL)
  "172": "",

  // AZND -> loAZND - mu-digital native, Monad, $7.4M TVL, ~6.7% APY
  "327": "0a05f2ee-e182-476a-9cdc-2fed86fcd765",

  // OUSD - origin-dollar native, Ethereum, $7M TVL, ~5.4% APY
  "23": "529258ee-9b27-4fcf-a32c-b82abb3fda68",

  // USP - merkl pool, Ethereum, $12M TVL, ~23.5% APY
  "331": "2fb2f840-9be7-4de9-b29a-ea928205c476",

  // syrupUSDC - maple native USDC pool, Ethereum, $3.2B TVL, ~4.6% APY
  //             (syrupUSDC is the yield wrapper for USDC deposits into Maple)
  "cg-syrupusdc": "43641cf5-a92e-416b-bce9-27113d3c0db6",

  // syrupUSDT - maple native USDT pool, Ethereum, $1.4B TVL, ~4.4% APY
  //             (syrupUSDT is the yield wrapper for USDT deposits into Maple)
  "cg-syrupusdt": "8edfdf02-cdbb-43f7-bca6-954e5fe56813",

  // yoUSD - pendle SY yield token, Base, $1.3M TVL, ~8.0% APY
  "cg-yousd": "c7c9e2c5-a3ea-4e6e-80d7-090fd2d604c5",
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
    stablecoinId: "146", // USDe -> sUSDe
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
