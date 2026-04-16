import { describe, expect, it } from "vitest";
import type { DexApiPool } from "../../../lib/dex-api-common";
import {
  buildAuthoritativeStagedPoolConfirmationIndex,
  integrateDirectApiLiquidityPhase,
} from "../orchestrator-phases";
import { createKnownPoolIdentityIndex } from "../pool-identity";

describe("integrateDirectApiLiquidityPhase", () => {
  it("registers exact ids for sub-threshold direct API pools so staged duplicates cannot re-add them", () => {
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
    const chainAddressToId = new Map([
      ["plasma:0x0a1a1a107e45b7ced86833863f482bc5f4ed82ef", "usdai-usd-ai"],
    ]);

    integrateDirectApiLiquidityPhase({
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

  it("skips untracked direct API pools before identity processing", () => {
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

    const result = integrateDirectApiLiquidityPhase({
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
  });
});

describe("buildAuthoritativeStagedPoolConfirmationIndex", () => {
  it("enforces confirmation for clean authoritative protocol fetches even when no pools were returned", () => {
    const index = buildAuthoritativeStagedPoolConfirmationIndex([
      {
        name: "Balancer",
        circuitKey: "balancer-api",
        normalizedProtocol: "balancer",
        supportedChains: ["plasma"],
        result: {
          pools: [],
          ok: true,
          degraded: false,
          errors: [],
        },
      },
    ]);

    expect(index.enforcedChainsByProtocol.get("balancer")).toEqual(new Set(["plasma"]));
    expect(index.confirmedExactKeysByProtocol.get("balancer")).toEqual(new Set());
  });

  it("fails open when the authoritative fetch degraded", () => {
    const index = buildAuthoritativeStagedPoolConfirmationIndex([
      {
        name: "Balancer",
        circuitKey: "balancer-api",
        normalizedProtocol: "balancer",
        supportedChains: ["plasma"],
        result: {
          pools: [],
          ok: true,
          degraded: true,
          errors: ["partial"],
        },
      },
    ]);

    expect(index.enforcedChainsByProtocol.size).toBe(0);
    expect(index.confirmedExactKeysByProtocol.size).toBe(0);
  });
});
