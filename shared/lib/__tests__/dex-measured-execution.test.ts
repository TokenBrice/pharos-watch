import { describe, expect, it } from "vitest";

import {
  DEX_MEASURED_ADAPTER_PROFILE_IDS,
  buildDexMeasuredCapacityCurve,
  buildDexMeasuredExecutionTargetId,
  getDexMeasuredExecutionFreshnessMaxSec,
  getDexMeasuredExecutionProbeNotionals,
  toDexMeasuredExecutionPublicProfile,
  validateDexMeasuredExecutionProfile,
} from "../../types/measured-execution";
import { ExitRouteCapacityPointSchema } from "../../types/exit-route";

import { TOKEN_IN, TOKEN_OUT, proofPoint, revertedProofPoint, target, profile, validationInput } from "./dex-measured-execution.test-support";

describe("DEX measured execution contract", () => {
  it("uses the reviewed TVL-tiered ladder", () => {
    expect(getDexMeasuredExecutionProbeNotionals(200_000)).toEqual([1_000, 100_000]);
    expect(getDexMeasuredExecutionProbeNotionals(1_000_000)).toEqual([1_000, 100_000, 1_000_000]);
    expect(getDexMeasuredExecutionProbeNotionals(3_000_000)).toEqual([
      1_000,
      100_000,
      1_000_000,
      10_000_000,
      25_000_000,
    ]);
    expect(getDexMeasuredExecutionProbeNotionals(249_999)).toEqual([1_000, 100_000]);
    expect(getDexMeasuredExecutionProbeNotionals(250_000)).toEqual([1_000, 100_000, 1_000_000]);
    expect(getDexMeasuredExecutionProbeNotionals(2_499_999)).toEqual([1_000, 100_000, 1_000_000]);
    expect(getDexMeasuredExecutionProbeNotionals(2_500_000)).toEqual([
      1_000,
      100_000,
      1_000_000,
      10_000_000,
      25_000_000,
    ]);
  });

  it("reports only actually quoted passing inputs and never interpolates", () => {
    const curve = buildDexMeasuredCapacityCurve(
      [
        proofPoint(1_000, 999),
        proofPoint(55_000, 54_000),
        proofPoint(77_500, 74_000),
      ],
      1_000_000,
    );
    expect(curve.map((point) => point.executableUsd)).toEqual([55_000, 55_000, 55_000, 55_000]);
    expect(curve.map((point) => point.executionCostBps)).toEqual([
      expect.closeTo(181.8181818, 6),
      expect.closeTo(181.8181818, 6),
      expect.closeTo(181.8181818, 6),
      expect.closeTo(181.8181818, 6),
    ]);
  });

  it("bounds an optional realized point cost and accepts legacy omission", () => {
    const point = {
      requestedNotionalUsd: 100_000,
      maxCostBps: 200,
      executableUsd: 100_000,
      completionRatio: 1,
    };
    expect(ExitRouteCapacityPointSchema.safeParse(point).success).toBe(true);
    expect(ExitRouteCapacityPointSchema.safeParse({ ...point, executionCostBps: 37 }).success).toBe(true);
    expect(ExitRouteCapacityPointSchema.safeParse({ ...point, executionCostBps: 201 }).success).toBe(false);
  });

  it("validates legacy points without cost but rejects a false realized cost", () => {
    const nowSec = 10_000;
    const legacy = profile(nowSec);
    legacy.capacityCurve = legacy.capacityCurve.map(({ executionCostBps: _cost, ...point }) => point);
    expect(validateDexMeasuredExecutionProfile(validationInput(legacy, nowSec))).toEqual([]);

    const tampered = profile(nowSec);
    tampered.capacityCurve[0]!.executionCostBps = 1;
    expect(validateDexMeasuredExecutionProfile(validationInput(tampered, nowSec))).toContain("invalid-capacity-curve");
  });

  it("accepts a fresh identity-consistent lower-bound profile", () => {
    const nowSec = 10_000;
    expect(validateDexMeasuredExecutionProfile(validationInput(profile(nowSec), nowSec))).toEqual([]);
  });

  it("accepts successful high-tier probes while clamping reported capacity to 1.5x TVL", () => {
    const nowSec = 10_000;
    const highTvlTarget = { ...target(nowSec), retainedTvlUsd: 3_000_000 };
    const highTierProof = [
      proofPoint(1_000, 990),
      proofPoint(100_000, 99_000),
      proofPoint(1_000_000, 990_000),
      proofPoint(10_000_000, 9_900_000),
      proofPoint(25_000_000, 24_750_000),
    ];
    const highTvlProfile = {
      ...profile(nowSec),
      retainedTvlUsdAtQuote: 3_000_000,
      quoteProof: highTierProof,
      marginalOutputRatio: 0.99,
      capacityCurve: buildDexMeasuredCapacityCurve(highTierProof, 3_000_000),
    };

    expect(highTvlProfile.capacityCurve.map((point) => point.executableUsd)).toEqual([
      100_000,
      1_000_000,
      1_000_000,
      1_000_000,
    ]);
    expect(validateDexMeasuredExecutionProfile(validationInput(highTvlProfile, nowSec, {
      quotedTarget: highTvlTarget, currentTarget: highTvlTarget,
    }))).toEqual([]);
  });

  it("accepts a deterministic upper-probe revert as a capacity bracket", () => {
    const nowSec = 10_000;
    const revertedProfile = profile(nowSec);
    revertedProfile.quoteProof = [proofPoint(1_000, 999), revertedProofPoint(100_000)];
    revertedProfile.capacityCurve = buildDexMeasuredCapacityCurve(
      revertedProfile.quoteProof,
      revertedProfile.retainedTvlUsdAtQuote,
    );

    expect(revertedProfile.capacityCurve.map((point) => point.executableUsd)).toEqual([1_000, 1_000, 1_000, 1_000]);
    expect(validateDexMeasuredExecutionProfile(validationInput(revertedProfile, nowSec))).toEqual([]);
  });

  it("accepts a deterministic marginal revert as measured zero capacity", () => {
    const nowSec = 10_000;
    const revertedProfile = profile(nowSec);
    revertedProfile.quoteProof = [revertedProofPoint(1_000)];
    revertedProfile.marginalOutputRatio = 0;
    revertedProfile.capacityCurve = buildDexMeasuredCapacityCurve(
      revertedProfile.quoteProof,
      revertedProfile.retainedTvlUsdAtQuote,
    );

    expect(revertedProfile.capacityCurve.every((point) => point.executableUsd === 0)).toBe(true);
    expect(validateDexMeasuredExecutionProfile(validationInput(revertedProfile, nowSec))).toEqual([]);
  });

  it("rejects a reverted proof with synthetic fields that do not match zero execution", () => {
    const nowSec = 10_000;
    const tampered = profile(nowSec);
    tampered.quoteProof = [revertedProofPoint(1_000)];
    tampered.quoteProof[0]!.amountOutRaw = "1";
    tampered.marginalOutputRatio = 0;
    tampered.capacityCurve = buildDexMeasuredCapacityCurve(tampered.quoteProof, tampered.retainedTvlUsdAtQuote);

    expect(validateDexMeasuredExecutionProfile(validationInput(tampered, nowSec))).toContain("invalid-quote-proof");
  });

  it("projects raw calldata and return proofs out of the public profile", () => {
    const internal = profile();
    internal.poolBindingProof = {
      factoryAddress: "0x5555555555555555555555555555555555555555",
      factoryCodeHash: `0x${"cd".repeat(32)}`,
      resolvedPoolAddress: internal.poolId as `0x${string}`,
      callData: "0x1234",
      returnData: "0xabcd",
    };

    const publicProfile = toDexMeasuredExecutionPublicProfile(internal);

    expect(publicProfile).not.toHaveProperty("quoteProof");
    expect(publicProfile).not.toHaveProperty("poolBindingProof");
    expect(publicProfile.poolProvenance).toEqual({
      factoryAddress: internal.poolBindingProof.factoryAddress,
      factoryCodeHash: internal.poolBindingProof.factoryCodeHash,
      resolvedPoolAddress: internal.poolBindingProof.resolvedPoolAddress,
    });
  });

  it("projects raw registry binding proof into proof-free registry provenance", () => {
    const internal = profile();
    internal.registryBindingProof = {
      registryAddress: "0x5555555555555555555555555555555555555555",
      registryCodeHash: `0x${"cd".repeat(32)}`,
      registeredPoolAddress: internal.poolId as `0x${string}`,
      lpTokenAddress: "0x6666666666666666666666666666666666666666",
      poolTokenAddresses: [TOKEN_IN.address, TOKEN_OUT.address],
      lpTokenCallData: "0x1234",
      lpTokenReturnData: "0xabcd",
      registryCoinsCallData: "0x2345",
      registryCoinsReturnData: "0xbcde",
      poolCoinsProof: [
        { index: 0, callData: "0x3456", returnData: "0xcdef" },
        { index: 1, callData: "0x4567", returnData: "0xdef0" },
      ],
      tokenDecimalsProof: [
        { tokenAddress: TOKEN_IN.address, decimals: TOKEN_IN.decimals, callData: "0x5678", returnData: "0xef01" },
        { tokenAddress: TOKEN_OUT.address, decimals: TOKEN_OUT.decimals, callData: "0x6789", returnData: "0xf012" },
      ],
    };

    const publicProfile = toDexMeasuredExecutionPublicProfile(internal);

    expect(publicProfile).not.toHaveProperty("registryBindingProof");
    expect(publicProfile.registryProvenance).toEqual({
      registryAddress: internal.registryBindingProof.registryAddress,
      registryCodeHash: internal.registryBindingProof.registryCodeHash,
      registeredPoolAddress: internal.registryBindingProof.registeredPoolAddress,
      lpTokenAddress: internal.registryBindingProof.lpTokenAddress,
      poolTokenAddresses: internal.registryBindingProof.poolTokenAddresses,
    });
  });

  it("projects raw StableSwap-NG factory proof into pinned proof-free provenance", () => {
    const internal = profile();
    internal.stableSwapNgFactoryBindingProof = {
      blockNumber: internal.blockNumber,
      blockHash: `0x${"ef".repeat(32)}`,
      blockCommitment: "finalized",
      factoryAddress: "0x5555555555555555555555555555555555555555",
      factoryCodeHash: `0x${"cd".repeat(32)}`,
      poolIndex: 563,
      registeredPoolAddress: internal.poolId as `0x${string}`,
      poolTokenAddresses: [TOKEN_IN.address, TOKEN_OUT.address],
      poolListCallData: "0x1234",
      poolListReturnData: "0xabcd",
      factoryCoinsCallData: "0x2345",
      factoryCoinsReturnData: "0xbcde",
      poolCoinsProof: [
        { index: 0, callData: "0x3456", returnData: "0xcdef" },
        { index: 1, callData: "0x4567", returnData: "0xdef0" },
      ],
      tokenDecimalsProof: [
        { tokenAddress: TOKEN_IN.address, decimals: TOKEN_IN.decimals, callData: "0x5678", returnData: "0xef01" },
        { tokenAddress: TOKEN_OUT.address, decimals: TOKEN_OUT.decimals, callData: "0x6789", returnData: "0xf012" },
      ],
    };

    const publicProfile = toDexMeasuredExecutionPublicProfile(internal);

    expect(publicProfile).not.toHaveProperty("stableSwapNgFactoryBindingProof");
    expect(publicProfile.stableSwapNgFactoryProvenance).toEqual({
      blockNumber: internal.stableSwapNgFactoryBindingProof.blockNumber,
      blockHash: internal.stableSwapNgFactoryBindingProof.blockHash,
      blockCommitment: internal.stableSwapNgFactoryBindingProof.blockCommitment,
      factoryAddress: internal.stableSwapNgFactoryBindingProof.factoryAddress,
      factoryCodeHash: internal.stableSwapNgFactoryBindingProof.factoryCodeHash,
      poolIndex: internal.stableSwapNgFactoryBindingProof.poolIndex,
      registeredPoolAddress: internal.stableSwapNgFactoryBindingProof.registeredPoolAddress,
      poolTokenAddresses: internal.stableSwapNgFactoryBindingProof.poolTokenAddresses,
    });
  });

  it("fails closed on stale, tampered, and price-divergent profiles", () => {
    const nowSec = 20_000;
    const tampered = profile(nowSec);
    tampered.quotedAt = nowSec - 10_801;
    tampered.marginalOutputRatio = 0.95;
    tampered.quoteProof[0]!.amountOutRaw = "1030000000";
    tampered.capacityCurve[0]!.executableUsd = 99_999;
    expect(validateDexMeasuredExecutionProfile(validationInput(tampered, nowSec))).toEqual(expect.arrayContaining([
      "stale-observation",
      "quote-price-mismatch",
      "invalid-capacity-curve",
    ]));
  });

  it("gives every measured adapter the shared three-hour profile ceiling", () => {
    const nowSec = 20_000;
    const adapterProfileId = DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwap;
    const targetId = buildDexMeasuredExecutionTargetId({
      adapterProfileId,
      stablecoinId: "usd1",
      chain: "ethereum",
      protocol: "uniswap-v3",
      poolId: "0x3333333333333333333333333333333333333333",
      tokenInAddress: TOKEN_IN.address,
      tokenOutAddress: TOKEN_OUT.address,
      feePips: 500,
    });
    const currentTarget = {
      ...target(nowSec),
      targetId,
      adapterProfileId,
      capturedAt: nowSec - 11_600,
    };
    const retainedProfile = {
      ...profile(nowSec),
      targetId,
      adapterProfileId,
      quotedAt: nowSec - 10_799,
    };

    // Three hours, one publication cycle wider than the two-hour score-bearing
    // cadence, so a single missed even-hour `:16` publication cannot expire
    // every measured profile at once.
    expect(getDexMeasuredExecutionFreshnessMaxSec(adapterProfileId)).toBe(10_800);
    expect(getDexMeasuredExecutionFreshnessMaxSec(DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwapNg)).toBe(10_800);
    expect(getDexMeasuredExecutionFreshnessMaxSec("uniswap-v3-quoter-v2")).toBe(10_800);
    expect(validateDexMeasuredExecutionProfile(validationInput(retainedProfile, nowSec, {
      quotedTarget: currentTarget, currentTarget,
    }))).not.toContain("stale-observation");
    expect(validateDexMeasuredExecutionProfile(validationInput({ ...retainedProfile, quotedAt: nowSec - 10_801 }, nowSec, {
      quotedTarget: currentTarget, currentTarget,
    }))).toContain("stale-observation");
  });
});
