import { describe, expect, it } from "vitest";
import {
  CURVE_STABLESWAP_DEPLOYMENT,
  CURVE_STABLESWAP_NG_DEPLOYMENTS,
  CURVE_STABLESWAP_NG_FACTORY_DEPLOYMENT,
  UNISWAP_V4_DEPLOYMENT,
} from "@shared/lib/measured-execution-deployment-policies";
import { CURVE_3POOL_STABLESWAP_POLICY } from "../curve-stableswap";
import {
  CURVE_DUSD_USDC_STABLESWAP_NG_POLICY,
  CURVE_USDG_USDC_STABLESWAP_NG_POLICY,
} from "../curve-stableswap-ng";
import { getUniswapV4Deployment } from "../uniswap-v4";
import {
  CURVE_DOLA_SUSDE_RATE_BEARING_POLICY,
  CURVE_GUSD_3CRV_METAPOOL_POLICY,
  CURVE_LUSD_3CRV_METAPOOL_POLICY,
  CURVE_R3_METAPOOL_POLICIES,
} from "../curve-composite-policies";

describe("measured deployment policy registry", () => {
  it("projects the legacy Curve identity byte-for-byte into the producer policy", () => {
    expect(CURVE_3POOL_STABLESWAP_POLICY).toEqual({
      chain: CURVE_STABLESWAP_DEPLOYMENT.chain,
      poolAddress: CURVE_STABLESWAP_DEPLOYMENT.poolAddress,
      expectedPoolCodeHash: CURVE_STABLESWAP_DEPLOYMENT.poolCodeHash,
      registryAddress: CURVE_STABLESWAP_DEPLOYMENT.registryAddress,
      expectedRegistryCodeHash: CURVE_STABLESWAP_DEPLOYMENT.registryCodeHash,
      lpTokenAddress: CURVE_STABLESWAP_DEPLOYMENT.lpTokenAddress,
      poolTokens: CURVE_STABLESWAP_DEPLOYMENT.poolTokens,
      mode: "active",
      scoreEligible: true,
    });
  });

  it.each([
    [CURVE_USDG_USDC_STABLESWAP_NG_POLICY, CURVE_STABLESWAP_NG_DEPLOYMENTS[0]],
    [CURVE_DUSD_USDC_STABLESWAP_NG_POLICY, CURVE_STABLESWAP_NG_DEPLOYMENTS[1]],
  ])("projects each StableSwap-NG identity into its producer policy", (policy, deployment) => {
    expect(policy).toMatchObject({
      chain: deployment.chain,
      stablecoinId: deployment.stablecoinId,
      poolAddress: deployment.poolAddress,
      expectedPoolCodeHash: deployment.poolCodeHash,
      factoryAddress: CURVE_STABLESWAP_NG_FACTORY_DEPLOYMENT.address,
      expectedFactoryCodeHash: CURVE_STABLESWAP_NG_FACTORY_DEPLOYMENT.codeHash,
      factoryPoolIndex: deployment.factoryPoolIndex,
      poolTokens: deployment.poolTokens,
      inputIndex: deployment.inputIndex,
      outputIndex: deployment.outputIndex,
    });
  });

  it("projects the Uniswap V4 runtime identities without widening the cohort", () => {
    expect(getUniswapV4Deployment("ethereum")).toEqual({
      adapterProfileId: UNISWAP_V4_DEPLOYMENT.adapterProfileId,
      protocol: UNISWAP_V4_DEPLOYMENT.protocol,
      chain: UNISWAP_V4_DEPLOYMENT.chain,
      mode: "active",
      scoreEligible: true,
      poolManagerAddress: UNISWAP_V4_DEPLOYMENT.poolManagerAddress,
      expectedPoolManagerCodeHash: UNISWAP_V4_DEPLOYMENT.poolManagerCodeHash,
      stateViewAddress: UNISWAP_V4_DEPLOYMENT.stateViewAddress,
      expectedStateViewCodeHash: UNISWAP_V4_DEPLOYMENT.stateViewCodeHash,
      endpointAddress: UNISWAP_V4_DEPLOYMENT.quoterAddress,
      expectedCodeHash: UNISWAP_V4_DEPLOYMENT.quoterCodeHash,
    });
    expect(getUniswapV4Deployment("base")).toBeNull();
  });

  it("reuses the shared Curve factory and 3pool identities in composite policies", () => {
    expect(CURVE_DOLA_SUSDE_RATE_BEARING_POLICY).toMatchObject({
      factoryAddress: CURVE_STABLESWAP_NG_FACTORY_DEPLOYMENT.address,
      expectedFactoryCodeHash: CURVE_STABLESWAP_NG_FACTORY_DEPLOYMENT.codeHash,
    });
    expect(CURVE_GUSD_3CRV_METAPOOL_POLICY.metapool).toMatchObject({
      basePoolAddress: CURVE_STABLESWAP_DEPLOYMENT.poolAddress,
      expectedBasePoolCodeHash: CURVE_STABLESWAP_DEPLOYMENT.poolCodeHash,
      basePoolTokens: CURVE_STABLESWAP_DEPLOYMENT.poolTokens,
    });
    expect(CURVE_LUSD_3CRV_METAPOOL_POLICY).toMatchObject({
      factoryPoolIndex: 16,
      implementationAddress: "0x5f890841f657d90e081babdb532a05996af79fe6",
      metapool: {
        basePoolAddress: CURVE_STABLESWAP_DEPLOYMENT.poolAddress,
        expectedBasePoolCodeHash: CURVE_STABLESWAP_DEPLOYMENT.poolCodeHash,
        basePoolTokens: CURVE_STABLESWAP_DEPLOYMENT.poolTokens,
      },
    });
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
