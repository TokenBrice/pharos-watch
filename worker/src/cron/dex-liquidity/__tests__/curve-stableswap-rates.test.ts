import { describe, expect, it, vi } from "vitest";
import { encodeFunctionResult, parseAbi } from "viem/utils";

import { initMetrics } from "../pool-helpers";
import {
  CURVE_STABLESWAP_RATE_CAPTURE_MAX_AGE_SEC,
  enrichCurveStableswapRateInputExecutionModels,
} from "../curve-stableswap-rates";
import type { CurveStableswapRateInputExecutionCandidate, PoolEntry } from "../types";

// Captured from the Ethereum Curve factory-stable-ng sfrxUSD/frxUSD pool.
const SFRXUSD = "0xcf62f905562626cfcdd2261162a51fd02fc9c5b6" as const;
const FRXUSD = "0xcacd6fd266af91b8aed52accc382b4e165586e29" as const;
const POOL = "0xf292eb6c5dcb693eaaf392d0562a01c3710e5978" as const;
const BLOCK_NUMBER = 25_626_087;
const BLOCK_TIMESTAMP = 1_785_178_691;
const BLOCK_HASH = "0x0305aed7bdf9bb7711ac23ad7322cd7569380b004b56408b4bec0a4a7a7eaf82" as const;
const PINNED_BALANCES = [6_226_811_020_583_753_593_486_721n, 4_346_120_891_108_167_689_089_439n];
const PINNED_RATES = [1_203_657_319_587_784_076n, 1_000_000_000_000_000_000n];
const PINNED_AMPLIFICATION = 10_000n;
const PINNED_FEE = 1_000_000n;
const PINNED_OFFPEG_FEE_MULTIPLIER = 10_000_000_000n;

const POOL_ABI = parseAbi([
  "function get_balances() view returns (uint256[])",
  "function stored_rates() view returns (uint256[])",
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function offpeg_fee_multiplier() view returns (uint256)",
  "function coins(uint256) view returns (address)",
]);

const candidate: CurveStableswapRateInputExecutionCandidate = {
  poolAddress: POOL,
  coins: [
    { address: SFRXUSD, symbol: "sfrxUSD", decimals: 18, referencePriceUsd: 1.2038465312792253 },
    { address: FRXUSD, symbol: "frxUSD", decimals: 18, referencePriceUsd: 1.000155068994295 },
  ],
};

