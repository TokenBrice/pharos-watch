import { describe, expect, it, vi } from "vitest";
import {
  buildFailedCrawlDeploymentOutcomes,
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

function createRecordingDb(): { db: D1Database; statements: Array<{ sql: string; values: unknown[] }> } {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...values: unknown[]) => {
        statements.push({ sql, values });
        return {};
      }),
    })),
    batch: vi.fn(async (batched: unknown[]) => batched.map(() => ({ meta: { changes: 1 } }))),
  } as unknown as D1Database;
  return { db, statements };
}

function outcomeWrite(overrides: { chain: string; address: string }) {
  return {
    stablecoinId: "test",
    outcome: "observed_pools" as const,
    providers: ["coingecko"],
    reason: "test",
    observedPoolCount: 1,
    observedAt: 100,
    ...overrides,
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
      deployments: [{ ...DEPLOYMENT, chain: "stellar" }],
      pools: [],
      providerChecks: [],
      nowSec: 100,
    });
    expect(inaccessible[0]).toMatchObject({ outcome: "provider_inaccessible", providers: ["horizon"] });
  });

  it("materializes every audited unsupported deployment", () => {
    const outcomes = buildStaticInaccessibleDeploymentOutcomes(100);
    expect(outcomes).toHaveLength(51);
    expect(new Set(outcomes.map((row) => row.stablecoinId)).size).toBe(31);
  });

  it("materializes an inaccessible outcome when a bounded crawl fails", () => {
    expect(
      buildFailedCrawlDeploymentOutcomes({
        stablecoinId: "test",
        deployments: [DEPLOYMENT],
        nowSec: 100,
      }),
    ).toEqual([
      {
        stablecoinId: "test",
        chain: DEPLOYMENT.chain,
        address: DEPLOYMENT.address,
        outcome: "provider_inaccessible",
        providers: ["coingecko", "geckoterminal", "dexscreener", "curve"],
        reason: "Bounded discovery crawl failed before a complete deployment census",
        observedPoolCount: 0,
        observedAt: 100,
      },
    ]);
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
    const { db, statements } = createRecordingDb();

    await upsertDexDeploymentOutcomes(db, [
      outcomeWrite({ chain: "solana", address: "MintCase" }),
      outcomeWrite({ chain: "ethereum", address: "0xAbC" }),
    ]);

    expect(statements.filter((statement) => statement.sql.startsWith("INSERT")).map((statement) => statement.values[2])).toEqual([
      "MintCase",
      "0xabc",
    ]);
  });

  it("deletes the superseded lowercase twin of a non-EVM deployment", async () => {
    const { db, statements } = createRecordingDb();

    await upsertDexDeploymentOutcomes(db, [
      outcomeWrite({ chain: "solana", address: "MintCase" }),
      outcomeWrite({ chain: "ethereum", address: "0xAbC" }),
      outcomeWrite({ chain: "solana", address: "alreadylowercase" }),
    ]);

    const deletes = statements.filter((statement) => statement.sql.startsWith("DELETE"));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.values).toEqual(["test", "solana", "mintcase"]);
    // The cleanup runs before the canonical write for the same deployment.
    expect(statements[0]!.sql.startsWith("DELETE")).toBe(true);
    expect(statements[1]!.values[2]).toBe("MintCase");
  });
});
