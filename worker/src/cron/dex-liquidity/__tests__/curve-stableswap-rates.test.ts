import { describe, expect, it, vi } from "vitest";
import { encodeFunctionResult, parseAbi } from "viem/utils";

import { initMetrics } from "../pool-helpers";
import {
  CURVE_STABLESWAP_RATE_CAPTURE_MAX_AGE_SEC,
  enrichCurveStableswapRateInputExecutionModels,
} from "../curve-stableswap-rates";
import type { CurveStableswapRateInputExecutionCandidate, PoolEntry } from "../types";

const DOLA = "0x865377367054516e17014ccded1e7d814edc9ce4" as const;
const SUSDE = "0x9d39a5de30e57443bff2a8307a4256c8797a3497" as const;
const POOL = "0x744793b5110f6ca9cc7cdfe1ce16677c3eb192ef" as const;
const BLOCK_NUMBER = 25_618_327;
const BLOCK_TIMESTAMP = 1_784_970_583;
const BLOCK_HASH = `0x${"11".repeat(32)}` as const;

const POOL_ABI = parseAbi([
  "function get_balances() view returns (uint256[])",
  "function stored_rates() view returns (uint256[])",
  "function A() view returns (uint256)",
  "function coins(uint256) view returns (address)",
]);

const candidate: CurveStableswapRateInputExecutionCandidate = {
  poolAddress: POOL,
  coins: [
    { address: DOLA, symbol: "DOLA", decimals: 18, referencePriceUsd: 0.996 },
    { address: SUSDE, symbol: "sUSDe", decimals: 18, referencePriceUsd: 1.24 },
  ],
};

function stateResults(calls: readonly { label: string }[], overrides: {
  rates?: bigint[];
  coinAddresses?: readonly `0x${string}`[];
} = {}) {
  const rates = overrides.rates ?? [10n ** 18n, 1_240_000_000_000_000_000n];
  const coinAddresses = overrides.coinAddresses ?? [DOLA, SUSDE];
  return calls.map((call) => {
    if (call.label.endsWith("-balances")) {
      return {
        label: call.label,
        success: true,
        returnData: encodeFunctionResult({
          abi: POOL_ABI,
          functionName: "get_balances",
          result: [30_000_000n * 10n ** 18n, 6_000_000n * 10n ** 18n],
        }),
      };
    }
    if (call.label.endsWith("-rates")) {
      return {
        label: call.label,
        success: true,
        returnData: encodeFunctionResult({ abi: POOL_ABI, functionName: "stored_rates", result: rates }),
      };
    }
    if (call.label.endsWith("-A")) {
      return {
        label: call.label,
        success: true,
        returnData: encodeFunctionResult({ abi: POOL_ABI, functionName: "A", result: 750n }),
      };
    }
    const match = call.label.match(/-coin-(\d+)$/);
    if (!match) throw new Error(`unexpected call ${call.label}`);
    const index = Number(match[1]);
    return {
      label: call.label,
      success: true,
      returnData: encodeFunctionResult({
        abi: POOL_ABI,
        functionName: "coins",
        result: coinAddresses[index]!,
      }),
    };
  });
}

function poolEntry(overrides: Partial<PoolEntry["extra"]> = {}): PoolEntry {
  return {
    poolId: `ethereum:${POOL}`,
    project: "curve",
    chain: "ethereum",
    tvlUsd: 38_000_000,
    symbol: "DOLA-sUSDe",
    volumeUsd1d: 1_000_000,
    poolType: "curve-stableswap",
    source: "dl",
    extra: {
      executionCapabilityGate: { family: "curve-stableswap", reason: "rate-bearing-inputs" },
      curveStableswapRateInputExecutionCandidate: candidate,
      ...overrides,
    },
  };
}

function metrics(pool = poolEntry()) {
  const metric = initMetrics("dola-inverse-finance", "DOLA");
  metric.topPools.push(pool);
  return new Map([[metric.stablecoinId, metric]]);
}

