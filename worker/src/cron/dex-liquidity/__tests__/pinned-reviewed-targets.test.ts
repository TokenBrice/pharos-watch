import { describe, expect, it } from "vitest";
import { CURVE_STABLESWAP_NG_SHADOW_DEPLOYMENTS, QUOTER_V2_REVIEWED_RETAINED_POOLS } from "@shared/lib/measured-execution-deployment-policies";
import { buildDexMeasuredExecutionTargetId, DexMeasuredExecutionTargetSchema } from "@shared/types/measured-execution";
import { attachPinnedReviewedExecutionTargets } from "../execution-targets/pinned-reviewed";
import { estimateAdmissionCohortRpcRequestBreakdown, isDexMeasuredExecutionTargetScoreEligible } from "../../measured-execution/admission";
import { getDexMeasuredExecutionDeployment } from "../../measured-execution/registry";
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
    attachPinnedReviewedExecutionTargets(input);
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
    attachPinnedReviewedExecutionTargets(input);
    expect(input.metrics.get(policy.stablecoinId)!.topPools[0]!.extra?.measuredExecutionTarget).toBeUndefined();
  });

  it("does not create a target without a current validated price", () => {
    const input = fixture();
    input.stablecoinPriceById.delete(policy.stablecoinId);
    attachPinnedReviewedExecutionTargets(input);
    expect(input.metrics.get(policy.stablecoinId)!.topPools[0]!.extra?.measuredExecutionTarget).toBeUndefined();
  });

  it("does not manufacture a missing retained physical row", () => {
    const input = fixture();
    input.metrics.get(policy.stablecoinId)!.topPools = [];
    attachPinnedReviewedExecutionTargets(input);
    expect(input.metrics.get(policy.stablecoinId)!.topPools).toHaveLength(0);
  });
});

describe("reviewed active retained-pool targets", () => {
  const directions = QUOTER_V2_REVIEWED_RETAINED_POOLS.flatMap((policy) =>
    policy.inputAssetIds.map((stablecoinId) => ({ policy, stablecoinId })));

  function fixture({ policy, stablecoinId }: typeof directions[number]) {
    const pool = {
      poolId: `${policy.chain}:${policy.poolAddress}`, chain: policy.chain,
      project: policy.protocol, tvlUsd: stablecoinId === "ggbr-goldfish-gold" ? 300_000 : 100_000,
      symbol: "display label is not identity", poolType: "cg-concentrated", source: "cg_onchain",
      volumeUsd1d: 0,
    };
    return {
      metrics: new Map([[stablecoinId, { topPools: [pool] } as LiquidityMetrics]]),
      stablecoinPriceById: new Map<string, number>(policy.poolTokens.map((token) => [token.trackedAssetId, 1])),
      chainAddressToId: new Map<string, string>(policy.poolTokens.map((token) => [`${policy.chain}:${token.address}`, token.trackedAssetId])),
      capturedAt: 1_791_966_500,
    };
  }

  it.each(directions)("builds the exact reviewed $stablecoinId direction without activating a deployment", (direction) => {
    const { policy, stablecoinId } = direction;
    const input = fixture(direction);
    attachPinnedReviewedExecutionTargets(input);
    const target = input.metrics.get(stablecoinId)!.topPools[0]!.extra?.measuredExecutionTarget;
    expect(DexMeasuredExecutionTargetSchema.safeParse(target).success).toBe(true);
    expect(target).toMatchObject({
      adapterProfileId: policy.adapterProfileId, poolId: `${policy.chain}:${policy.poolAddress}`,
      feePips: policy.feePips, tokenIn: { trackedAssetId: stablecoinId },
      poolTokenAddresses: policy.poolTokens.map((token) => token.address),
    });
    expect(getDexMeasuredExecutionDeployment(policy.adapterProfileId, policy.chain)?.factoryAddress).toBe(policy.factoryAddress);
    expect(isDexMeasuredExecutionTargetScoreEligible(target!)).toBe(true);
    expect(target!.targetId).toBe(buildDexMeasuredExecutionTargetId({
      ...target!, tokenInAddress: target!.tokenIn.address, tokenOutAddress: target!.tokenOut.address,
    }));
  });

  it("bounds the entire recovery packet without widening a request or quote cap", () => {
    const targets = directions.map((direction) => {
      const input = fixture(direction);
      attachPinnedReviewedExecutionTargets(input);
      return input.metrics.get(direction.stablecoinId)!.topPools[0]!.extra!.measuredExecutionTarget!;
    });
    expect(QUOTER_V2_REVIEWED_RETAINED_POOLS).toHaveLength(8);
    expect(targets).toHaveLength(9);
    expect(new Set(targets.map((target) => target.targetId)).size).toBe(9);
    expect(estimateAdmissionCohortRpcRequestBreakdown(targets)).toEqual({
      setupRpcRequests: 12, quoteRpcRequests: 28, totalRpcRequests: 40,
    });
    // At most five ladder points, three refinements and one revert confirmation.
    expect(targets.length * (5 + 3 + 1)).toBe(81);
  });

  it.each(["missing-price", "wrong-contract", "wrong-chain", "wrong-protocol", "decayed", "synthetic"] as const)(
    "does not recover %s evidence",
    (refusal) => {
      const direction = directions[0]!;
      const input = fixture(direction);
      const pool = input.metrics.get(direction.stablecoinId)!.topPools[0]!;
      if (refusal === "missing-price") input.stablecoinPriceById.delete(direction.stablecoinId);
      if (refusal === "wrong-contract") input.chainAddressToId.set(`${direction.policy.chain}:${direction.policy.poolTokens[1].address}`, "unrelated-asset");
      if (refusal === "wrong-chain") pool.chain = "ethereum";
      if (refusal === "wrong-protocol") pool.project = "uniswap-v3";
      if (refusal === "decayed") pool.extra = { measurement: { decayed: true } };
      if (refusal === "synthetic") pool.extra = { measurement: { synthetic: true } };
      attachPinnedReviewedExecutionTargets(input);
      expect(pool.extra?.measuredExecutionTarget).toBeUndefined();
    },
  );

  it("preserves a descriptor already captured by the live source", () => {
    const direction = directions[0]!;
    const input = fixture(direction);
    attachPinnedReviewedExecutionTargets(input);
    const pool = input.metrics.get(direction.stablecoinId)!.topPools[0]!;
    const target = pool.extra!.measuredExecutionTarget!;
    attachPinnedReviewedExecutionTargets(input);
    expect(pool.extra!.measuredExecutionTarget).toBe(target);
  });
});
