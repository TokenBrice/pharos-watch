import { DEX_MEASURED_ADAPTER_PROFILE_IDS } from "../types/measured-execution";

export const CURVE_STABLESWAP_DEPLOYMENT = {
  adapterProfileId: DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwap,
  chain: "ethereum",
  poolAddress: "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7",
  poolCodeHash: "0x954a1e212c557c85043985931498ffa3e2fcbe7dfe9cd61513f36eb47d6f4dfc",
  registryAddress: "0x90e00ace148ca3b23ac1bc8c240c2a7dd9c2d7f5",
  registryCodeHash: "0x13d7cfcf1cef4bf310fa544567a427771c9be2c16bbf2c6be845d3d5f4cc5f22",
  lpTokenAddress: "0x6c3f90f043a72fa612cbac8115ee7e52bde6e490",
  poolTokens: [
    { address: "0x6b175474e89094c44da98b954eedeac495271d0f", symbol: "DAI", decimals: 18 },
    { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
    { address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6 },
  ],
} as const;

export const CURVE_STABLESWAP_NG_FACTORY_DEPLOYMENT = {
  address: "0x6a8cbed756804b16e05e741edabd5cb544ae21bf",
  codeHash: "0xb78c1b32cd364260f3fa497ccc7e98c73cdc26bdae2d3635e763ee8b59a1d6fd",
} as const;

export const CURVE_STABLESWAP_NG_DEPLOYMENTS = [
  {
    adapterProfileId: DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwapNg,
    chain: "ethereum",
    stablecoinId: "usdg-paxos",
    poolAddress: "0xc061caa073f3d95f80f8e5428d32d2d76f5e1622",
    poolCodeHash: "0x1c7b77a94bb42408ab6d5cfd76223f0c794db9b119bb6035db91d8b09da65512",
    factoryPoolIndex: 563,
    poolTokens: [
      { address: "0xe343167631d89b6ffc58b88d6b7fb0228795491d", symbol: "USDG", decimals: 6, trackedAssetId: "usdg-paxos" },
      { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6, trackedAssetId: "usdc-circle" },
    ],
    inputIndex: 0,
    outputIndex: 1,
  },
  {
    adapterProfileId: DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwapNg,
    chain: "ethereum",
    stablecoinId: "dusd-dialectic",
    poolAddress: "0x32e616f4f17d43f9a5cd9be0e294727187064cb3",
    poolCodeHash: "0x1fb319d2b11164fe6584bf44ed640436ce07baa68c65e5b3b2338aa4ad8b6ac7",
    factoryPoolIndex: 580,
    poolTokens: [
      { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6, trackedAssetId: "usdc-circle" },
      { address: "0x1e33e98af620f1d563fcd3cfd3c75ace841204ef", symbol: "DUSD", decimals: 18, trackedAssetId: "dusd-dialectic" },
    ],
    inputIndex: 1,
    outputIndex: 0,
  },
] as const;

export const UNISWAP_V4_DEPLOYMENT = {
  adapterProfileId: "uniswap-v4-hook-free-quoter-v1",
  protocol: "uniswap-v4",
  chain: "ethereum",
  hookFreeAddress: "0x0000000000000000000000000000000000000000",
  poolManagerAddress: "0x000000000004444c5dc75cb358380d2e3de08a90",
  poolManagerCodeHash: "0x785f1014552b7ce7d5fb7d0c970ca60edee94fd00425d7ca21609acac7ce1293",
  stateViewAddress: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
  stateViewCodeHash: "0xd7947778589cf4aac9a092a4451292a2056380941635ab7006d3c691d8dfd878",
  quoterAddress: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203",
  quoterCodeHash: "0x06de58fa119c5deaa7a667fb92d3894e25d9160e62fb82c8d86d43b47eefe441",
} as const;
