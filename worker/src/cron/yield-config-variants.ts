import type { YieldVariant } from "./yield-config-registry";

export const YIELD_VARIANT_MAP: Record<string, YieldVariant> = {
  // reUSD -> reUSDe (Re Protocol Insurance Alpha junior tranche)
  "reusd-re-protocol": {
    variantSymbol: "reUSDe",
    variantAddress: "0xdDC0f880ff6e4e22E4B74632fBb43Ce4DF6cCC5a",
    variantChain: "ethereum",
    variantProject: "re-protocol",
    yieldSource: "Re Protocol Insurance Alpha (reUSDe)",
    yieldType: "nav-appreciation",
  },
  // AZND -> loAZND (Mu Digital locked/staking wrapper)
  "aznd-mu-digital": {
    variantSymbol: "loAZND",
    variantAddress: "0x9c82eB49B51F7Dc61e22Ff347931CA32aDc6cd90",
    variantChain: "monad",
    yieldSource: "Mu Digital loAZND vault",
    yieldType: "lending-vault",
  },
  // BOLD -> yBOLD (Yearn vault over Liquity Stability Pool)
  "bold-liquity": {
    variantSymbol: "yBOLD",
    variantAddress: "0x9F4330700a36B29952869fac9b33f45EEdd8A3d8",
    variantChain: "ethereum",
    yieldSource: "Liquity Stability Pool (via Yearn yBOLD)",
    yieldType: "lending-vault",
  },
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
  // Falcon USD -> sUSDf (savings wrapper, $87M TVL)
  "usdf-falcon": {
    variantSymbol: "sUSDf",
    variantAddress: "0xc8cf6d7991f15525488b2a83df53468d682ba4b0",
    variantChain: "ethereum",
    yieldSource: "Falcon Finance savings (sUSDf)",
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
  // USDat -> sUSDat (Saturn staking ERC-4626 vault — STRC + Treasuries dynamic mix, target ~11% APY)
  "usdat-saturn": {
    variantSymbol: "sUSDat",
    variantAddress: "0xd166337499e176bbc38a1fbd113ab144e5bd2df7",
    variantChain: "ethereum",
    yieldSource: "Saturn staking (sUSDat)",
    yieldType: "nav-appreciation",
  },
};
