/** Optimism Velodrome Slipstream was retired in Liquidity v7.3; only Base Aerodrome remains. */
type SlipstreamProtocol = "aerodrome-slipstream";

export const SLIPSTREAM_COLLECTION_DEPLOYMENTS: Record<SlipstreamProtocol, {
  chain: string;
  sugarAddress: string;
  v2FactoryAddress: string;
  clFactoryAddress: string;
  sugarSkippedV2PoolCount: number;
}> = {
  "aerodrome-slipstream": {
    chain: "base",
    sugarAddress: "0x69dD9db6d8f8E7d83887A704f447b1a584b599A1",
    v2FactoryAddress: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
    clFactoryAddress: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
    sugarSkippedV2PoolCount: 0,
  },
};
