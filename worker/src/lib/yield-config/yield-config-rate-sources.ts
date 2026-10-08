import type { YieldAdapterLifecycleReason } from "@shared/types/yield";
import {
  type OnChainRateConfig,
  type RateDerivedConfig,
  type YieldAdapterLifecycleEntry,
} from "./yield-config-registry";
import { buildOnChainSourceKey } from "../yield-utils";

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
    // ERC-4626 over USDS; no pinned DL pool — measure totalAssets as venue TVL.
    tvlRead: { kind: "erc4626-total-assets", decimals: 18 },
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
    stablecoinId: "susdf-falcon",
    chain: "ethereum",
    contract: "0xc8cf6d7991f15525488b2a83df53468d682ba4b0",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 18 },
  },
  {
    stablecoinId: "susn-noon",
    chain: "ethereum",
    contract: "0xE24a3DC889621612422A64E6388927901608B91D",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    // ERC-4626 over USN (USD-pegged); no dedicated native DL pool pin.
    tvlRead: { kind: "erc4626-total-assets", decimals: 18 },
  },
  {
    stablecoinId: "thbill-theo",
    chain: "ethereum",
    contract: "0x5FA487BCa6158c64046B2813623e20755091DA0b",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x00000000000000000000000000000000000000000000000000000000000f4240",
    // ERC-4626 over USD T-bill exposure; no pinned DL pool.
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "thusd-theo",
    chain: "ethereum",
    contract: "0xa808bc9775cb41c52c7842f8b50427fe7a770326",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x00000000000000000000000000000000000000000000000000000000000f4240",
    // sthUSD ERC-4626 vault over thUSD (convertToAssets(1e6) = 1017821 at block 26088438); no pinned DL pool.
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
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
  // Reviewed 2026-10-03 against exact tracked deployments and live rate reads.
  // ERC-4626 calldata uses share decimals; decoded rates and TVL use asset decimals.
  {
    stablecoinId: "senpyusdmwin-sentora",
    chain: "ethereum",
    contract: "0x7cbcfc4f64be199ede6db1d916ddcdb69f666b57",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "strusd-tori",
    chain: "ethereum",
    contract: "0x280839980a7ed0d7717f64125fe241012e5f5815",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 18 },
  },
  {
    stablecoinId: "syrupusdg-maple",
    chain: "ethereum",
    contract: "0x87b65c4aaffa76881f9e96f3e7ed945ddfc3cd7a",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x00000000000000000000000000000000000000000000000000000000000f4240",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "sfrax-frax",
    chain: "ethereum",
    contract: "0xa663b02cf0a4b149d2ad41910cb81e23e1c41c32",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 18 },
  },
  {
    stablecoinId: "sirloinusdc-steakhouse",
    chain: "base",
    contract: "0xbeeff2490feffa212fac2f6553682c219e6a8845",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "sreusd-resupply",
    chain: "ethereum",
    contract: "0x557ab1e003951a73c12d16f0fea8490e39c33c35",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 18 },
  },
  {
    stablecoinId: "gusdtq-galaxy",
    chain: "ethereum",
    contract: "0x71ffb6a81786ec285d429d531cf655107b9d878d",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "senpathusd-sentora",
    chain: "tempo",
    contract: "0x9a044ae05e5e6290dcf56afd69548565e957a626",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "senrlusdv2-sentora",
    chain: "ethereum",
    contract: "0x6dc58a0fdfc8d694e571dc59b9a52eeea780e6bf",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 18 },
  },
  {
    stablecoinId: "krusdc-keyrock",
    chain: "arc",
    contract: "0x5befab92a5a3d60f578cb51eeb4e4fd50a1e3123",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "kpkusdcprime-kpk",
    chain: "ethereum",
    contract: "0x4ef53d2caa51c447fdfeeedee8f07fd1962c9ee6",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "skymoneyusdtsavings-sky",
    chain: "ethereum",
    contract: "0x23f5e9c35820f4bab695ac1f19c203cc3f8e1e11",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "steakcusdc-steakhouse",
    chain: "ethereum",
    contract: "0xbeef00a59b577423653a1526c7009bde103f542b",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "senpyusdpst-sentora",
    chain: "ethereum",
    contract: "0x8381a156958711e230f325428b5eb4b6555c75d9",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "cscbusdc-clearstar",
    chain: "base",
    contract: "0x91c056b6d4311a743614fbc03ac32d4e6a2d3a3c",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "sparkusdtbc-spark",
    chain: "ethereum",
    contract: "0xb0c424116172b55cbb6dd3136f5989f7959e5b91",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "pendleusdc-pendle",
    chain: "ethereum",
    contract: "0x55c1b6e461a6334b567baf0feb5d728715446f05",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "senpyusdprimev2-sentora",
    chain: "ethereum",
    contract: "0xc21b08c16458202593d4d9b26b9984ee67b38bbd",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "sdai-gnosis",
    chain: "gnosis",
    contract: "0xaf204776c7245bf4147c2612bf6e5972ee483701",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 18 },
  },
  {
    stablecoinId: "senpyusdmain-sentora",
    chain: "ethereum",
    contract: "0xb576765fb15505433af24fee2c0325895c559fb2",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "susdx-axis",
    chain: "ethereum",
    contract: "0xeb892628d1e58bc475a6dcb7f5dbc4f591632aa4",
    selector: "0x3ba0b9a9",
    decimals: 18,
    // exchangeRate() takes no arguments. The generic reader's trailing zero word
    // is ignored by this deployment; exact and padded calls matched at block 26108099.
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
  },
  {
    stablecoinId: "hyperusdca-hyperithm",
    chain: "monad",
    contract: "0x78999cc96d2ba0341588c60ccb0e91c6c33cf371",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "gusdcq-galaxy",
    chain: "ethereum",
    contract: "0x91600e31fbedc72433d4a57f16639cfe661be7d8",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "susdc-spark-v1",
    chain: "ethereum",
    contract: "0xbc65ad17c5c0a2a4d159fa5a503f4992c7b545fe",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "steakeurcv-steakhouse",
    chain: "ethereum",
    contract: "0xbeef0c075da5d01112ae5cf34d257074fb5ddb2f",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    // EURCV-denominated totalAssets is not USD TVL.
  },
  {
    stablecoinId: "bbqusdc-steakhouse-v2",
    chain: "ethereum",
    contract: "0xbeeff2c5bf38f90e3482a8b19f12e5a6d2fca757",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "skymoneyusdsflagship-sky",
    chain: "ethereum",
    contract: "0xe15fcc81118895b67b6647bbd393182df44e11e0",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 18 },
  },
  {
    stablecoinId: "arcusdc-galaxy",
    chain: "arc",
    contract: "0x8e357432cc12ff425c36432f312968aeb16112af",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "gtusdtp-gauntlet",
    chain: "ethereum",
    contract: "0xf3557ad5e984211ac8a0874a670344f2c3376471",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "sxsrlusd-sentora",
    chain: "ethereum",
    contract: "0xfc8c624b6080a0a780583799f2a862de936f6e22",
    selector: "0x07a2d13a",
    decimals: 18,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 18 },
  },
  {
    stablecoinId: "ethenausdc-steakhouse",
    chain: "base",
    contract: "0xbeeff0be997cca5b1c13a7433c2004637975739e",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "armusdcs-wintermute",
    chain: "ethereum",
    contract: "0xa2eaad0d586cf9fd73bb2c09cf6a7e3e187d68cd",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "sparkusdc-spark",
    chain: "base",
    contract: "0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "kpkusdcyield-kpk",
    chain: "ethereum",
    contract: "0xd5cce260e7a755ddf0fb9cdf06443d593aaeaa13",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
  {
    stablecoinId: "susdat-saturn",
    chain: "ethereum",
    contract: "0xd166337499e176bbc38a1fbd113ab144e5bd2df7",
    selector: "0x07a2d13a",
    decimals: 6,
    inputAmount:
      "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    // USDat-denominated credit-vault NAV includes preferred-note gains and losses.
    tvlRead: { kind: "erc4626-total-assets", decimals: 6 },
  },
];

