import { describe, expect, it } from "vitest";

import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import { decodeMeasuredLedgerRecord, encodeMeasuredLedgerRecord } from "@shared/lib/measured-execution-ledger";
import type { DexMeasuredRawQuotePoint } from "../profiles";
import { buildMeasuredShadowQuoteLedgerRecord } from "../sync";

function target(overrides: Partial<DexMeasuredExecutionTarget> = {}): DexMeasuredExecutionTarget {
  return {
    schemaVersion: "dex-measured-target-v1",
    targetId: `target-${overrides.poolId ?? "default"}-${overrides.stablecoinId ?? "usdt-tether"}`,
    stablecoinId: "usdt-tether",
    adapterProfileId: "curve-stableswap-ng-metapool-underlying-v1",
    protocol: "curve",
    chain: "ethereum",
    poolId: "ethereum:0x1111111111111111111111111111111111111111",
    tokenIn: {
      address: "0x2222222222222222222222222222222222222222",
      symbol: "USDT",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdt-tether",
    },
    tokenOut: {
      address: "0x3333333333333333333333333333333333333333",
      symbol: "USDC",
      decimals: 6,
      referencePriceUsd: 1,
    },
    retainedTvlUsd: 1_000_000,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_755_500_000,
    ...overrides,
  };
}

function point(
  inputUsd: number,
  costBps: number,
  passesCostBound = costBps <= 200,
  reverted?: true,
): DexMeasuredRawQuotePoint {
  return {
    amountInRaw: String(Math.round(inputUsd * 1_000_000)),
    amountOutRaw: reverted ? "0" : String(Math.round(inputUsd * 1_000_000 * (1 - costBps / 10_000))),
    callData: "0xabcdef",
    returnData: "0x1234",
    inputUsd,
    outputUsd: reverted ? 0 : inputUsd * (1 - costBps / 10_000),
    costBps,
    passesCostBound,
    ...(reverted ? { reverted } : {}),
  };
}

describe("buildMeasuredShadowQuoteLedgerRecord", () => {
  it("classifies measured, failed, and both budget-deferred stop paths per cohort", () => {
    const record = buildMeasuredShadowQuoteLedgerRecord({
      cycle: 1_755_590_200,
      targetGenerationId: "dex-shadow-measured-targets-1",
      quoteGenerationId: "dex-shadow-measured-quotes-1",
      outcomes: [
        {
          target: target({ poolId: "ethereum:0x1111111111111111111111111111111111111111" }),
          status: "measured",
          points: [point(1_000, 4), point(25_000, 9)],
        },
        {
          target: target({ poolId: "ethereum:0x4444444444444444444444444444444444444444" }),
          status: "failed",
          failureReason: "profile-validation:invalid-quote-proof",
          points: [],
        },
        {
          target: target({ poolId: "ethereum:0x5555555555555555555555555555555555555555" }),
          status: "failed",
          failureReason: "budget-deferred",
          points: [],
        },
        {
          target: target({ poolId: "ethereum:0x6666666666666666666666666666666666666666" }),
          status: "failed",
          failureReason: "request-budget-exhausted",
          points: [],
        },
        {
          target: target({ poolId: "ethereum:0x7777777777777777777777777777777777777777" }),
          status: "failed",
          failureReason: "runtime-deadline-exceeded",
          points: [point(1_000, 4)],
        },
      ],
    });

    expect(record.kind).toBe("B");
    expect(record.targetGenerationId).toBe("dex-shadow-measured-targets-1");
    expect(record.quoteGenerationId).toBe("dex-shadow-measured-quotes-1");
    expect(Object.keys(record.cohorts)).toHaveLength(5);
    expect(record.cohorts["ethereum:11111111:usdt-tether"]).toMatchObject({
      measured: 1,
      failed: 0,
      budgetDeferred: 0,
    });
    expect(record.cohorts["ethereum:44444444:usdt-tether"]).toMatchObject({ measured: 0, failed: 1, budgetDeferred: 0 });
    expect(record.cohorts["ethereum:55555555:usdt-tether"]).toMatchObject({ failed: 0, budgetDeferred: 1 });
    expect(record.cohorts["ethereum:66666666:usdt-tether"]).toMatchObject({ failed: 0, budgetDeferred: 1 });
    expect(record.cohorts["ethereum:77777777:usdt-tether"]).toMatchObject({ failed: 0, budgetDeferred: 1 });
  });

  it("keeps sibling policies sharing one adapter profile and chain in separate cohorts", () => {
    const record = buildMeasuredShadowQuoteLedgerRecord({
      cycle: 1_755_590_200,
      targetGenerationId: "gen",
      quoteGenerationId: "quotes",
      outcomes: [
        {
          target: target({
            poolId: "ethereum:0x1111111111111111111111111111111111111111",
            stablecoinId: "usd1-world-liberty-financial",
          }),
          status: "measured",
          points: [point(1_000, 4)],
        },
        {
          target: target({
            poolId: "ethereum:0x9999999999999999999999999999999999999999",
            stablecoinId: "nxusd-nereus",
          }),
          status: "failed",
          failureReason: "quote-failed",
          points: [],
        },
      ],
    });
    expect(record.cohorts["ethereum:11111111:usd1-world-l"]).toMatchObject({ measured: 1 });
    expect(record.cohorts["ethereum:99999999:nxusd-nereus"]).toMatchObject({ failed: 1 });
  });

  it("computes monotonicity and cost-bound violations from the quote ladders at emission time", () => {
    const record = buildMeasuredShadowQuoteLedgerRecord({
      cycle: 1_755_590_200,
      targetGenerationId: "gen",
      quoteGenerationId: "quotes",
      outcomes: [
        {
          // Cost drops 40 -> 12 bps as notional grows: one monotonicity violation.
          target: target({ poolId: "ethereum:0x1111111111111111111111111111111111111111" }),
          status: "measured",
          points: [point(1_000, 40), point(25_000, 12), point(100_000, 60)],
        },
        {
          // Flag says passing above the 200bps bound, and a revert kept a passing flag.
          target: target({ poolId: "ethereum:0x4444444444444444444444444444444444444444" }),
          status: "measured",
          points: [point(1_000, 250, true), point(25_000, 10_000, true, true)],
        },
        {
          // Healthy ladder with a consistent total-loss revert tail.
          target: target({ poolId: "ethereum:0x5555555555555555555555555555555555555555" }),
          status: "measured",
          points: [point(1_000, 4), point(25_000, 199), point(100_000, 10_000, false, true)],
        },
      ],
    });
    expect(record.cohorts["ethereum:11111111:usdt-tether"]).toMatchObject({
      monotonicityViolations: 1,
      costBoundViolations: 0,
    });
    expect(record.cohorts["ethereum:44444444:usdt-tether"]).toMatchObject({
      monotonicityViolations: 0,
      costBoundViolations: 2,
    });
    expect(record.cohorts["ethereum:55555555:usdt-tether"]).toMatchObject({
      monotonicityViolations: 0,
      costBoundViolations: 0,
    });
  });

  it("emits a valid empty record for a zero-target generation and survives the chunk codec", () => {
    const record = buildMeasuredShadowQuoteLedgerRecord({
      cycle: 1_755_590_200,
      targetGenerationId: null,
      quoteGenerationId: null,
      outcomes: [],
    });
    expect(record.cohorts).toEqual({});
    expect(decodeMeasuredLedgerRecord(encodeMeasuredLedgerRecord(record))).toEqual(record);
  });
});
