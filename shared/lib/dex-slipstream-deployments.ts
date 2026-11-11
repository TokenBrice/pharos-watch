type SlipstreamProtocol = "aerodrome-slipstream" | "velodrome-slipstream";

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
  "velodrome-slipstream": {
    chain: "optimism",
    sugarAddress: "0x347512180804A8B40AA7525AE932a31198F074aA",
    v2FactoryAddress: "0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a",
    clFactoryAddress: "0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F",
    // This Sugar deployment omits the V2 convertor at allPools(0).
    sugarSkippedV2PoolCount: 1,
  },
};
