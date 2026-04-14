import type { YieldVariant } from "./yield-config-registry";

export const YIELD_VARIANT_MAP: Record<string, YieldVariant> = {
  // USDe -> sUSDe (Ethena staked wrapper)
  "usde-ethena": {
    variantSymbol: "sUSDe",
    variantAddress: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
    variantChain: "ethereum",
    variantProject: "ethena-usde",
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
    variantProject: "sky-lending",
  },
  // GHO -> sGHO (Aave Safety Module staking wrapper)
  "gho-aave": {
    variantSymbol: "sGHO",
    variantChain: "ethereum",
    variantAddress: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f",
    variantProject: "aave-v3",
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
  // Avant USD -> savUSD (savings wrapper, $86M TVL)
  "avusd-avant": {
    variantSymbol: "savUSD",
    variantAddress: "0x24dE8771bC5DdB3362Db529Fc3358F2df3A0E346",
    variantChain: "avalanche",
    yieldSource: "Avant savings (savUSD)",
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
    variantAddress: "0x18F52B3fb465118731d9e0d276d4Eb3599D57596",
    variantChain: "ethereum",
    variantProject: "gaib",
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
  // cUSD -> stCUSD (Cap staked savings wrapper, ~$68M TVL, ~4.6% APY)
  "cusd-cap": {
    variantSymbol: "stCUSD",
    variantAddress: "0xcCcc62962d17b8914c62D74FfB843d73B2a3cccC",
    variantChain: "ethereum",
    variantProject: "cap",
    yieldSource: "Cap savings (stCUSD)",
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