export const PRICE_DERIVED_FALLBACK_IDS = new Set([
  "usdb-blast",
  "usda-avalon",
  // Reviewed accumulating USD NAV shares. Keep explicit source ownership even
  // though navToken metadata also enables this lane. APY remains unavailable
  // until supply_history has the required 7-45 day priced comparison anchor.
  "earnusd-lido",
  "filqa-fidelity-international",
  "fiusd-sygnum",
  "cumiu-chinaamc",
  "uscc-superstate",
  "umint-ubs",
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


export const DIRECT_PROTOCOL_API_STRATEGIES: Record<string, string> = {
  "scrvusd-curve": "Curve scrvUSD current-rate reader",
  "lusd-liquity": "B.Protocol LQTY-only",
  "bd-basedollar": "Base Dollar Stability Pools (interest-only)",
  "bold-liquity": "Liquity V2 Stability Pools (interest-only)",
  "ybold-yearn": "Yearn yBOLD Stability Pool vault",
  "usyc-hashnote": "Hashnote NAV feed",
  "mmev-midas": "Midas mMEV NAV oracle",
  "usdy-ondo-finance": "Ondo USDY oracle",
  "reusd-re-protocol": "Re Protocol Basis-Plus (reUSD)",
  "zys-zephyr-protocol": "Zephyr Scanner ZYS returns",
};

export const DIRECT_PROTOCOL_API_SOURCE_KEYS: Record<string, string> = {
  "scrvusd-curve": "onchain:scrvusd-curve:scrvusd-current-rate",
  "lusd-liquity": buildOnChainSourceKey("lusd-liquity"),
  "bd-basedollar": buildOnChainSourceKey("bd-basedollar"),
  "bold-liquity": buildOnChainSourceKey("bold-liquity"),
  "ybold-yearn": "protocol-api:yearn:ybold",
  "usyc-hashnote": "protocol-api:hashnote-usyc",
  "mmev-midas": "protocol-api:midas-mmev-nav-oracle",
  "usdy-ondo-finance": "protocol-api:ondo-usdy-oracle",
  "reusd-re-protocol": "protocol-api:re-protocol-reusd",
  "zys-zephyr-protocol": "protocol-api:zys-zephyr-protocol",
};

const INTENTIONAL_GAP_REASONS_TYPED: Record<string, YieldAdapterLifecycleReason> = {
  "susd-hedgecore": {
    code: "no-public-yield-source",
    since: "2026-09-27",
    note: "Venus gross APY pin quarantined: holder rewards pass through 93%, and on-chain exchange-rate reads revert; no measured holder-return equivalence",
  },
  "bc3m-backed": {
    code: "no-public-yield-source",
    since: "2026-09-27",
    note: "USD supply-history prices cannot measure EUR-denominated holder return; price-derived yield is unavailable without native-currency return evidence",
  },
  "usdb-blast": {
    code: "no-public-yield-source",
    since: "2026-09-27",
    note: "Rebasing holder yield is not price appreciation; no reviewed rebasing-return adapter is wired",
  },
  "bfusd-binance": {
    code: "off-chain-account-product",
    since: "2026-04-14",
    nextReviewAt: "2026-10-09",
    note: "2026-07-09 review: keep intentional gap for off-chain Binance account yield product; no public runtime APY feed is wired or confirmed for holder-rate resolution",
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
  "thgold-theo": {
    code: "pre-launch",
    since: "2026-09-29",
    note: "pre-launch yield-bearing gold asset with no published token contract or runtime yield source yet",
  },
  "trusd-tori": {
    code: "pre-launch",
    since: "2026-04-14",
    note: "pre-launch asset with no reliable runtime yield source yet",
  },
  // https://www.blackrock.com/cash/literature/prospectus/pro-brsrv.pdf
  "brsrv-blackrock": {
    code: "issuer-distributed-yield",
    since: "2026-10-03",
    note: "BlackRock reinvests income in additional shares at a stable $1 NAV; no reviewed share-distribution return adapter is wired, and NAV growth cannot measure holder income",
  },
  // https://www.matrixdock.com/stbt
  "stbt-matrixdock": {
    code: "issuer-distributed-yield",
    since: "2026-10-03",
    note: "STBT distributes Treasury income through daily rebasing; no maintained rebase-return reader or exact native yield pool is established, and $1 price growth is not holder yield",
  },
  // https://www.sec.gov/Archives/edgar/data/1659326/000119312526217424/d44657d485bpos.htm
  "jltxx-jpmorgan": {
    code: "issuer-distributed-yield",
    since: "2026-10-03",
    note: "JLTXX reinvests daily dividends in same-class shares; the stable $1 NAV feed does not measure distributions, and no reviewed dividend-return adapter consumes the issuer's quoted fund yield",
  },
  // https://docs.unitas.so/overview/xgld.md
  "xgld-unitas": {
    code: "no-public-yield-source",
    since: "2026-10-03",
    note: "XGLD combines gold exposure with borrowed-USDT strategy returns; no verified principal-adjusted rate endpoint or deterministic conversion separates yield from gold-price appreciation",
  },
  // https://public-api.spiko.io/share-classes/chfSAFO/totals
  "chfsafo-spiko": {
    code: "source-family-adapter-unimplemented",
    since: "2026-10-03",
    note: "Spiko publishes CHF share-class NAV, but no reviewed native-CHF NAV-history yield adapter is wired; USD supply-history returns include CHF exchange-rate changes and cannot measure fund income alone",
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
 * Typed lifecycle entries for real intentional coverage gaps. Active dedicated
 * sources default to active; incompatible generic readers are final exclusions.
 *
 * Built eagerly as a plain const: `deriveYieldRegistry` takes it as a parameter,
 * so there is no import-order hazard between this module and the registry.
 */
export const YIELD_ADAPTER_LIFECYCLE: Record<string, YieldAdapterLifecycleEntry> = {
  ...Object.fromEntries(
    Object.entries(INTENTIONAL_GAP_REASONS_TYPED).map(
      ([id, reason]) => [id, { lifecycle: "intentional-gap", reason }] as const,
    ),
  ),
};
