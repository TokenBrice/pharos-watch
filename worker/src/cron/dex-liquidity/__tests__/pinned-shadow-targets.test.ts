import { describe, expect, it } from "vitest";
import { CURVE_STABLESWAP_NG_SHADOW_DEPLOYMENTS } from "@shared/lib/measured-execution-deployment-policies";
import { DexMeasuredExecutionTargetSchema } from "@shared/types/measured-execution";
import { attachPinnedShadowExecutionTargets } from "../execution-targets/pinned-shadow";
import { isDexMeasuredExecutionTargetScoreEligible } from "../../measured-execution/admission";
import type { LiquidityMetrics } from "../types";

describe("pinned retained shadow targets", () => {
  const policy = CURVE_STABLESWAP_NG_SHADOW_DEPLOYMENTS[0];
  function fixture(deployment: (typeof CURVE_STABLESWAP_NG_SHADOW_DEPLOYMENTS)[number] = policy) {
    const pool = { poolId: `${deployment.chain}:${deployment.poolAddress}`, chain: deployment.chain, project: "curve", tvlUsd: 1_000_000, symbol: "yield token / USDC", poolType: "cg-amm", source: "cg_onchain", volumeUsd1d: 0 };
    return {
      metrics: new Map([[deployment.stablecoinId, { topPools: [pool] } as LiquidityMetrics]]),
      stablecoinPriceById: new Map([[deployment.stablecoinId, 1.05], ["usdc-circle", 1]]),
      capturedAt: 1_800_000_000,
      chainAddressToId: new Map<string, string>(deployment.poolTokens.map((token) => [`${deployment.chain}:${token.address}`, token.trackedAssetId])),
    };
  }

  it.each(CURVE_STABLESWAP_NG_SHADOW_DEPLOYMENTS)("materializes $stablecoinId in reviewed order without scoring", (deployment) => {
    const input = fixture(deployment);
    attachPinnedShadowExecutionTargets(input);
    const target = input.metrics.get(deployment.stablecoinId)!.topPools[0]!.extra?.measuredExecutionTarget;
    expect(DexMeasuredExecutionTargetSchema.safeParse(target).success).toBe(true);
    expect(target?.poolTokenAddresses).toEqual(deployment.poolTokens.map((token) => token.address));
    expect(target?.tokenIn.address).toBe(deployment.poolTokens[deployment.inputIndex].address);
    expect(target?.tokenIn.trackedAssetId).toBe(deployment.stablecoinId);
    expect(target?.tokenOut.trackedAssetId).toBe("usdc-circle");
    expect(isDexMeasuredExecutionTargetScoreEligible(target!)).toBe(false);
  });

  it("rejects a conflicting tracked contract identity", () => {
    const input = fixture();
    input.chainAddressToId.set(`etherlink:${policy.poolTokens[0].address}`, "unrelated-asset");
    attachPinnedShadowExecutionTargets(input);
    expect(input.metrics.get(policy.stablecoinId)!.topPools[0]!.extra?.measuredExecutionTarget).toBeUndefined();
  });

  it("does not create a target without a current validated price", () => {
    const input = fixture();
    input.stablecoinPriceById.delete(policy.stablecoinId);
    attachPinnedShadowExecutionTargets(input);
    expect(input.metrics.get(policy.stablecoinId)!.topPools[0]!.extra?.measuredExecutionTarget).toBeUndefined();
  });

  it("does not manufacture a missing retained physical row", () => {
    const input = fixture();
    input.metrics.get(policy.stablecoinId)!.topPools = [];
    attachPinnedShadowExecutionTargets(input);
    expect(input.metrics.get(policy.stablecoinId)!.topPools).toHaveLength(0);
  });
});
