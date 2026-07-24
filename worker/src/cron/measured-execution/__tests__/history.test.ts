import { describe, expect, it } from "vitest";
import type { DexMeasuredExecutionProfile } from "@shared/types/measured-execution";
import { summarizeDexMeasuredExecutionHistory, type DexMeasuredExecutionHistoryCycle } from "../history";

function profile(
  generationId: string,
  quotedAt: number,
  executableUsd: readonly number[],
  executionCostBps: readonly number[] = [10, 20, 30, 40],
): DexMeasuredExecutionProfile {
  const notionals = [100_000, 1_000_000, 10_000_000, 25_000_000] as const;
  const quoteProof = [...new Map(executableUsd.map((inputUsd, index) => [
    inputUsd,
    {
      amountInRaw: String(Math.round(inputUsd * 1_000_000)),
      amountOutRaw: String(Math.round(inputUsd * (1 - executionCostBps[index]! / 10_000) * 1_000_000)),
      callData: "0x01",
      returnData: "0x01",
      inputUsd,
      outputUsd: inputUsd * (1 - executionCostBps[index]! / 10_000),
      costBps: executionCostBps[index]!,
      passesCostBound: true,
    },
  ] as const)).values()];
  return {
    schemaVersion: "dex-measured-execution-v1",
    kind: "measured-executable-depth",
    targetId: "target",
    targetGenerationId: `target-${generationId}`,
    quoteGenerationId: generationId,
    adapterProfileId: "uniswap-v3-quoter-v2",
    protocol: "uniswap-v3",
    chain: "Ethereum",
    poolId: "0x1111111111111111111111111111111111111111",
    tokenIn: {
      address: "0x2222222222222222222222222222222222222222",
      symbol: "USDC",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdc-circle",
    },
    tokenOut: {
      address: "0x3333333333333333333333333333333333333333",
      symbol: "USDT",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdt-tether",
    },
    retainedTvlUsdAtQuote: 50_000_000,
    retainedPoolPriceUsdAtQuote: 1,
    quotedAt,
    blockNumber: 1,
    executionEndpoint: {
      address: "0x4444444444444444444444444444444444444444",
      codeHash: `0x${"1".repeat(64)}`,
    },
    maxCostBps: 200,
    marginalOutputRatio: 1,
    capacityCurve: notionals.map((requestedNotionalUsd, index) => ({
      requestedNotionalUsd,
      maxCostBps: 200,
      executableUsd: executableUsd[index]!,
      completionRatio: executableUsd[index]! / requestedNotionalUsd,
    })),
    quoteProof,
  };
}

function measured(
  generationId: string,
  publishedAt: number,
  values: readonly number[],
  executionCostBps?: readonly number[],
): DexMeasuredExecutionHistoryCycle {
  return {
    generationId,
    publishedAt,
    status: "measured",
    operationalFailure: false,
    profile: profile(generationId, publishedAt, values, executionCostBps),
  };
}

