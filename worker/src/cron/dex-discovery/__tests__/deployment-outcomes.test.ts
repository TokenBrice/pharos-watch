import { describe, expect, it, vi } from "vitest";
import {
  buildFailedCrawlDeploymentOutcomes,
  buildStaticInaccessibleDeploymentOutcomes,
  classifyDexDeploymentOutcomes,
  upsertDexDeploymentOutcomes,
} from "../deployment-outcomes";
import type { DexDeploymentProviderCheck, StagedPool } from "../types";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";

const NEW_PROVIDER_TYPE_PINS = ["aquarius", "tezos", "icon-balanced", "kava-swap", "osmosis-sqs", "noble-swap"] as const satisfies readonly DexDeploymentProviderCheck["provider"][];
const NEW_SOURCE_TYPE_PINS = ["aquarius", "tezos", "icon-balanced", "kava-swap", "osmosis-sqs", "noble-swap"] as const satisfies readonly StagedPool["source"][];

const DEPLOYMENT = {
  chain: "ethereum",
  address: "0x0000000000000000000000000000000000000001",
  decimals: 6,
};
const STELLAR_CLASSIC_DEPLOYMENT = {
  chain: "stellar",
  address: "EURC-GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2",
  decimals: 7,
};
const STELLAR_SOROBAN_DEPLOYMENT = {
  chain: "stellar",
  address: "CDE57N6XTUPBKYYDGQMXX7E7SLNOLFY3JEQB4MULSMR2AKTSAENGX2HC",
  decimals: 5,
};
const STELLAR_AQUARIUS_DEPLOYMENT = {
  chain: "stellar",
  address: "CDWOB6T7SVSMMQN5V3P2OPTBAXOP7DAZHGVW3PYTZIKHVFKN6TBSXR6A",
  decimals: 5,
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
  const db = makeNoopD1({
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...values: unknown[]) => {
        statements.push({ sql, values });
        return {};
      }),
    })),
    batch: vi.fn(async (batched: unknown[]) => batched.map(() => ({ meta: { changes: 1 } }))),
  });
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
  it("keeps the new provider and staged-source unions aligned", () => {
    expect(NEW_PROVIDER_TYPE_PINS).toEqual(NEW_SOURCE_TYPE_PINS);
  });

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
    expect(empty[0]).toMatchObject({
      outcome: "verified_no_pools",
      providers: ["coingecko", "geckoterminal", "dexscreener", "curve"],
      reason: "A provider completed the direct-token query with no eligible pool",
      observedPoolCount: 0,
    });

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
      deployments: [STELLAR_CLASSIC_DEPLOYMENT],
      pools: [],
      providerChecks: [],
      nowSec: 100,
    });
    expect(inaccessible[0]).toMatchObject({ outcome: "provider_inaccessible", providers: ["horizon"] });

    const neverRan = classifyDexDeploymentOutcomes({
      stablecoinId: "test",
      deployments: [DEPLOYMENT],
      pools: [],
      providerChecks: [],
      nowSec: 100,
    });
    expect(neverRan[0]).toMatchObject({
      outcome: "provider_inaccessible",
      providers: ["coingecko", "geckoterminal", "dexscreener", "curve"],
      reason: "No provider completed a query for this deployment in the bounded crawl",
      observedPoolCount: 0,
    });
  });

  it("classifies Soroban identities as unsupported method rather than Horizon outage", () => {
    expect(
      classifyDexDeploymentOutcomes({
        stablecoinId: "test",
        deployments: [STELLAR_SOROBAN_DEPLOYMENT],
        pools: [],
        providerChecks: [],
        nowSec: 100,
      }),
    ).toEqual([
      expect.objectContaining({
        outcome: "provider_inaccessible",
        providers: [],
        reason: "No registered token-pool provider supports this chain",
      }),
    ]);
  });

  it("keeps completed-empty non-exhaustive venue censuses inaccessible", () => {
    const cases = [
      { deployment: STELLAR_AQUARIUS_DEPLOYMENT, provider: "aquarius" },
      {
        deployment: { chain: "icon", address: "cx88fd7df7ddff82f7cc735c871dc519838cb235bb", decimals: 18 },
        provider: "icon-balanced",
      },
      { deployment: { chain: "kava", address: "usdx", decimals: 6 }, provider: "kava-swap" },
    ] as const;

    for (const { deployment, provider } of cases) {
      const result = classifyDexDeploymentOutcomes({
        stablecoinId: "test",
        deployments: [deployment],
        pools: [],
        providerChecks: [{ ...deployment, provider, status: "success", observedPoolCount: 0 }],
        nowSec: 100,
      });
      expect(result[0]).toMatchObject({
        outcome: "provider_inaccessible",
        providers: expect.arrayContaining([provider]),
        reason: "Provider census is not exhaustive for this chain",
        observedPoolCount: 0,
      });
    }
  });

  it("still certifies a completed-empty exhaustive Tezos census", () => {
    const deployment = {
      chain: "tezos",
      address: "KT1XRPEPXbZK25r3Htzp2o1x7xdMMmfocKNW",
      decimals: 12,
    };
    expect(
      classifyDexDeploymentOutcomes({
        stablecoinId: "test",
        deployments: [deployment],
        pools: [],
        providerChecks: [{ ...deployment, provider: "tezos", status: "success", observedPoolCount: 0 }],
        nowSec: 100,
      }),
    ).toEqual([
      expect.objectContaining({
        outcome: "verified_no_pools",
        providers: ["tezos"],
        reason: "A provider completed the direct-token query with no eligible pool",
      }),
    ]);
  });

  it("does not persist retryable provider misses as a hard outage", () => {
    const retryable = classifyDexDeploymentOutcomes({
      stablecoinId: "test",
      deployments: [DEPLOYMENT],
      pools: [],
      providerChecks: [
        { ...DEPLOYMENT, provider: "geckoterminal", status: "failure", retryable: true },
        { ...DEPLOYMENT, provider: "dexscreener", status: "failure", retryable: true },
      ],
      nowSec: 100,
    });
    expect(retryable[0]).toMatchObject({
      outcome: "provider_inaccessible",
      reason: "No provider completed a query for this deployment in the bounded crawl",
    });

    const hardFailure = classifyDexDeploymentOutcomes({
      stablecoinId: "test",
      deployments: [DEPLOYMENT],
      pools: [],
      providerChecks: [{ ...DEPLOYMENT, provider: "geckoterminal", status: "failure" }],
      nowSec: 100,
    });
    expect(hardFailure[0]).toMatchObject({
      outcome: "provider_inaccessible",
      reason: "All attempted token-pool provider queries failed",
    });
  });

  it("materializes every audited unsupported deployment", () => {
    const outcomes = buildStaticInaccessibleDeploymentOutcomes(100);
    // 30 -> 33 rows (24 -> 26 coins) when the U3 registrations landed cNGN on
    // Lisk and Asset Chain plus BRZ on Chiliz — three chains with no
    // registered token-pool provider. Those three rows are the entire delta
    // over the previously audited universe; pin them explicitly.
    expect(outcomes).toHaveLength(33);
    expect(new Set(outcomes.map((row) => row.stablecoinId)).size).toBe(26);
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        stablecoinId: "usdc-circle",
        chain: "polkadot",
        address: "1337",
        providers: [],
      }),
    );
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        stablecoinId: "cngn-compliant-naira",
        chain: "lisk",
        address: "0xc7ab2c35ea37236e644c24a4e4a1911c082887c0",
        providers: [],
      }),
    );
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        stablecoinId: "cngn-compliant-naira",
        chain: "assetchain",
        address: "0x7923c0f6fa3d1ba6eafcaedaad93e737fd22fc4f",
        providers: [],
      }),
    );
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        stablecoinId: "brz-transfero",
        chain: "chiliz",
        address: "0xE9185Ee218cae427aF7B9764A011bb89FeA761B4",
        providers: [],
      }),
    );
    // Noble and Osmosis now resolve a registered provider, so the static
    // unsupported sweep must no longer claim them.
    expect(outcomes.some((row) => row.chain === "noble" || row.chain === "osmosis")).toBe(false);
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
