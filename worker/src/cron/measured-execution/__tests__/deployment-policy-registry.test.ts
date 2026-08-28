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
  });
});