function stateResults(calls: readonly { label: string }[], overrides: {
  rates?: bigint[];
  fee?: bigint;
  offpegFeeMultiplier?: bigint;
  coinAddresses?: readonly `0x${string}`[];
} = {}) {
  const rates = overrides.rates ?? PINNED_RATES;
  const fee = overrides.fee ?? PINNED_FEE;
  const offpegFeeMultiplier = overrides.offpegFeeMultiplier ?? PINNED_OFFPEG_FEE_MULTIPLIER;
  const coinAddresses = overrides.coinAddresses ?? [SFRXUSD, FRXUSD];
  return calls.map((call) => {
    if (call.label.endsWith("-balances")) {
      return {
        label: call.label,
        success: true,
        returnData: encodeFunctionResult({
          abi: POOL_ABI,
          functionName: "get_balances",
          result: PINNED_BALANCES,
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
        returnData: encodeFunctionResult({ abi: POOL_ABI, functionName: "A", result: PINNED_AMPLIFICATION }),
      };
    }
    if (call.label.endsWith("-fee")) {
      return {
        label: call.label,
        success: true,
        returnData: encodeFunctionResult({ abi: POOL_ABI, functionName: "fee", result: fee }),
      };
    }
    if (call.label.endsWith("-offpeg-fee-multiplier")) {
      return {
        label: call.label,
        success: true,
        returnData: encodeFunctionResult({
          abi: POOL_ABI,
          functionName: "offpeg_fee_multiplier",
          result: offpegFeeMultiplier,
        }),
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
    tvlUsd: 11_842_920,
    symbol: "sfrxUSD-frxUSD",
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
  const metric = initMetrics("frxusd-frax", "frxUSD");
  metric.topPools.push(pool);
  return new Map([[metric.stablecoinId, metric]]);
}

function dependencies(input: {
  header?: { timestamp: number; hash: `0x${string}` };
  confirmedHeader?: { timestamp: number; hash: `0x${string}` };
  rates?: bigint[];
  fee?: bigint;
  offpegFeeMultiplier?: bigint;
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
      stateResults(calls, {
        rates: input.rates,
        fee: input.fee,
        offpegFeeMultiplier: input.offpegFeeMultiplier,
        coinAddresses: input.coinAddresses,
      }),
    ),
  };
}

const chainAddressToId = new Map([[`ethereum:${FRXUSD}`, "frxusd-frax"]]);

describe("Curve StableSwap-NG rate-input state capture", () => {
  it("builds the scaled model from a recorded same-block static-fee state", async () => {
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
        expect.objectContaining({ label: "curve-rate-0-fee", target: POOL }),
        expect.objectContaining({ label: "curve-rate-0-offpeg-fee-multiplier", target: POOL }),
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
    const model = pool.extra?.ammExecutionModel;
    expect(model).toMatchObject({
      source: "curve",
      invariant: "stableswap",
      trackedTokenIndex: 1,
      amplification: 5_000,
      feeRate: 0.0001,
      tokens: [
        { address: SFRXUSD, symbol: "sfrxUSD" },
        { address: FRXUSD, symbol: "frxUSD", trackedAssetId: "frxusd-frax" },
      ],
    });
    expect(model?.tokens[0]?.balance).toBeCloseTo(7_494_946.662615514, 6);
    expect(model?.tokens[0]?.referencePriceUsd).toBeCloseTo(1.0001571973088703, 12);
    expect(model?.tokens[1]?.balance).toBeCloseTo(4_346_120.891108167, 6);
    expect(model?.tokens[1]?.referencePriceUsd).toBeCloseTo(1.000155068994295, 12);
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

  it("prices a dynamic off-peg pool at its off-balance maximum fee", async () => {
    // Live StableSwap-NG pools publish multipliers of 2x-20x; the captured
    // model carries fee * multiplier so the exit capacity stays a lower bound.
    const state = dependencies({ offpegFeeMultiplier: 20_000_000_000n });
    const pool = poolEntry();
    await enrichCurveStableswapRateInputExecutionModels({
      metrics: metrics(pool),
      chainAddressToId,
      chainRpcs: new Map([["ethereum", {} as never]]),
      nowSec: BLOCK_TIMESTAMP + 60,
      dependencies: state as never,
    });

    expect(pool.extra?.executionCapabilityGate).toBeUndefined();
    expect(pool.extra?.ammExecutionModel?.feeRate).toBeCloseTo(0.0002, 12);
  });

  it("prices a multiplier at or below the fee denominator as the static fee", async () => {
    const state = dependencies({ offpegFeeMultiplier: 0n });
    const pool = poolEntry();
    await enrichCurveStableswapRateInputExecutionModels({
      metrics: metrics(pool),
      chainAddressToId,
      chainRpcs: new Map([["ethereum", {} as never]]),
      nowSec: BLOCK_TIMESTAMP + 60,
      dependencies: state as never,
    });

    expect(pool.extra?.executionCapabilityGate).toBeUndefined();
    expect(pool.extra?.ammExecutionModel?.feeRate).toBeCloseTo(0.0001, 12);
  });

  it("keeps the rate-bearing gate when the bounded fee reaches the whole trade", async () => {
    const state = dependencies({ fee: 9_000_000_000n, offpegFeeMultiplier: 20_000_000_000n });
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
    const state = dependencies({ coinAddresses: [FRXUSD, SFRXUSD] });
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
