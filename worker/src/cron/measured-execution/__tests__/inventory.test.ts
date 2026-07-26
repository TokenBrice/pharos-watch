import { describe, expect, it, vi } from "vitest";

const logWorkerEventMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/structured-log", () => ({
  logWorkerEvent: logWorkerEventMock,
}));

import type { DexApiPool } from "../../../lib/dex-api-types";
import {
  buildFluidMeasuredExecutionTargets,
  buildMeasuredPoolDirectionKey,
  buildPancakeMeasuredExecutionTargets,
  buildSlipstreamMeasuredExecutionTarget,
  buildSlipstreamMeasuredExecutionTargets,
  buildUniV3MeasuredExecutionTarget,
  parseUniV3FeePips,
  type SlipstreamExecutionCandidate,
  type UniV3ExecutionCandidate,
} from "../inventory";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const POOL = "0x3333333333333333333333333333333333333333";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BASE_USDBC = "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca";

function addressMap(entries: Array<[string, string]>, chain = "ethereum") {
  return new Map(entries.map(([address, stablecoinId]) => [`${chain}:${address}`, stablecoinId]));
}

function directPool(
  source: "pancakeswap" | "fluid" | "aerodrome-slipstream",
  tokens: DexApiPool["tokens"] = [
    { address: USDC, symbol: "USDC", decimals: 6 },
    { address: USDT, symbol: "USDT", decimals: 6 },
  ],
): DexApiPool {
  return {
    source,
    chain: "ethereum",
    poolAddress: POOL,
    poolType:
      source === "fluid"
        ? "fluid-dex"
        : source === "aerodrome-slipstream"
          ? "aerodrome-slipstream-1bp"
          : "pancakeswap-v3",
    tokens,
    price: 0.98,
    tvlUsd: 4_000_000,
    volume24hUsd: 100_000,
    feeRate: source === "pancakeswap" ? 0.0001 : 0.00005,
    balances: [2_000_000, 2_000_000],
  };
}