function dependencies(input: {
  header?: { timestamp: number; hash: `0x${string}` };
  confirmedHeader?: { timestamp: number; hash: `0x${string}` };
  rates?: bigint[];
  coinAddresses?: readonly `0x${string}`[];
} = {}) {
  const header = {
    number: BLOCK_NUMBER,
    timestamp: input.header?.timestamp ?? BLOCK_TIMESTAMP,
    hash: input.header?.hash ?? BLOCK_HASH,
  };
  const confirmed = {
    number: BLOCK_NUMBER,
    timestamp: input.confirmedHeader?.timestamp ?? header.timestamp,
    hash: input.confirmedHeader?.hash ?? header.hash,
  };
  return {
    fetchBlockNumber: vi.fn().mockResolvedValue(BLOCK_NUMBER),
    fetchBlockHeader: vi.fn()
      .mockResolvedValueOnce(header)
      .mockResolvedValueOnce(confirmed),
    fetchMulticall: vi.fn(async (_chain: string, calls: readonly { label: string }[]) =>
      stateResults(calls, { rates: input.rates, coinAddresses: input.coinAddresses }),
    ),
  };
}

const chainAddressToId = new Map([
  [`ethereum:${DOLA}`, "dola-inverse-finance"],
  [`ethereum:${SUSDE}`, "susde-ethena"],
]);