describe("summarizeDexMeasuredExecutionHistory", () => {
  it("uses the pointwise minimum across complete successful cycles", () => {
    const result = summarizeDexMeasuredExecutionHistory({
      nowSec: 2_000,
      freshnessMaxSec: 1_000,
      cycles: [
        measured("g3", 1_900, [100_000, 900_000, 8_000_000, 9_000_000], [10, 20, 30, 40]),
        measured("g2", 1_700, [90_000, 1_000_000, 7_000_000, 10_000_000], [15, 5, 35, 10]),
        measured("g1", 1_500, [100_000, 800_000, 9_000_000, 8_000_000], [12, 25, 15, 45]),
      ],
    });

    expect(result).toMatchObject({
      completeProducerCycleCount: 3,
      successfulObservationCount: 3,
      consecutiveSuccessCount: 3,
      conservativeStatistic: "pointwise-minimum",
    });
    expect(result?.conservativeCapacityCurve.map((point) => point.executableUsd)).toEqual([
      90_000,
      800_000,
      7_000_000,
      8_000_000,
    ]);
    // The profiles prove different defining capacities and do not all retain a
    // quote at the emitted pointwise minimum, so cost fails back to the bound.
    expect(result?.conservativeCapacityCurve.map((point) => point.executionCostBps)).toEqual([
      200,
      200,
      200,
      200,
    ]);
  });

  it("uses the maximum realized cost when every cycle proves the emitted capacity", () => {
    const result = summarizeDexMeasuredExecutionHistory({
      nowSec: 2_000,
      freshnessMaxSec: 1_000,
      cycles: [
        measured("g2", 1_900, [100_000, 900_000, 8_000_000, 9_000_000], [10, 40, 30, 45]),
        measured("g1", 1_700, [100_000, 900_000, 8_000_000, 9_000_000], [15, 20, 35, 25]),
      ],
    });

    expect(result?.conservativeCapacityCurve.map((point) => point.executionCostBps)).toEqual([
      15,
      40,
      35,
      45,
    ]);
  });

  it("records an operational interruption without treating it as measured depth", () => {
    const result = summarizeDexMeasuredExecutionHistory({
      nowSec: 2_000,
      freshnessMaxSec: 1_000,
      cycles: [
        {
          generationId: "g3",
          publishedAt: 1_900,
          status: "failed",
          operationalFailure: true,
          profile: null,
        },
        measured("g2", 1_700, [100_000, 1_000_000, 8_000_000, 10_000_000]),
        measured("g1", 1_500, [100_000, 900_000, 7_000_000, 9_000_000]),
      ],
    });

    expect(result).toMatchObject({
      completeProducerCycleCount: 3,
      successfulObservationCount: 2,
      consecutiveSuccessCount: 0,
      latestOperationalFailureAt: 1_900,
    });
  });

  it("ignores cycles outside the explicit freshness window", () => {
    const result = summarizeDexMeasuredExecutionHistory({
      nowSec: 2_000,
      freshnessMaxSec: 300,
      cycles: [
        measured("g2", 1_900, [100_000, 1_000_000, 8_000_000, 10_000_000]),
        measured("g1", 1_600, [50_000, 500_000, 5_000_000, 5_000_000]),
      ],
    });

    expect(result?.successfulObservationCount).toBe(1);
    expect(result?.observationWindowStartedAt).toBe(1_900);
  });

  it("returns null when no fresh success exists", () => {
    expect(
      summarizeDexMeasuredExecutionHistory({
        nowSec: 2_000,
        freshnessMaxSec: 300,
        cycles: [
          {
            generationId: "g1",
            publishedAt: 1_900,
            status: "failed",
            operationalFailure: true,
            profile: null,
          },
        ],
      }),
    ).toBeNull();
  });

  it("resets successful maturity after a deterministic route failure", () => {
    const result = summarizeDexMeasuredExecutionHistory({
      nowSec: 2_000,
      freshnessMaxSec: 1_000,
      cycles: [
        measured("g3", 1_900, [100_000, 900_000, 8_000_000, 9_000_000]),
        {
          generationId: "g2",
          publishedAt: 1_700,
          status: "failed",
          operationalFailure: false,
          profile: null,
        },
        measured("g1", 1_500, [50_000, 500_000, 5_000_000, 5_000_000]),
      ],
    });

    expect(result).toMatchObject({
      completeProducerCycleCount: 2,
      successfulObservationCount: 1,
      consecutiveSuccessCount: 1,
      observationWindowStartedAt: 1_700,
    });
    expect(result?.conservativeCapacityCurve.map((point) => point.executableUsd)).toEqual([
      100_000,
      900_000,
      8_000_000,
      9_000_000,
    ]);
  });

  it("deduplicates producer generations before counting maturity", () => {
    const cycle = measured("g1", 1_900, [100_000, 900_000, 8_000_000, 9_000_000]);
    const result = summarizeDexMeasuredExecutionHistory({
      nowSec: 2_000,
      freshnessMaxSec: 1_000,
      cycles: [cycle, cycle],
    });

    expect(result).toMatchObject({
      completeProducerCycleCount: 1,
      successfulObservationCount: 1,
      consecutiveSuccessCount: 1,
    });
  });
});
