import { describe, expect, it, vi } from "vitest";
import {
  buildStaticInaccessibleDeploymentOutcomes,
  classifyDexDeploymentOutcomes,
  upsertDexDeploymentOutcomes,
} from "../deployment-outcomes";
import type { StagedPool } from "../types";

const DEPLOYMENT = {
  chain: "ethereum",
  address: "0x0000000000000000000000000000000000000001",
  decimals: 6,
};

function poolFor(address: string): StagedPool {
  return {
    poolId: "ethereum:0xpool",
    stablecoinId: "test",
    source: "dexscreener",
    chain: "ethereum",
    protocol: "test",
    dexId: "test",
    symbol: "TEST / USDC",
    tvlUsd: 10_000,
    volume24h: 1_000,
    qualityMultiplier: 1,
    poolType: "amm",
    feeTier: null,
    balanceRatio: null,
    isStable: null,
    baseToken: address,
    quoteToken: "0x0000000000000000000000000000000000000002",
    quoteSymbol: "USDC",
    priceUsd: 1,
    lockedLiqPct: null,
    rawJson: null,
    discoveredAt: 1,
    refreshedAt: 1,
  };
}

describe("DEX deployment outcomes", () => {
  it("separates observed, verified empty, and inaccessible outcomes", () => {
    const observed = classifyDexDeploymentOutcomes({
      stablecoinId: "test",
      deployments: [DEPLOYMENT],
      pools: [poolFor(DEPLOYMENT.address)],
      providerChecks: [],
      nowSec: 100,
    });
    expect(observed[0]).toMatchObject({ outcome: "observed_pools", observedPoolCount: 1 });

    const empty = classifyDexDeploymentOutcomes({
      stablecoinId: "test",
      deployments: [DEPLOYMENT],
      pools: [],
      providerChecks: [{ ...DEPLOYMENT, provider: "coingecko", status: "success" }],
      nowSec: 100,
    });
    expect(empty[0]).toMatchObject({ outcome: "verified_no_pools", observedPoolCount: 0 });

    const curveObserved = classifyDexDeploymentOutcomes({
      stablecoinId: "test",
      deployments: [DEPLOYMENT],
      pools: [],
      providerChecks: [{ ...DEPLOYMENT, provider: "curve", status: "success", observedPoolCount: 2 }],
      nowSec: 100,
    });
    expect(curveObserved[0]).toMatchObject({ outcome: "observed_pools", observedPoolCount: 2 });

    const inaccessible = classifyDexDeploymentOutcomes({
      stablecoinId: "test",
      deployments: [{ ...DEPLOYMENT, chain: "cardano" }],
      pools: [],
      providerChecks: [],
      nowSec: 100,
    });
    expect(inaccessible[0]).toMatchObject({ outcome: "provider_inaccessible", providers: [] });
  });

  it("materializes every audited unsupported deployment", () => {
    const outcomes = buildStaticInaccessibleDeploymentOutcomes(100);
    expect(outcomes).toHaveLength(318);
    expect(new Set(outcomes.map((row) => row.stablecoinId)).size).toBe(118);
  });

  it("matches non-EVM deployments case-sensitively while retaining EVM normalization", () => {
    const solanaDeployment = { chain: "solana", address: "MintCase", decimals: 6 };
    const caseDistinct = classifyDexDeploymentOutcomes({
      stablecoinId: "test",
      deployments: [solanaDeployment],
      pools: [{ ...poolFor("mintCase"), chain: "solana", poolId: "solana:PoolCase" }],
      providerChecks: [{ ...solanaDeployment, provider: "coingecko", status: "success" }],
      nowSec: 100,
    });
    expect(caseDistinct[0]).toMatchObject({ outcome: "verified_no_pools", observedPoolCount: 0 });

    const exact = classifyDexDeploymentOutcomes({
      stablecoinId: "test",
      deployments: [solanaDeployment],
      pools: [{ ...poolFor("MintCase"), chain: "solana", poolId: "solana:PoolCase" }],
      providerChecks: [],
      nowSec: 100,
    });
    expect(exact[0]).toMatchObject({ outcome: "observed_pools", observedPoolCount: 1 });

    const evm = classifyDexDeploymentOutcomes({
      stablecoinId: "test",
      deployments: [{ ...DEPLOYMENT, address: "0xAbC" }],
      pools: [poolFor("0xabc")],
      providerChecks: [],
      nowSec: 100,
    });
    expect(evm[0]).toMatchObject({ outcome: "observed_pools", observedPoolCount: 1 });
  });

  it("persists canonical deployment addresses without lowercasing non-EVM identities", async () => {
    const boundRows: unknown[][] = [];
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn((...values: unknown[]) => {
          boundRows.push(values);
          return {};
        }),
      })),
      batch: vi.fn(async (statements: unknown[]) => statements.map(() => ({ meta: { changes: 1 } }))),
    } as unknown as D1Database;

    await upsertDexDeploymentOutcomes(db, [
      {
        stablecoinId: "test",
        chain: "solana",
        address: "MintCase",
        outcome: "observed_pools",
        providers: ["coingecko"],
        reason: "test",
        observedPoolCount: 1,
        observedAt: 100,
      },
      {
        stablecoinId: "test",
        chain: "ethereum",
        address: "0xAbC",
        outcome: "observed_pools",
        providers: ["coingecko"],
        reason: "test",
        observedPoolCount: 1,
        observedAt: 100,
      },
    ]);

    expect(boundRows.map((values) => values[2])).toEqual(["MintCase", "0xabc"]);
  });
});
