import type { SolidlyV2MathVariant } from "./solidly-v2-math";

export interface SolidlyV2Deployment {
  protocol: "aerodrome" | "velodrome";
  chain: "base" | "optimism";
  variant: SolidlyV2MathVariant;
  capabilityId: string;
  factoryAddress: `0x${string}`;
  factoryCodeHash: `0x${string}`;
  poolCodeHash: `0x${string}`;
  implementationAddress: `0x${string}`;
  implementationCodeHash: `0x${string}`;
}

/** Reviewed 2026-10-05 runtime pins. Stable-only diagnostic cohorts; neither is score-eligible. */
export const SOLIDLY_V2_DEPLOYMENTS: readonly SolidlyV2Deployment[] = [
  {
    protocol: "aerodrome", chain: "base", variant: "aerodrome",
    capabilityId: "solidly-v2-aerodrome-base-stable-diagnostic",
    factoryAddress: "0x420dd381b31aef6683db6b902084cb0ffece40da",
    factoryCodeHash: "0xe2a176e5d2bcfb214b784ec6d6733708a6376a464f203cc265c284c9f349fea3",
    poolCodeHash: "0x7dd6ffe6daf4e82054c91becd71b8c9ba0a135f0f403da1ef7b0f81bb8ba4408",
    implementationAddress: "0xa4e46b4f701c62e14df11b48dce76a7d793cd6d7",
    implementationCodeHash: "0xd22754a0a3b39db7298dbbc2be1e34b34320988ea67065c85fa28ae66c02d31e",
  },
  {
    protocol: "velodrome", chain: "optimism", variant: "velodrome",
    capabilityId: "solidly-v2-velodrome-optimism-stable-diagnostic",
    factoryAddress: "0xf1046053aa5682b4f9a81b5481394da16be5ff5a",
    factoryCodeHash: "0x550399c9f73f73cc4bd8294c72155db44f7832fbc84fa190f38168869f90a8d4",
    poolCodeHash: "0x1338d20d2b1849933e083072be42c61c5ab7b8f4a5ce05d8f8944a4280f21b48",
    implementationAddress: "0x95885af5492195f0754be71ad1545fe81364e531",
    implementationCodeHash: "0x6a4a3ed659632c1f4920ffb47208c9bd8a6ff8acda6d51ca878642acb52c7d02",
  },
];
