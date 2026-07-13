import { afterEach, describe, expect, it, vi } from "vitest";
import type { DexApiPool } from "../../../lib/dex-api-common";
import { integrateDirectApiLiquidityPhase } from "../orchestrator-phases/direct-api";
import { createKnownPoolIdentityIndex } from "../pool-identity";
import { initMetrics } from "../pool-helpers";

describe("integrateDirectApiLiquidityPhase", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers exact ids for sub-threshold direct API pools so staged duplicates cannot re-add them", async () => {
    const poolAddress = "0x4ba45fb7de134bcb24a6053bbe21c3a4be9f85ea";
    const directApiPools: DexApiPool[] = [
      {
        source: "balancer",
        chain: "plasma",
        poolAddress,
        poolType: "balancer-stable",
        tokens: [
          { address: "0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", symbol: "USDai", decimals: 18 },
          { address: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb", symbol: "USDT0", decimals: 6 },
        ],
        price: 1.0545990385,
        tvlUsd: 7.24,
        volume24hUsd: 0,
        feeRate: 0.0005,
        balances: [6.991123220641848, 0.000001],
      },
    ];

    const knownPoolIndex = createKnownPoolIdentityIndex();
    const metrics = new Map();
    const priceObservations = new Map();
    const chainAddressToId = new Map([["plasma:0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", "usdai-usd-ai"]]);

    await integrateDirectApiLiquidityPhase({
      directApiPools,
      knownPoolIndex,
      contractMetaByChainAddress: new Map(),
      metrics,
      priceObservations,
      chainAddressToId,
      symbolToChainScopedIds: new Map(),
      symbolToIds: new Map(),
      validationReferences: {} as never,
      stablecoinPriceById: new Map(),
    });

    expect(metrics.size).toBe(0);
    expect(priceObservations.size).toBe(0);
    expect(knownPoolIndex.exactKeys.has(`plasma:${poolAddress}`)).toBe(true);
  });

  it("skips untracked direct API pools before identity processing", async () => {
    const directApiPools: DexApiPool[] = [
      {
        source: "raydium",
        chain: "solana",
        poolAddress: "pool-untracked",
        poolType: "raydium-amm",
        tokens: [
          { address: "token-a", symbol: "AAA", decimals: 6 },
          { address: "token-b", symbol: "BBB", decimals: 6 },
        ],
        price: 1,
        tvlUsd: 1_000_000,
        volume24hUsd: 50_000,
        feeRate: null,
        balances: [500_000, 500_000],
      },
    ];

    const result = await integrateDirectApiLiquidityPhase({
      directApiPools,
      knownPoolIndex: createKnownPoolIdentityIndex(),
      contractMetaByChainAddress: new Map(),
      metrics: new Map(),
      priceObservations: new Map(),
      chainAddressToId: new Map(),
      symbolToChainScopedIds: new Map(),
      symbolToIds: new Map(),
      validationReferences: {} as never,
      stablecoinPriceById: new Map(),
    });

    expect(result.directApiSkippedUntracked).toBe(1);
    expect(result.directApiDedupSkippedByAddress).toBe(0);
    expect(result.excludedByReason).toEqual({ untracked_token: 1 });
  });

  it("counts invalid direct API units before tracking and identity processing", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const directApiPools: DexApiPool[] = [
      {
        source: "meteora",
        chain: "solana",
        poolAddress: "pool-invalid",
        poolType: "meteora-dlmm",
        tokens: [
          { address: "token-a", symbol: "AAA", decimals: 6 },
          { address: "token-b", symbol: "BBB", decimals: 6 },
        ],
        price: 1,
        tvlUsd: Number.NaN,
        volume24hUsd: 50_000,
        feeRate: null,
        balances: [500_000, 500_000],
      },
    ];

    const result = await integrateDirectApiLiquidityPhase({
      directApiPools,
      knownPoolIndex: createKnownPoolIdentityIndex(),
      contractMetaByChainAddress: new Map(),
      metrics: new Map(),
      priceObservations: new Map(),
      chainAddressToId: new Map([["solana:token-a", "aaa-test"]]),
      symbolToChainScopedIds: new Map(),
      symbolToIds: new Map(),
      validationReferences: {} as never,
      stablecoinPriceById: new Map(),
    });

    expect(result.directApiSkippedInvalidUnits).toBe(1);
    expect(result.directApiSkippedUntracked).toBe(0);
    expect(result.excludedByReason).toEqual({ invalid_units: 1 });
    expect(logSpy).not.toHaveBeenCalledWith("[dex-liquidity] Fetched 1 direct API pools total");
  });

  it("counts tracked direct API pools filtered by the TVL threshold", async () => {
    const poolAddress = "0x0000000000000000000000000000000000000abc";
    const directApiPools: DexApiPool[] = [
      {
        source: "balancer",
        chain: "ethereum",
        poolAddress,
        poolType: "balancer-stable",
        tokens: [
          { address: "0x00000000000000000000000000000000000000a1", symbol: "USDt", decimals: 6 },
          { address: "0x00000000000000000000000000000000000000b2", symbol: "USDC", decimals: 6 },
        ],
        price: 1,
        tvlUsd: 9_999,
        volume24hUsd: 500,
        feeRate: null,
        balances: [5_000, 5_000],
      },
    ];

    const result = await integrateDirectApiLiquidityPhase({
      directApiPools,
      knownPoolIndex: createKnownPoolIdentityIndex(),
      contractMetaByChainAddress: new Map(),
      metrics: new Map(),
      priceObservations: new Map(),
      chainAddressToId: new Map([["ethereum:0x00000000000000000000000000000000000000a1", "usdt-tether"]]),
      symbolToChainScopedIds: new Map(),
      symbolToIds: new Map(),
      validationReferences: {} as never,
      stablecoinPriceById: new Map(),
    });

    expect(result.directApiSkippedBelowTvlThreshold).toBe(1);
    expect(result.directApiSkippedAboveTvlSanityCap).toBe(0);
    expect(result.acceptedByProtocolChain).toEqual({});
    expect(result.excludedByReason).toEqual({ below_tvl_threshold: 1 });
  });

  it("enriches an exact primary duplicate with supported execution evidence without double counting", async () => {
    const poolAddress = "11111111111111111111111111111111";
    const knownPoolIndex = createKnownPoolIdentityIndex();
    knownPoolIndex.exactKeys.add(`solana:${poolAddress}`);
    const usdcMetrics = initMetrics("usdc-circle", "USDC");
    usdcMetrics.totalTvlUsd = 4_000_000;
    usdcMetrics.poolCount = 1;
    usdcMetrics.topPools.push({
      poolId: `solana:${poolAddress}`,
      project: "raydium",
      chain: "Solana",
      tvlUsd: 4_000_000,
      symbol: "USDC / USDT",
      volumeUsd1d: 100_000,
      poolType: "raydium-amm",
      source: "dl",
    });
    const metrics = new Map([["usdc-circle", usdcMetrics]]);
    const directApiPools: DexApiPool[] = [
      {
        source: "raydium",
        chain: "solana",
        poolAddress,
        poolType: "raydium-amm",
        tokens: [
          { address: "UsdcMint", symbol: "USDC", decimals: 6 },
          { address: "UsdtMint", symbol: "USDT", decimals: 6 },
        ],
        price: 1,
        tvlUsd: 4_000_000,
        volume24hUsd: 100_000,
        feeRate: 0.0025,
        balances: [2_000_000, 2_000_000],
        balancesNormalized: true,
      },
    ];

    const result = await integrateDirectApiLiquidityPhase({
      directApiPools,
      knownPoolIndex,
      contractMetaByChainAddress: new Map(),
      metrics,
      priceObservations: new Map(),
      chainAddressToId: new Map([
        ["solana:UsdcMint", "usdc-circle"],
        ["solana:UsdtMint", "usdt-tether"],
      ]),
      symbolToChainScopedIds: new Map(),
      symbolToIds: new Map(),
      validationReferences: {} as never,
      stablecoinPriceById: new Map([
        ["usdc-circle", 1],
        ["usdt-tether", 1],
      ]),
    });

    expect(result.directApiDedupSkippedByAddress).toBe(1);
    expect(usdcMetrics.totalTvlUsd).toBe(4_000_000);
    expect(usdcMetrics.poolCount).toBe(1);
    expect(usdcMetrics.topPools).toHaveLength(1);
    expect(usdcMetrics.topPools[0]?.extra?.ammExecutionModel).toMatchObject({
      invariant: "constant-product",
      trackedTokenIndex: 0,
    });
  });
});
