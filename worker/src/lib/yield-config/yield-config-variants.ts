import type { YieldVariant } from "./yield-config-registry";

export const YIELD_VARIANT_MAP: Record<string, YieldVariant> = {
  // USBD -> sUSBD (BIMA savings wrapper)
  "usbd-bima": {
    variantSymbol: "sUSBD",
    yieldSource: "BIMA savings (sUSBD)",
    yieldType: "lending-vault",
  },
  // Neutrl USD -> sNUSD (savings wrapper, $188M TVL)
  "nusd-neutrl": {
    variantSymbol: "sNUSD",
    variantAddress: "0x08EFCC2F3e61185D0EA7F8830B3FEc9Bfa2EE313",
    variantChain: "ethereum",
    variantProject: "pendle",
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
  // Unitas -> sUSDu (savings wrapper, $64M TVL — governance-set rate)
  "usdu-unitas": {
    variantSymbol: "sUSDu",
    variantAddress: "9ckR7pPPvyPadACDTzLwK2ZAEeUJ3qGSnzPs8bVaHrSy",
    variantChain: "solana",
    variantProject: "unitas",
    yieldSource: "Unitas savings (sUSDu)",
    yieldType: "governance-set",
  },
  // Yuzu USD -> syzUSD (savings wrapper, $56M TVL)
  "yzusd-yuzu": {
    variantSymbol: "syzUSD",
    variantAddress: "0x6695c0f8706c5ace3bdf8995073179cca47926dc",
    variantChain: "plasma",
    variantProject: "yuzu-money",
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
  // ftUSD -> sftUSD (Flying Tulip EpochRewardsVault — delta-neutral carry yield)
  "ftusd-flying-tulip": {
    variantSymbol: "sftUSD",
    variantAddress: "0xeb48218a4c35C814C7678cBcae88C6Ee037F7625",
    variantChain: "ethereum",
    yieldSource: "Flying Tulip staking (sftUSD)",
    yieldType: "fee-sharing",
  },
  // USDh -> sUSDh (Hermetica staking wrapper — BTC funding rate yield)
  "usdh-hermetica": {
    variantSymbol: "sUSDh",
    variantChain: "stacks",
    yieldSource: "Hermetica staking (sUSDh)",
    yieldType: "lending-vault",
  },
  // thUSD -> sthUSD (Theo staking ERC-4626 vault — delta-neutral gold carry yield)
  "thusd-theo": {
    variantSymbol: "sthUSD",
    variantAddress: "0xa808bc9775cb41c52c7842f8b50427fe7a770326",
    variantChain: "ethereum",
    yieldSource: "Theo staking (sthUSD)",
    yieldType: "nav-appreciation",
  },
};
