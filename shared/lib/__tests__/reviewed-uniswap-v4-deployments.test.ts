import { describe, expect, it } from "vitest";
import { UNISWAP_V4_REVIEWED_DEPLOYMENTS } from "../measured-execution-deployment-policies";
import { validateMeasuredExecutionProfile } from "../p4-exit-route-measured-profile-validation";
import { getDexExecutionCapabilityRegistration, isDexExecutionProfileAdmittedForScoring } from "../p4-exit-route-capability-policy";
import { retainedPool, uniswapV4MeasuredProfile } from "./p4-exit-route-capacity.test-support";

describe("reviewed V4 public identity and separate scoring authority", () => {
  it.each(UNISWAP_V4_REVIEWED_DEPLOYMENTS)("validates $chain pins independently of lifecycle", (deployment) => {
    const profile = uniswapV4MeasuredProfile(1_752_559_940);
    profile.chain = deployment.chain;
    profile.poolId = `${deployment.chain}:${profile.uniswapV4PoolProvenance!.poolId}`;
    profile.executionEndpoint = { address: deployment.quoterAddress, codeHash: deployment.quoterCodeHash };
    profile.uniswapV4PoolProvenance = {
      ...profile.uniswapV4PoolProvenance!,
      poolManagerAddress: deployment.poolManagerAddress, poolManagerCodeHash: deployment.poolManagerCodeHash,
      stateViewAddress: deployment.stateViewAddress, stateViewCodeHash: deployment.stateViewCodeHash,
    };
    const context = { stablecoinId: "usdc-circle", observedAt: 1_752_560_000,
      pool: retainedPool("reviewed-v4", "uniswap-v4", deployment.chain, 2_000_000, "USDC-USDT", "uniswap-v4", "dl",
        { measuredExecutionPhysicalPoolId: profile.poolId }),
    };
    expect(validateMeasuredExecutionProfile(profile, context)).not.toContain("invalid-uniswap-v4-identity");
    expect(isDexExecutionProfileAdmittedForScoring(profile, getDexExecutionCapabilityRegistration(profile.adapterProfileId)!))
      .toBe(deployment.mode === "active" && deployment.scoreEligible);
    profile.hookAddress = "0x0000000000000000000000000000000000000080";
    expect(validateMeasuredExecutionProfile(profile, context)).toContain("invalid-uniswap-v4-identity");
  });

  it("denies a retired Unichain public profile instead of retaining a compatibility lookup", () => {
    const profile = uniswapV4MeasuredProfile(1_752_559_940);
    profile.chain = "unichain";
    profile.poolId = `unichain:${profile.uniswapV4PoolProvenance!.poolId}`;
    expect(validateMeasuredExecutionProfile(profile, {
      stablecoinId: "usdc-circle", observedAt: 1_752_560_000,
      pool: retainedPool("retired-v4", "uniswap-v4", "unichain", 2_000_000, "USDC-USDT", "uniswap-v4", "dl",
        { measuredExecutionPhysicalPoolId: profile.poolId }),
    })).toContain("invalid-uniswap-v4-identity");
    expect(isDexExecutionProfileAdmittedForScoring(profile, getDexExecutionCapabilityRegistration(profile.adapterProfileId)!)).toBe(false);
  });
});
