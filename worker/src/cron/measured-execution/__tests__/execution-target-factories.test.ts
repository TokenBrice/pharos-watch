import { describe, expect, it } from "vitest";

import type { DexExecutionTargetFactoryInput } from "../../dex-liquidity/execution-target-registry";
import { buildQuoterV2RegisteredExecutionTarget } from "../../dex-liquidity/execution-targets/quoter-v2";
import { buildUniswapV4RegisteredExecutionTarget } from "../../dex-liquidity/execution-targets/uniswap-v4";
import {
  buildUniswapV4ExecutionCandidateKey,
  buildUniV3ExecutionCandidateKey,
} from "../inventory";
import {
  UNISWAP_V4_HOOK_FREE_ADDRESS,
  computeUniswapV4PoolId,
} from "../uniswap-v4";

const TOKEN0 = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const TOKEN1 = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const V3_POOL = "0x3416cf6c708da44db2624d63ea0aaef7113527c6";
const V4_POOL = computeUniswapV4PoolId({
  currency0: TOKEN0,
  currency1: TOKEN1,
  feePips: 100,
  tickSpacing: 1,
  hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
});

function factoryInput(
  protocol: "uniswap-v3" | "uniswap-v4",
  pool: string,
): DexExecutionTargetFactoryInput {
  return {
    stablecoinId: "usdc-circle",
    context: {
      uniV3ExecutionCandidates: new Map(),
      uniswapV4ExecutionCandidates: new Map(),
      chainAddressToId: new Map([
        [`ethereum:${TOKEN0}`, "usdc-circle"],
        [`ethereum:${TOKEN1}`, "usdt-tether"],
      ]),
      symbolToChainScopedIds: new Map(),
      stablecoinPriceById: new Map([
        ["usdc-circle", 1],
        ["usdt-tether", 1],
      ]),
      measuredTargetCapturedAt: 1_785_000_000,
    } as unknown as DexExecutionTargetFactoryInput["context"],
    identity: {
      protocol,
      chainNorm: "ethereum",
      pool: {
        pool,
        chain: "Ethereum",
        project: protocol,
        symbol: "USDC-USDT",
        poolMeta: "0.01%",
        tvlUsd: 1_000_000,
        volumeUsd1d: 1,
        volumeUsd7d: 1,
        stablecoin: true,
        underlyingTokens: [TOKEN0, TOKEN1],
        apyBase: null,
        apyReward: null,
        apy: 0,
        sigma: 0,
        exposure: "single",
        count: 2,
      },
    } as DexExecutionTargetFactoryInput["identity"],
    enrichment: {
      rawContribTvl: 1_000_000,
    } as DexExecutionTargetFactoryInput["enrichment"],
  };
}

describe("registered concentrated execution-target factories", () => {
  it("joins an exact retained V3 pool when the token/fee key has siblings", () => {
    const input = factoryInput("uniswap-v3", `ethereum:${V3_POOL}`);
    const key = buildUniV3ExecutionCandidateKey(
      "ethereum",
      [TOKEN0, TOKEN1],
      100,
    )!;
    input.context.uniV3ExecutionCandidates.set(key, [
      {
        chain: "ethereum",
        poolAddress: "0x1111111111111111111111111111111111111111",
        feePips: 100,
        tvlUsd: 1_000_000,
        token0Price: 1,
        token1Price: 1,
        tokens: [
          { address: TOKEN0, symbol: "USDC", decimals: 6 },
          { address: TOKEN1, symbol: "USDT", decimals: 6 },
        ],
      },
      {
        chain: "ethereum",
        poolAddress: V3_POOL,
        feePips: 100,
        tvlUsd: 1_000_000,
        token0Price: 1,
        token1Price: 1,
        tokens: [
          { address: TOKEN0, symbol: "USDC", decimals: 6 },
          { address: TOKEN1, symbol: "USDT", decimals: 6 },
        ],
      },
    ]);

    expect(buildQuoterV2RegisteredExecutionTarget(input)).toMatchObject({
      executionCapabilityGate: undefined,
      measuredExecutionTarget: {
        adapterProfileId: "uniswap-v3-quoter-v2",
        poolId: `ethereum:${V3_POOL}`,
        tokenIn: { trackedAssetId: "usdc-circle" },
      },
    });
  });

  it("fails closed when the retained V3 pool address does not match", () => {
    const input = factoryInput(
      "uniswap-v3",
      "ethereum:0x2222222222222222222222222222222222222222",
    );
    const key = buildUniV3ExecutionCandidateKey(
      "ethereum",
      [TOKEN0, TOKEN1],
      100,
    )!;
    input.context.uniV3ExecutionCandidates.set(key, [{
      chain: "ethereum",
      poolAddress: V3_POOL,
      feePips: 100,
      tvlUsd: 1_000_000,
      token0Price: 1,
      token1Price: 1,
      tokens: [
        { address: TOKEN0, symbol: "USDC", decimals: 6 },
        { address: TOKEN1, symbol: "USDT", decimals: 6 },
      ],
    }]);

    expect(buildQuoterV2RegisteredExecutionTarget(input)).toEqual({
      executionCapabilityGate: {
        family: "measured-execution",
        reason: "target-unresolved",
      },
    });
  });

  it("selects the exact hook-free V4 PoolKey and rejects a hooked identity", () => {
    const input = factoryInput("uniswap-v4", V4_POOL);
    const hookedPool = computeUniswapV4PoolId({
      currency0: TOKEN0,
      currency1: TOKEN1,
      feePips: 100,
      tickSpacing: 1,
      hookAddress: "0x0000000000000000000000000000000000000001",
    });
    const key = buildUniswapV4ExecutionCandidateKey(
      "ethereum",
      [TOKEN0, TOKEN1],
      100,
    )!;
    input.context.uniswapV4ExecutionCandidates = new Map([[key, [
      {
        chain: "ethereum",
        poolId: hookedPool,
        feePips: 100,
        tickSpacing: 1,
        hookAddress: "0x0000000000000000000000000000000000000001",
        activeLiquidity: "1000000",
        tvlUsd: 1_000_000,
        token0Price: 1,
        token1Price: 1,
        tokens: [
          { address: TOKEN0, symbol: "USDC", decimals: 6 },
          { address: TOKEN1, symbol: "USDT", decimals: 6 },
        ],
      },
      {
        chain: "ethereum",
        poolId: V4_POOL,
        feePips: 100,
        tickSpacing: 1,
        hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
        activeLiquidity: "1000000",
        tvlUsd: 1_000_000,
        token0Price: 1,
        token1Price: 1,
        tokens: [
          { address: TOKEN0, symbol: "USDC", decimals: 6 },
          { address: TOKEN1, symbol: "USDT", decimals: 6 },
        ],
      },
    ]] as const]);

    expect(buildUniswapV4RegisteredExecutionTarget(input)).toMatchObject({
      executionCapabilityGate: undefined,
      measuredExecutionTarget: {
        adapterProfileId: "uniswap-v4-hook-free-quoter-v1",
        poolId: `ethereum:${V4_POOL}`,
        hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
      },
    });

    input.identity.pool.pool = hookedPool;
    expect(buildUniswapV4RegisteredExecutionTarget(input)).toEqual({
      executionCapabilityGate: {
        family: "measured-execution",
        reason: "target-unresolved",
      },
    });
  });
});
