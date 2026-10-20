import { describe, expect, it } from "vitest";

import { makeDexApiFetchResult, type DexApiPool } from "../../../lib/dex-api-common";
import {
  hasRegisteredDexExecutionTargetOutput,
} from "../execution-target-registry";
import { createKnownPoolIdentityIndex } from "../pool-identity";
import { initSourcePoolGraph } from "../pool-helpers";
import { integrateDirectApiLiquidityPhase } from "../orchestrator-phases/direct-api";
import { fetchDirectApiFixture } from "../../__tests__/dex-liquidity-direct-api.test-support";
import { buildUniV3ExecutionCandidateKey } from "../../measured-execution/inventory";

const TOKEN0 = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const TOKEN1 = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const V3_POOL = "0x3416cf6c708da44db2624d63ea0aaef7113527c6";

function exactV3DirectPool(): DexApiPool {
  return {
    source: "uniswap-v3-shadow",
    chain: "ethereum",
    poolAddress: V3_POOL,
    poolType: "uniswap-v3-1bp",
    tokens: [
      { address: TOKEN0, symbol: "USDC", decimals: 6 },
      { address: TOKEN1, symbol: "USDT", decimals: 6 },
    ],
    price: 1,
    tvlUsd: 1_000_000,
    volume24hUsd: 50_000,
    feeRate: 0.0001,
    balances: null,
  };
}

function baseParams(pool: DexApiPool) {
  return {
    directApiPools: [pool],
    knownPoolIndex: createKnownPoolIdentityIndex(),
    contractMetaByChainAddress: new Map(),
    metrics: new Map(),
    priceObservations: new Map(),
    chainAddressToId: new Map([
      [`ethereum:${TOKEN0}`, "usdc-circle"],
      [`ethereum:${TOKEN1}`, "usdt-tether"],
    ]),
    symbolToChainScopedIds: new Map(),
    symbolToIds: new Map(),
    validationReferences: {} as never,
    stablecoinPriceById: new Map([
      ["usdc-circle", 1],
      ["usdt-tether", 1],
    ]),
  };
}

async function runAdmittedScenario(params: Parameters<typeof integrateDirectApiLiquidityPhase>[0] | Omit<Parameters<typeof integrateDirectApiLiquidityPhase>[0], "preprocessedPoolCounts">) {
  const phase = await fetchDirectApiFixture([{
    name: "fixture", circuitKey: "fixture", normalizedProtocol: "fixture", supportedChains: [],
    censusScope: "bounded-sample", result: makeDexApiFetchResult(params.directApiPools, { ok: true, degraded: false, errors: [] }),
  }], params);
  if (params.directApiPools.some((pool) => pool.source === "uniswap-v3-shadow")) {
    expect(phase.measuredExecutionPools).toHaveLength(1);
    expect(phase.pools).toHaveLength(0);
  }
  return integrateDirectApiLiquidityPhase({ ...params, directApiPools: phase.pools, preprocessedPoolCounts: phase.counts });
}

describe("direct API execution-target registry hook", () => {
  it("distinguishes no registered output from a fail-closed factory result", () => {
    expect(hasRegisteredDexExecutionTargetOutput({})).toBe(false);
    expect(hasRegisteredDexExecutionTargetOutput({ executionCapabilityGate: undefined })).toBe(false);
    expect(hasRegisteredDexExecutionTargetOutput({
      executionCapabilityGate: { family: "measured-execution", reason: "target-unresolved" },
    })).toBe(true);
  });

  it.each([
    { label: "normalizes DL delimiters and token order", symbol: "USDT-USDC", project: "uniswap-v3", attached: true },
    { label: "ignores a provider display fee annotation", symbol: "USDC / USDT 0.01%", project: "uniswap-v3", attached: true },
    { label: "rejects different token constituents", symbol: "DAI-USDC", project: "uniswap-v3", attached: false },
    { label: "rejects a conflicting protocol", symbol: "USDT-USDC", project: "pancakeswap", attached: false },
  ])("$label without admitting shadow inventory to scoring", async ({ symbol, project }) => {
    const pool = exactV3DirectPool();
    const params = baseParams(pool);
    const key = buildUniV3ExecutionCandidateKey("ethereum", [TOKEN0, TOKEN1], 100)!;
    params.knownPoolIndex.exactKeys.add(`ethereum:${V3_POOL}`);
    const metric = initSourcePoolGraph("usdc-circle", "USDC");
    metric.pools.push({
      poolId: `ethereum:${V3_POOL}`,
      project,
      chain: "Ethereum",
      tvlUsd: pool.tvlUsd,
      symbol,
      volumeUsd1d: pool.volume24hUsd,
      poolType: "cg-concentrated",
      source: "dl",
      extra: {
        executionCapabilityGate: {
          family: "measured-execution",
          reason: "target-unresolved",
        },
      },
    });
    params.metrics.set("usdc-circle", metric);

    await runAdmittedScenario({
      ...params,
      executionTargetContext: {
        uniV3ExecutionCandidates: new Map([[key, [{
          chain: "ethereum",
          poolAddress: V3_POOL,
          feePips: 100,
          tvlUsd: pool.tvlUsd,
          token0Price: 1,
          token1Price: 1,
          tokens: [
            { address: TOKEN0, symbol: "USDC", decimals: 6 },
            { address: TOKEN1, symbol: "USDT", decimals: 6 },
          ],
        }]]]),
        uniswapV4ExecutionCandidates: new Map(),
        measuredTargetCapturedAt: 1_788_274_041,
        contractMetaByChainAddress: new Map(),
      },
    });

    expect(metric.pools.reduce((total, pool) => total + pool.tvlUsd, 0)).toBe(pool.tvlUsd);
    expect(metric.pools.length).toBe(1);
    expect(metric.pools[0]?.extra?.measuredExecutionTarget).toBeUndefined();
    expect(metric.pools[0]?.extra?.executionCapabilityGate?.reason).toBe("target-unresolved");
  });

  it("leaves an unregistered direct pool on the existing integration path", async () => {
    const pool: DexApiPool = {
      source: "raydium",
      chain: "solana",
      poolAddress: "11111111111111111111111111111111",
      poolType: "raydium-amm",
      tokens: [
        { address: "UsdcMint", symbol: "USDC", decimals: 6 },
        { address: "UsdtMint", symbol: "USDT", decimals: 6 },
      ],
      price: 1,
      tvlUsd: 1_000_000,
      volume24hUsd: 50_000,
      feeRate: 0.0025,
      balances: [500_000, 500_000],
      balancesNormalized: true,
    };
    const makeParams = () => ({
      ...baseParams(pool),
      chainAddressToId: new Map([
        ["solana:UsdcMint", "usdc-circle"],
        ["solana:UsdtMint", "usdt-tether"],
      ]),
    });
    const baseline = makeParams();
    const candidate = makeParams();

    await runAdmittedScenario(baseline);
    await runAdmittedScenario({
      ...candidate,
      executionTargetContext: {
        uniV3ExecutionCandidates: new Map(),
        uniswapV4ExecutionCandidates: new Map(),
        measuredTargetCapturedAt: 1_788_274_041,
        contractMetaByChainAddress: new Map(),
      },
    });

    expect(candidate.metrics).toEqual(baseline.metrics);
    expect(candidate.priceObservations).toEqual(baseline.priceObservations);
  });
});
