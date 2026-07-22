import { describe, expect, it, vi } from "vitest";

vi.mock("../quoter-v2", async () => {
  const actual = await vi.importActual<typeof import("../quoter-v2")>("../quoter-v2");
  return { ...actual, validateQuoterV2ProfileProof: vi.fn(() => []) };
});

import { buildDexMeasuredExecutionTargetId, type DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import type { PoolEntry } from "../../dex-liquidity/types";
import { joinDexMeasuredExecutionEvidence } from "../join";
import { buildDexMeasuredExecutionProfile } from "../profiles";
import { getDexMeasuredExecutionDeployment } from "../registry";
import {
  CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID,
  CURVE_CRYPTOSWAP_SHADOW_COHORT,
  encodeCurveCryptoSwapGetDy,
} from "../curve-cryptoswap";

function target(chain: string = "ethereum"): DexMeasuredExecutionTarget {
  const input = {
    schemaVersion: "dex-measured-target-v1" as const,
    stablecoinId: "usdc-circle",
    adapterProfileId: "uniswap-v3-quoter-v2",
    protocol: "uniswap-v3",
    chain,
    poolId: `${chain}:0x3333333333333333333333333333333333333333`,
    poolTokenAddresses: [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ] as [`0x${string}`, `0x${string}`],
    tokenIn: {
      address: "0x1111111111111111111111111111111111111111" as const,
      symbol: "USDC",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdc-circle",
    },
    tokenOut: {
      address: "0x2222222222222222222222222222222222222222" as const,
      symbol: "USDT",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdt-tether",
    },
    feePips: 100,
    retainedTvlUsd: 100_000,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_000,
  };
  return {
    ...input,
    targetId: buildDexMeasuredExecutionTargetId({
      adapterProfileId: input.adapterProfileId,
      stablecoinId: input.stablecoinId,
      chain: input.chain,
      protocol: input.protocol,
      poolId: input.poolId,
      tokenInAddress: input.tokenIn.address,
      tokenOutAddress: input.tokenOut.address,
      poolTokenAddresses: input.poolTokenAddresses,
      feePips: input.feePips,
    }),
  };
}

describe("measured execution join activation", () => {
  it("keeps a valid QuoterV2 profile score-ineligible while its cohort is in shadow", () => {
    // Optimism is a pinned deployment outside the 2026-07-17 ratified cohort,
    // so it exercises the activation-pending gate.
    const measuredTarget = target("optimism");
    const deployment = getDexMeasuredExecutionDeployment(measuredTarget.adapterProfileId, measuredTarget.chain);
    if (deployment == null) throw new Error("missing Optimism QuoterV2 deployment");
    const profile = buildDexMeasuredExecutionProfile({
      target: measuredTarget,
      targetGenerationId: "target-generation",
      quoteGenerationId: "quote-generation",
      quotedAt: 1_060,
      blockNumber: 25_536_894,
      endpointAddress: deployment.endpointAddress,
      endpointCodeHash: deployment.expectedCodeHash,
      points: [
        {
          amountInRaw: "1000000000",
          amountOutRaw: "970000000",
          callData: "0x01",
          returnData: "0x01",
          inputUsd: 1_000,
          outputUsd: 970,
          costBps: 300,
          passesCostBound: false,
        },
      ],
    });
    const pool: PoolEntry = {
      poolId: measuredTarget.poolId,
      project: measuredTarget.protocol,
      chain: measuredTarget.chain,
      tvlUsd: measuredTarget.retainedTvlUsd,
      symbol: "USDC-USDT",
      volumeUsd1d: 0,
      poolType: "uniswap-v3-1bp",
      source: "dl",
      extra: { measuredExecutionTarget: measuredTarget },
    };

    const diagnostics = joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, [pool]]]),
      evidence: {
        quoteGenerationId: "quote-generation",
        targetGenerationId: "target-generation",
        publishedAt: 1_060,
        byTargetId: new Map([
          [
            measuredTarget.targetId,
            {
              quotedTarget: measuredTarget,
              status: "measured",
              failureReason: null,
              profile,
            },
          ],
        ]),
      },
      nowSec: 1_060,
    });

    expect(pool.extra?.measuredExecution).toBeDefined();
    expect(pool.extra?.measuredExecution).not.toHaveProperty("quoteProof");
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "measured-execution",
      reason: "activation-pending",
    });
    expect(diagnostics).toMatchObject({ measuredCount: 1, gatedCount: 1 });
  });

  it("admits a valid proof from an active Curve CryptoSwap pool", () => {
    const policy = CURVE_CRYPTOSWAP_SHADOW_COHORT.find(
      (entry) => entry.poolAddress === "0x6e5492f8ea2370844ee098a56dd88e1717e4a9c2",
    );
    if (!policy?.expectedPoolCodeHash) throw new Error("missing active Curve policy");
    const amountInRaw = 1_000n * 10n ** 18n;
    const amountOutRaw = 400_000_000_000_000_000n;
    const tokenAddresses = [
      "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e",
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    ] as [`0x${string}`, `0x${string}`];
    const input = {
      schemaVersion: "dex-measured-target-v1" as const,
      stablecoinId: "crvusd-curve",
      adapterProfileId: CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID,
      protocol: "curve",
      chain: "ethereum",
      poolId: `ethereum:${policy.poolAddress}`,
      poolTokenAddresses: tokenAddresses,
      tokenIn: {
        address: tokenAddresses[0],
        symbol: "crvUSD",
        decimals: 18,
        referencePriceUsd: 1,
        trackedAssetId: "crvusd-curve",
      },
      tokenOut: {
        address: tokenAddresses[1],
        symbol: "WETH",
        decimals: 18,
        referencePriceUsd: 2_500,
      },
      retainedTvlUsd: 100_000,
      retainedPoolPriceUsd: 1,
      capturedAt: 1_000,
    };
    const measuredTarget: DexMeasuredExecutionTarget = {
      ...input,
      targetId: buildDexMeasuredExecutionTargetId({
        adapterProfileId: input.adapterProfileId,
        stablecoinId: input.stablecoinId,
        chain: input.chain,
        protocol: input.protocol,
        poolId: input.poolId,
        tokenInAddress: input.tokenIn.address,
        tokenOutAddress: input.tokenOut.address,
        poolTokenAddresses: input.poolTokenAddresses,
      }),
    };
    const callData = encodeCurveCryptoSwapGetDy({ inputIndex: 0, outputIndex: 1, amountInRaw });
    const returnData = `0x${amountOutRaw.toString(16).padStart(64, "0")}` as `0x${string}`;
    const profile = buildDexMeasuredExecutionProfile({
      target: measuredTarget,
      targetGenerationId: "target-generation",
      quoteGenerationId: "quote-generation",
      quotedAt: 1_060,
      blockNumber: 25_550_158,
      endpointAddress: policy.poolAddress,
      endpointCodeHash: policy.expectedPoolCodeHash,
      points: [
        {
          amountInRaw: amountInRaw.toString(),
          amountOutRaw: amountOutRaw.toString(),
          callData,
          returnData,
          inputUsd: 1_000,
          outputUsd: 1_000,
          costBps: 0,
          passesCostBound: true,
        },
        {
          amountInRaw: (100_000n * 10n ** 18n).toString(),
          amountOutRaw: (40n * 10n ** 18n).toString(),
          callData: encodeCurveCryptoSwapGetDy({
            inputIndex: 0,
            outputIndex: 1,
            amountInRaw: 100_000n * 10n ** 18n,
          }),
          returnData: `0x${(40n * 10n ** 18n).toString(16).padStart(64, "0")}`,
          inputUsd: 100_000,
          outputUsd: 100_000,
          costBps: 0,
          passesCostBound: true,
        },
      ],
    });
    const pool: PoolEntry = {
      poolId: measuredTarget.poolId,
      project: "curve",
      chain: "ethereum",
      tvlUsd: measuredTarget.retainedTvlUsd,
      symbol: "crvUSD-WETH",
      volumeUsd1d: 0,
      poolType: "curve-cryptoswap",
      source: "dl",
      extra: {
        measuredExecutionTarget: measuredTarget,
        executionCapabilityGate: { family: "measured-execution", reason: "target-unresolved" },
      },
    };

    const diagnostics = joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([[measuredTarget.stablecoinId, [pool]]]),
      evidence: {
        quoteGenerationId: "quote-generation",
        targetGenerationId: "target-generation",
        publishedAt: 1_060,
        byTargetId: new Map([[measuredTarget.targetId, {
          quotedTarget: measuredTarget,
          status: "measured",
          failureReason: null,
          profile,
        }]]),
      },
      nowSec: 1_060,
    });

    expect(diagnostics).toMatchObject({ measuredCount: 1, gatedCount: 0 });
    expect(pool.extra?.measuredExecution).toBeDefined();
    expect(pool.extra?.executionCapabilityGate).toBeUndefined();
  });
});