describe("measured execution target inventory", () => {
  it("parses exactly one Uniswap v3 percent fee and rejects ambiguous metadata", () => {
    expect(parseUniV3FeePips("Uniswap V3 0.01%")).toBe(100);
    expect(parseUniV3FeePips("fees 0.01% and 0.05%")).toBeNull();
    expect(parseUniV3FeePips("Uniswap V3 1.2.3%")).toBeNull();
    expect(parseUniV3FeePips("Uniswap V3 .01%")).toBeNull();
    expect(parseUniV3FeePips("Uniswap V3")).toBeNull();
  });

  it("builds a Base Slipstream shadow target with tick-spacing identity", () => {
    const candidate: SlipstreamExecutionCandidate = {
      chain: "base",
      poolAddress: POOL,
      tickSpacing: 50,
      tvlUsd: 4_000_000,
      token0Price: 1,
      token1Price: 1,
      tokens: [
        { address: BASE_USDC, symbol: "USDC", decimals: 6 },
        { address: BASE_USDBC, symbol: "USDbC", decimals: 6 },
      ],
    };
    const target = buildSlipstreamMeasuredExecutionTarget({
      stablecoinId: "usdc-circle",
      candidate,
      stablecoinPriceById: new Map([
        ["usdc-circle", 1],
        ["usdbc-bridged", 1],
      ]),
      chainAddressToId: addressMap([
        [BASE_USDC, "usdc-circle"],
        [BASE_USDBC, "usdbc-bridged"],
      ], "base"),
      retainedTvlUsd: 3_000_000,
      capturedAt: 1_752_560_000,
    });

    expect(target).toMatchObject({
      adapterProfileId: "aerodrome-slipstream-quoter-v2",
      protocol: "aerodrome-slipstream",
      chain: "base",
      poolId: `base:${POOL}`,
      tickSpacing: 50,
    });
    expect(target?.targetId).toContain("|na|50");
  });

  it("builds Slipstream targets from exact Sugar pool metadata", () => {
    const pool = directPool("aerodrome-slipstream", [
      { address: BASE_USDC, symbol: "USDC", decimals: 6, priceUsd: 0.99 },
      { address: BASE_USDBC, symbol: "USDbC", decimals: 6, priceUsd: 1.01 },
    ]);
    pool.chain = "base";
    pool.tickSpacing = 50;

    const targets = buildSlipstreamMeasuredExecutionTargets({
      pools: [pool],
      chainAddressToId: addressMap([
        [BASE_USDC, "usdc-circle"],
        [BASE_USDBC, "usdbc-bridged"],
      ], "base"),
      symbolToChainScopedIds: new Map(),
      stablecoinPriceById: new Map([
        ["usdc-circle", 0.99],
        ["usdbc-bridged", 1.01],
      ]),
      capturedAt: 1_752_560_000,
    });

    expect(targets.size).toBe(2);
    expect(targets.get(`usdc-circle|base:${POOL}`)).toMatchObject({
      adapterProfileId: "aerodrome-slipstream-quoter-v2",
      poolId: `base:${POOL}`,
      tickSpacing: 50,
      tokenIn: { address: BASE_USDC, referencePriceUsd: 0.99 },
      tokenOut: { address: BASE_USDBC, referencePriceUsd: 1.01 },
    });
  });

  it("uses independent tracked references for a uniquely joined Uniswap v3 target", () => {
    const candidate: UniV3ExecutionCandidate = {
      chain: "ethereum",
      poolAddress: POOL,
      feePips: 100,
      tvlUsd: 4_000_000,
      token0Price: 999,
      token1Price: 0.001,
      tokens: [
        { address: USDC, symbol: "USDC", decimals: 6 },
        { address: USDT, symbol: "USDT", decimals: 6 },
      ],
    };
    const target = buildUniV3MeasuredExecutionTarget({
      stablecoinId: "usdc-circle",
      candidate,
      stablecoinPriceById: new Map([
        ["usdc-circle", 0.99],
        ["usdt-tether", 1.01],
      ]),
      chainAddressToId: addressMap([
        [USDC, "usdc-circle"],
        [USDT, "usdt-tether"],
      ]),
      retainedTvlUsd: 3_000_000,
      capturedAt: 1_752_560_000,
    });

    expect(target).toMatchObject({
      adapterProfileId: "uniswap-v3-quoter-v2",
      poolId: `ethereum:${POOL}`,
      poolTokenAddresses: [USDC, USDT],
      tokenIn: { referencePriceUsd: 0.99, trackedAssetId: "usdc-circle" },
      tokenOut: { referencePriceUsd: 1.01, trackedAssetId: "usdt-tether" },
      retainedPoolPriceUsd: 0.99,
    });
    expect(target?.tokenIn.referencePriceUsd).not.toBe(candidate.token0Price);
    expect(target?.tokenOut.referencePriceUsd).not.toBe(candidate.token1Price);
  });

  it("repairs an untracked output reference from the candidate spot price", () => {
    // USDC(token0)/WETH(token1): token0Price is WETH's price in USDC units
    // (~1862 USDC per WETH), the convention the Uni V3 price indexer consumes.
    const candidate: UniV3ExecutionCandidate = {
      chain: "ethereum",
      poolAddress: POOL,
      feePips: 100,
      tvlUsd: 4_000_000,
      token0Price: 1_862.48,
      token1Price: 0.0005369182777454345,
      tokens: [
        { address: USDC, symbol: "USDC", decimals: 6 },
        { address: "0x4444444444444444444444444444444444444444", symbol: "WETH", decimals: 18 },
      ],
    };
    const chainAddressToId = addressMap([[USDC, "usdc-circle"]]);

    const forward = buildUniV3MeasuredExecutionTarget({
      stablecoinId: "usdc-circle",
      candidate,
      stablecoinPriceById: new Map([["usdc-circle", 1]]),
      chainAddressToId,
      retainedTvlUsd: 3_000_000,
      capturedAt: 1_752_560_000,
    });
    // inputIndex = 0: implied output reference = inputRef × token0Price.
    expect(forward?.tokenOut.referencePriceUsd).toBeCloseTo(1_862.48, 6);
    expect(forward?.tokenOut.trackedAssetId).toBeUndefined();

    // Reverse direction (stablecoin is token1, prices swap with the legs):
    // implied = inputRef × token1Price.
    const reversed = buildUniV3MeasuredExecutionTarget({
      stablecoinId: "usdc-circle",
      candidate: {
        ...candidate,
        token0Price: 0.0005369182777454345,
        token1Price: 1_862.48,
        tokens: [
          { address: "0x4444444444444444444444444444444444444444", symbol: "WETH", decimals: 18 },
          { address: USDC, symbol: "USDC", decimals: 6 },
        ],
      },
      stablecoinPriceById: new Map([["usdc-circle", 1]]),
      chainAddressToId,
      retainedTvlUsd: 3_000_000,
      capturedAt: 1_752_560_000,
    });
    expect(reversed?.tokenOut.referencePriceUsd).toBeCloseTo(1_862.48, 6);
  });

  it("still fails closed when the output has neither a direct reference nor a usable spot", () => {
    const candidate: UniV3ExecutionCandidate = {
      chain: "ethereum",
      poolAddress: POOL,
      feePips: 100,
      tvlUsd: 4_000_000,
      token0Price: 1,
      token1Price: 1,
      tokens: [
        { address: USDC, symbol: "USDC", decimals: 6 },
        { address: "0x4444444444444444444444444444444444444444", symbol: "WETH", decimals: 18 },
      ],
    };
    const base = {
      stablecoinId: "usdc-circle",
      stablecoinPriceById: new Map([["usdc-circle", 1]]),
      chainAddressToId: addressMap([[USDC, "usdc-circle"]]),
      retainedTvlUsd: 3_000_000,
      capturedAt: 1_752_560_000,
    };
    // Coherent 1:1 spot implies a usable output reference, so the target builds.
    expect(buildUniV3MeasuredExecutionTarget({ ...base, candidate })).not.toBeNull();
    // Broken spot values must not manufacture a reference.
    for (const broken of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        buildUniV3MeasuredExecutionTarget({
          ...base,
          candidate: { ...candidate, token0Price: broken },
        }),
      ).toBeNull();
    }
  });

  it("rejects pool-implied references below measured-execution price precision", () => {
    const baseCandidate: UniV3ExecutionCandidate = {
      chain: "ethereum",
      poolAddress: POOL,
      feePips: 10_000,
      tvlUsd: 20_000,
      token0Price: 2.9386629316549423e-27,
      token1Price: 3.402908008205777e26,
      tokens: [
        { address: USDC, symbol: "USDC", decimals: 6 },
        { address: "0x4444444444444444444444444444444444444444", symbol: "ENS", decimals: 18 },
      ],
    };
    const base = {
      stablecoinId: "usdc-circle",
      stablecoinPriceById: new Map([["usdc-circle", 1]]),
      chainAddressToId: addressMap([[USDC, "usdc-circle"]]),
      retainedTvlUsd: 20_000,
      capturedAt: 1_752_560_000,
    };

    expect(buildUniV3MeasuredExecutionTarget({ ...base, candidate: baseCandidate })).toBeNull();
    expect(logWorkerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "univ3_implied_reference_rejected",
        metadata: expect.objectContaining({
          token0Price: baseCandidate.token0Price,
          token1Price: baseCandidate.token1Price,
          impliedOutputPrice: baseCandidate.token0Price,
        }),
      }),
    );
    expect(
      buildUniV3MeasuredExecutionTarget({
        ...base,
        candidate: { ...baseCandidate, token0Price: 2.818366306216791e-9 },
      }),
    ).toBeNull();
  });

  it("builds exact two-token Pancake and Fluid targets but rejects self-output and multi-token pools", () => {
    const chainAddressToId = addressMap([
      [USDC, "usdc-circle"],
      [USDT, "usdt-tether"],
    ]);
    const common = {
      chainAddressToId,
      symbolToChainScopedIds: new Map<string, Map<string, string[]>>(),
      stablecoinPriceById: new Map([
        ["usdc-circle", 0.99],
        ["usdt-tether", 1.01],
      ]),
      capturedAt: 1_752_560_000,
    };
    const pancake = buildPancakeMeasuredExecutionTargets({ pools: [directPool("pancakeswap")], ...common });
    const fluid = buildFluidMeasuredExecutionTargets({ pools: [directPool("fluid")], ...common });
    const poolId = `ethereum:${POOL}`;

    expect(pancake.get(buildMeasuredPoolDirectionKey("usdc-circle", poolId))).toMatchObject({
      adapterProfileId: "pancakeswap-v3-quoter-v2",
      feePips: 100,
      tokenIn: { referencePriceUsd: 0.99 },
      tokenOut: { referencePriceUsd: 1.01 },
    });
    expect(fluid.get(buildMeasuredPoolDirectionKey("usdc-circle", poolId))).toMatchObject({
      adapterProfileId: "fluid-resolver-measured",
      tokenIn: { referencePriceUsd: 0.99 },
      tokenOut: { referencePriceUsd: 1.01 },
    });

    const selfMap = addressMap([
      [USDC, "usdc-circle"],
      [USDT, "usdc-circle"],
    ]);
    expect(
      buildPancakeMeasuredExecutionTargets({
        pools: [directPool("pancakeswap")],
        ...common,
        chainAddressToId: selfMap,
      }).size,
    ).toBe(0);
    const thirdToken = { address: "0x5555555555555555555555555555555555555555", symbol: "DAI", decimals: 18 };
    expect(
      buildFluidMeasuredExecutionTargets({
        pools: [directPool("fluid", [...directPool("fluid").tokens, thirdToken])],
        ...common,
      }).size,
    ).toBe(0);
    const unsupportedFluidPool = directPool("fluid");
    unsupportedFluidPool.chain = "bsc";
    expect(
      buildFluidMeasuredExecutionTargets({
        pools: [unsupportedFluidPool],
        ...common,
        chainAddressToId: addressMap([
          [USDC, "usdc-circle"],
          [USDT, "usdt-tether"],
        ], "bsc"),
      }).size,
    ).toBe(0);
  });

  it("excludes a Pancake direction whose retained spot price is implausibly favorable", () => {
    const idrx = "0x4444444444444444444444444444444444444444";
    const pool = directPool("pancakeswap", [
      { address: USDT, symbol: "USDT", decimals: 18 },
      { address: idrx, symbol: "IDRX", decimals: 18 },
    ]);
    pool.price = 1_250;
    const targets = buildPancakeMeasuredExecutionTargets({
      pools: [pool],
      chainAddressToId: addressMap([
        [USDT, "usdt-tether"],
        [idrx, "idrx-idrx"],
      ]),
      symbolToChainScopedIds: new Map(),
      stablecoinPriceById: new Map([
        ["usdt-tether", 1],
        ["idrx-idrx", 1 / 18_000],
      ]),
      capturedAt: 1_752_560_000,
    });
    const poolId = `ethereum:${POOL}`;

    expect(targets.has(buildMeasuredPoolDirectionKey("idrx-idrx", poolId))).toBe(false);
    expect(targets.has(buildMeasuredPoolDirectionKey("usdt-tether", poolId))).toBe(true);
  });
});
