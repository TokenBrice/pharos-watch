import { describe, expect, it } from "vitest";
import {
  CURVE_STABLESWAP_DEPLOYMENT,
  UNISWAP_V4_DEPLOYMENT,
  CURVE_STABLESWAP_NG_SHADOW_DEPLOYMENTS,
} from "@shared/lib/measured-execution-deployment-policies";
import { getCurveStableSwapNgPolicy } from "../curve-stableswap-ng";
import { getUniswapV4Deployment } from "../uniswap-v4";
import { CURVE_R3_METAPOOL_POLICIES } from "../curve-composite-policies";
import { getDexMeasuredExecutionDeployment } from "../registry";
import { isDexMeasuredExecutionTargetScoreEligible, resolveTargetDeployment } from "../admission";
import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";

describe("measured deployment policy registry", () => {
  it("collects pinned shadow cohorts without admitting them to scoring", () => {
    const targets = [
      ...["bsc", "base", "arbitrum", "polygon"].map((chain) => ({
        adapterProfileId: UNISWAP_V4_DEPLOYMENT.adapterProfileId, chain, poolId: `${chain}:0x${"ab".repeat(32)}`,
      })),
      ...["base", "xlayer"].map((chain) => ({
        adapterProfileId: "uniswap-v3-quoter-v2", chain, poolId: `${chain}:0x${"ab".repeat(20)}`,
      })),
      ...CURVE_STABLESWAP_NG_SHADOW_DEPLOYMENTS.map((deployment) => ({
        adapterProfileId: deployment.adapterProfileId, chain: deployment.chain,
        poolId: `${deployment.chain}:${deployment.poolAddress}`,
      })),
    ] as DexMeasuredExecutionTarget[];
    for (const target of targets) {
      expect(resolveTargetDeployment(target)).not.toBeNull();
      expect(isDexMeasuredExecutionTargetScoreEligible(target)).toBe(false);
      const deployment = getUniswapV4Deployment(target.chain);
      if (target.adapterProfileId === UNISWAP_V4_DEPLOYMENT.adapterProfileId) {
        expect(deployment).toMatchObject({ mode: "shadow", scoreEligible: false });
        expect(deployment?.expectedCodeHash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(deployment?.poolManagerAddress).toMatch(/^0x[0-9a-f]{40}$/);
        expect(deployment?.stateViewAddress).toMatch(/^0x[0-9a-f]{40}$/);
      } else if (target.adapterProfileId === "uniswap-v3-quoter-v2") {
        const quoter = getDexMeasuredExecutionDeployment(target.adapterProfileId, target.chain);
        expect(quoter?.factoryAddress).toMatch(/^0x[0-9a-f]{40}$/);
        expect(quoter?.expectedCodeHash).toMatch(/^0x[0-9a-f]{64}$/);
      } else {
        const curve = getCurveStableSwapNgPolicy(target.chain, target.poolId.split(":")[1]!);
        expect(curve).toMatchObject({ mode: "shadow", scoreEligible: false });
        expect(curve?.factoryAddress).toMatch(/^0x[0-9a-f]{40}$/);
        expect(curve?.expectedPoolCodeHash).toMatch(/^0x[0-9a-f]{64}$/);
      }
    }
    expect(getUniswapV4Deployment("ethereum")).toMatchObject({ mode: "active", scoreEligible: true });
    expect(getUniswapV4Deployment("unsupported-chain")).toBeNull();
    expect(getCurveStableSwapNgPolicy("etherlink", "0x" + "ab".repeat(20))).toBeNull();
  });

  it("keeps legacy Ethereum factory/3Crv policies on one reviewed template", () => {
    const policies = CURVE_R3_METAPOOL_POLICIES.filter((policy) =>
      ["alusd-alchemix", "lusd-liquity", "ousd-origin-protocol"].includes(
        policy.stablecoinId,
      ));

    expect(policies).toHaveLength(3);
    for (const policy of policies) {
      expect(policy).toMatchObject({
        chain: "ethereum",
        expectedPoolCodeHash:
          "0x156700a4060f3d62786914b50cc60b2b840e6440401bea9a99c0acce0b58beda",
        factoryAddress: "0xb9fc157394af804a3578134a6585c0dc9cc990d4",
        expectedFactoryCodeHash:
          "0xd1b02d8c066dc343522d6aa5f6427b5245dc1f3276841ea48180cb0d0387e2ca",
        expectedRegistryId: "factory",
        factoryArrayEncoding: "legacy-fixed",
        implementationBinding: "factory-lookup",
        implementationAddress: "0x5f890841f657d90e081babdb532a05996af79fe6",
        expectedImplementationCodeHash:
          "0x260a286cc14e91f4a2d4a966e2e5f5030543a7d2f090a623f5fa15ba174a50f3",
        inputIndex: 0,
        outputIndex: 2,
        metapool: {
          basePoolBinding: "factory-get-base-pool",
          basePoolAddress: CURVE_STABLESWAP_DEPLOYMENT.poolAddress,
          expectedBasePoolCodeHash: CURVE_STABLESWAP_DEPLOYMENT.poolCodeHash,
          basePoolTokens: CURVE_STABLESWAP_DEPLOYMENT.poolTokens,
        },
      });
      expect(policy.poolTokens[0].trackedAssetId).toBe(policy.stablecoinId);
      expect(policy.executionTokens[0]).toEqual(policy.poolTokens[0]);
    }
  });
});
