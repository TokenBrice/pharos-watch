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

function target(): DexMeasuredExecutionTarget {
  const input = {
    schemaVersion: "dex-measured-target-v1" as const,
    stablecoinId: "usdc-circle",
    adapterProfileId: "uniswap-v3-quoter-v2",
    protocol: "uniswap-v3",
    chain: "ethereum",
    poolId: "ethereum:0x3333333333333333333333333333333333333333",
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
    const measuredTarget = target();
    const deployment = getDexMeasuredExecutionDeployment(measuredTarget.adapterProfileId, measuredTarget.chain);
    if (deployment == null) throw new Error("missing Ethereum QuoterV2 deployment");
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
              rawPayload: null,
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
});
