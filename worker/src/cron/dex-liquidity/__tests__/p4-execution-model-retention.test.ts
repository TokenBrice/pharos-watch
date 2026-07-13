import { describe, expect, it } from "vitest";

import { addSecondaryPoolContribution } from "../pool-contribution";
import type { GtNewPool, LiquidityMetrics } from "../types";

describe("P4 direct AMM execution model retention", () => {
  it("preserves the exact model in the retained PoolEntry", () => {
    const metrics = new Map<string, LiquidityMetrics>();
    const pool: GtNewPool = {
      address: "RaydiumPool",
      chain: "solana",
      dexId: "raydium",
      name: "raydium:USDC / USDT",
      tvlUsd: 4_000_000,
      volume24hUsd: 100_000,
      qualityMultiplier: 0.8,
      maturityDays: 30,
      price: 1,
      symbol: "USDC / USDT",
      poolType: "raydium-amm",
      sourceFamily: "direct_api",
      ammExecutionModel: {
        source: "raydium",
        invariant: "constant-product",
        trackedTokenIndex: 0,
        feeRate: 0.0025,
        tokens: [
          {
            address: "UsdcMint",
            symbol: "USDC",
            decimals: 6,
            balance: 2_000_000,
            referencePriceUsd: 1,
            referencePriceSource: "tracked-market",
            trackedAssetId: "usdc-circle",
          },
          {
            address: "UsdtMint",
            symbol: "USDT",
            decimals: 6,
            balance: 2_000_000,
            referencePriceUsd: 1,
            referencePriceSource: "tracked-market",
            trackedAssetId: "usdt-tether",
          },
        ],
      },
    };

    addSecondaryPoolContribution(metrics, "usdc-circle", "USDC", pool);

    expect(metrics.get("usdc-circle")?.topPools[0]?.extra?.ammExecutionModel).toEqual(pool.ammExecutionModel);
  });

  it("retains case-distinct Solana pools as separate telemetry", () => {
    const metrics = new Map<string, LiquidityMetrics>();
    const basePool: GtNewPool = {
      address: "PoolCase",
      chain: "solana",
      dexId: "raydium",
      name: "raydium:USDC / USDT",
      tvlUsd: 1_000_000,
      volume24hUsd: 50_000,
      qualityMultiplier: 0.8,
      maturityDays: 30,
      price: 1,
      symbol: "USDC / USDT",
      poolType: "raydium-amm",
      sourceFamily: "direct_api",
    };

    addSecondaryPoolContribution(metrics, "usdc-circle", "USDC", basePool);
    addSecondaryPoolContribution(metrics, "usdc-circle", "USDC", { ...basePool, address: "poolCase" });

    expect(metrics.get("usdc-circle")?.poolCount).toBe(2);
    expect(metrics.get("usdc-circle")?.topPools.map((pool) => pool.poolId)).toEqual([
      "solana:PoolCase",
      "solana:poolCase",
    ]);
  });
});
