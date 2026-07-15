import { describe, expect, it } from "vitest";

import type { DexApiPool } from "../../../lib/dex-api-types";
import {
  buildFluidMeasuredExecutionTargets,
  buildMeasuredPoolDirectionKey,
  buildPancakeMeasuredExecutionTargets,
  buildUniV3MeasuredExecutionTarget,
  parseUniV3FeePips,
  type UniV3ExecutionCandidate,
} from "../inventory";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const POOL = "0x3333333333333333333333333333333333333333";

function addressMap(entries: Array<[string, string]>, chain = "ethereum") {
  return new Map(entries.map(([address, stablecoinId]) => [`${chain}:${address}`, stablecoinId]));
}

function directPool(
  source: "pancakeswap" | "fluid",
  tokens = [
    { address: USDC, symbol: "USDC", decimals: 6 },
    { address: USDT, symbol: "USDT", decimals: 6 },
  ],
): DexApiPool {
  return {
    source,
    chain: "ethereum",
    poolAddress: POOL,
    poolType: source === "fluid" ? "fluid-dex" : "pancakeswap-v3",
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

  it("fails a Uniswap target closed when the output has no independent reference", () => {
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

    expect(
      buildUniV3MeasuredExecutionTarget({
        stablecoinId: "usdc-circle",
        candidate,
        stablecoinPriceById: new Map([["usdc-circle", 1]]),
        chainAddressToId: addressMap([[USDC, "usdc-circle"]]),
        retainedTvlUsd: 3_000_000,
        capturedAt: 1_752_560_000,
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