describe("Curve StableSwap-NG rate-input state capture", () => {
  it("uses same-block balances, rates, amplification, and coin order to build the scaled model", async () => {
    const state = dependencies();
    const pool = poolEntry();
    await enrichCurveStableswapRateInputExecutionModels({
      metrics: metrics(pool),
      chainAddressToId,
      chainRpcs: new Map([["ethereum", {} as never]]),
      nowSec: BLOCK_TIMESTAMP + 60,
      dependencies: state as never,
    });

    expect(state.fetchMulticall).toHaveBeenCalledWith(
      "ethereum",
      expect.arrayContaining([
        expect.objectContaining({ label: "curve-rate-0-balances", target: POOL }),
        expect.objectContaining({ label: "curve-rate-0-rates", target: POOL }),
        expect.objectContaining({ label: "curve-rate-0-A", target: POOL }),
        expect.objectContaining({ label: "curve-rate-0-coin-0", target: POOL }),
        expect.objectContaining({ label: "curve-rate-0-coin-1", target: POOL }),
      ]),
      BLOCK_NUMBER,
      expect.any(Object),
    );
    expect(state.fetchBlockHeader).toHaveBeenCalledTimes(2);
    expect(pool.extra?.curveStableswapRateInputExecutionCandidate).toBeUndefined();
    expect(pool.extra?.executionCapabilityGate).toBeUndefined();
    expect(pool.extra?.measurement).toMatchObject({ balanceMeasured: true });
    expect(pool.extra?.ammExecutionModel).toMatchObject({
      source: "curve",
      invariant: "stableswap",
      trackedTokenIndex: 0,
      amplification: 375,
      tokens: [
        { address: DOLA, balance: 30_000_000, referencePriceUsd: 0.996 },
        { address: SUSDE, balance: 7_440_000, referencePriceUsd: 1 },
      ],
    });
  });

  it("keeps the rate-bearing gate when the pinned rate array is incomplete", async () => {
    const state = dependencies({ rates: [10n ** 18n] });
    const pool = poolEntry();
    await enrichCurveStableswapRateInputExecutionModels({
      metrics: metrics(pool),
      chainAddressToId,
      chainRpcs: new Map([["ethereum", {} as never]]),
      nowSec: BLOCK_TIMESTAMP + 60,
      dependencies: state as never,
    });

    expect(pool.extra?.ammExecutionModel).toBeUndefined();
    expect(pool.extra?.curveStableswapRateInputExecutionCandidate).toBeUndefined();
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "curve-stableswap",
      reason: "rate-bearing-inputs",
    });
  });

  it("keeps the rate-bearing gate when every stored rate is the plain unit multiplier", async () => {
    const state = dependencies({ rates: [10n ** 18n, 10n ** 18n] });
    const pool = poolEntry();
    await enrichCurveStableswapRateInputExecutionModels({
      metrics: metrics(pool),
      chainAddressToId,
      chainRpcs: new Map([["ethereum", {} as never]]),
      nowSec: BLOCK_TIMESTAMP + 60,
      dependencies: state as never,
    });

    expect(pool.extra?.ammExecutionModel).toBeUndefined();
    expect(pool.extra?.curveStableswapRateInputExecutionCandidate).toBeUndefined();
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "curve-stableswap",
      reason: "rate-bearing-inputs",
    });
  });

  it("keeps the rate-bearing gate when coin order fails at the pinned block", async () => {
    const state = dependencies({ coinAddresses: [SUSDE, DOLA] });
    const pool = poolEntry();
    await enrichCurveStableswapRateInputExecutionModels({
      metrics: metrics(pool),
      chainAddressToId,
      chainRpcs: new Map([["ethereum", {} as never]]),
      nowSec: BLOCK_TIMESTAMP + 60,
      dependencies: state as never,
    });

    expect(pool.extra?.ammExecutionModel).toBeUndefined();
    expect(pool.extra?.curveStableswapRateInputExecutionCandidate).toBeUndefined();
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "curve-stableswap",
      reason: "rate-bearing-inputs",
    });
  });

  it("rejects a stale source-stage block before any multicall", async () => {
    const state = dependencies({
      header: { timestamp: BLOCK_TIMESTAMP - CURVE_STABLESWAP_RATE_CAPTURE_MAX_AGE_SEC - 1, hash: BLOCK_HASH },
    });
    const pool = poolEntry();
    await enrichCurveStableswapRateInputExecutionModels({
      metrics: metrics(pool),
      chainAddressToId,
      chainRpcs: new Map([["ethereum", {} as never]]),
      nowSec: BLOCK_TIMESTAMP,
      dependencies: state as never,
    });

    expect(state.fetchMulticall).not.toHaveBeenCalled();
    expect(pool.extra?.ammExecutionModel).toBeUndefined();
    expect(pool.extra?.curveStableswapRateInputExecutionCandidate).toBeUndefined();
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "curve-stableswap",
      reason: "rate-bearing-inputs",
    });
  });

  it("rejects the whole capture when the pinned block hash changes", async () => {
    const state = dependencies({
      confirmedHeader: { timestamp: BLOCK_TIMESTAMP, hash: `0x${"22".repeat(32)}` as `0x${string}` },
    });
    const pool = poolEntry();
    await enrichCurveStableswapRateInputExecutionModels({
      metrics: metrics(pool),
      chainAddressToId,
      chainRpcs: new Map([["ethereum", {} as never]]),
      nowSec: BLOCK_TIMESTAMP + 60,
      dependencies: state as never,
    });

    expect(state.fetchMulticall).toHaveBeenCalledTimes(1);
    expect(pool.extra?.ammExecutionModel).toBeUndefined();
    expect(pool.extra?.curveStableswapRateInputExecutionCandidate).toBeUndefined();
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "curve-stableswap",
      reason: "rate-bearing-inputs",
    });
  });

  it("does not replace an existing score-facing measured route", async () => {
    const state = dependencies();
    const pool = poolEntry({ measuredExecution: {} as never });
    await enrichCurveStableswapRateInputExecutionModels({
      metrics: metrics(pool),
      chainAddressToId,
      chainRpcs: new Map([["ethereum", {} as never]]),
      nowSec: BLOCK_TIMESTAMP + 60,
      dependencies: state as never,
    });

    expect(state.fetchBlockNumber).not.toHaveBeenCalled();
    expect(pool.extra?.curveStableswapRateInputExecutionCandidate).toBeUndefined();
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "curve-stableswap",
      reason: "rate-bearing-inputs",
    });
  });
});
