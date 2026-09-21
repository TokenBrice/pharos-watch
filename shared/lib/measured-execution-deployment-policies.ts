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

/** Official v4 deployments, verified by bytecode and quoter.poolManager() on 2026-09-21. */
export const UNISWAP_V4_SHADOW_DEPLOYMENTS = [
  {
    ...UNISWAP_V4_DEPLOYMENT,
    chain: "bsc",
    poolManagerAddress: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
    poolManagerCodeHash: "0x48752321ee7abf0d2a17c30679df9a1ddd14dc75d28b26e2509b76396145a005",
    stateViewAddress: "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4",
    stateViewCodeHash: "0x5bbb9e82e49709fea04b2f873a6ad149a983ddf7eafc86f0fe79ad0a8c512d2b",
    quoterAddress: "0x9f75dd27d6664c475b90e105573e550ff69437b0",
    quoterCodeHash: "0xaa14bdb3b2246fb3d795e19c7ca78e8908539f593344b9ff971ce3bdf2d06d08",
  },
  {
    ...UNISWAP_V4_DEPLOYMENT,
    chain: "base",
    poolManagerAddress: "0x498581ff718922c3f8e6a244956af099b2652b2b",
    poolManagerCodeHash: "0x83b2af6e9f3158defc2811cbcb0db71ecf8b2ba2abea39c39e370ac5c6f43eb6",
    stateViewAddress: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
    stateViewCodeHash: "0xbbd5859677ef5491143133e8ed2b8faa0272f6fc2cbae94c53e79cc8c0538545",
    quoterAddress: "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
    quoterCodeHash: "0x9a5c0cdd56325bef0e48cdab071a4b6a7f877e1271c2e08510998d724a038bb3",
  },
  {
    ...UNISWAP_V4_DEPLOYMENT,
    chain: "arbitrum",
    poolManagerAddress: "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
    poolManagerCodeHash: "0xe4b2759e456c9c4ef763e3b4e257c5105e1ba283d7de8b131dd321197de794a4",
    stateViewAddress: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
    stateViewCodeHash: "0x4c0e823a0cd44b6b2d9485e774c421cf929db3996096d9b84ee6b23525184b9e",
    quoterAddress: "0x3972c00f7ed4885e145823eb7c655375d275a1c5",
    quoterCodeHash: "0x98305ebcd33e8989a8e941072ffe9bc6dac7912ccb9d097befa2d17696da37ff",
  },
  {
    ...UNISWAP_V4_DEPLOYMENT,
    chain: "polygon",
    poolManagerAddress: "0x67366782805870060151383f4bbff9dab53e5cd6",
    poolManagerCodeHash: "0xcfd0bc71e4f75b0c3e078e53baad950360d3e9f62b55c48b556f9de967aa80f7",
    stateViewAddress: "0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a",
    stateViewCodeHash: "0x7dc64bb4b52657a626a2cc9589d5db335ac6e51eea0d15fef3822d0293c21098",
    quoterAddress: "0xb3d5c3dfc3a7aebff71895a7191796bffc2c81b9",
    quoterCodeHash: "0x57943bde684fc70aff2a90a730bea2d5cd19031ac2abf488ae9ff827f55000e1",
  },
] as const;

export const CURVE_STABLESWAP_NG_ETHERLINK_FACTORY = {
  address: "0x8271e06e5887fe5ba05234f5315c19f3ec90e8ad",
  codeHash: "0xded1a5a542411bf8bced670953ccbed8dfc0443ee9d0e190e61cebc31631f87f",
} as const;

/** Factory membership, runtime and ordered coins verified at Etherlink block 53,950,012. */
export const CURVE_STABLESWAP_NG_SHADOW_DEPLOYMENTS = [
  {
    adapterProfileId: DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwapNg,
    chain: "etherlink",
    stablecoinId: "mtbill-midas",
    poolAddress: "0x942644106b073e30d72c2c5d7529d5c296ea91ab",
    poolCodeHash: "0xc9d3eb4bc778997b41a388aa2b065dc274ce4a518bf131c1a125083a1a484b37",
    factoryPoolIndex: 2,
    poolTokens: [
      { address: "0xdd629e5241cbc5919847783e6c96b2de4754e438", symbol: "MTBILL", decimals: 18, trackedAssetId: "mtbill-midas" },
      { address: "0x796ea11fa2dd751ed01b53c372ffdb4aaa8f00f9", symbol: "USDC", decimals: 6, trackedAssetId: "usdc-circle" },
    ],
    inputIndex: 0,
    outputIndex: 1,
  },
  {
    adapterProfileId: DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwapNg,
    chain: "etherlink",
    stablecoinId: "mmev-midas",
    poolAddress: "0x269b47978f4348c96f521658ef452ff85906fcfe",
    poolCodeHash: "0xf3d9267b9a8ef6fd280c75e5fef52d224da8425e4ff0560801cfeb869685cca5",
    factoryPoolIndex: 4,
    poolTokens: [
      { address: "0x5542f82389b76c23f5848268893234d8a63fd5c8", symbol: "MMEV", decimals: 18, trackedAssetId: "mmev-midas" },
      { address: "0x796ea11fa2dd751ed01b53c372ffdb4aaa8f00f9", symbol: "USDC", decimals: 6, trackedAssetId: "usdc-circle" },
    ],
    inputIndex: 0,
    outputIndex: 1,
  },
  {
    adapterProfileId: DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwapNg,
    chain: "etherlink",
    stablecoinId: "mre7yield-midas",
    poolAddress: "0x5d37f9b272ca7cda2a05245b9a503746eefac88f",
    poolCodeHash: "0x9f0910e38eb9a99a7c0ef4f620a00cedafe053f9ae1642b36579b3a2066273c6",
    factoryPoolIndex: 8,
    poolTokens: [
      { address: "0x796ea11fa2dd751ed01b53c372ffdb4aaa8f00f9", symbol: "USDC", decimals: 6, trackedAssetId: "usdc-circle" },
      { address: "0x733d504435a49fc8c4e9759e756c2846c92f0160", symbol: "MRE7YIELD", decimals: 18, trackedAssetId: "mre7yield-midas" },
    ],
    inputIndex: 1,
    outputIndex: 0,
  },
] as const;
