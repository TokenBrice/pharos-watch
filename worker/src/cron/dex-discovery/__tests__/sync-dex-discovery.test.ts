import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../../test-helpers/cron";

vi.mock("@shared/lib/stablecoins/registry", () => {
  const stablecoins = [
    {
      id: "coin-a",
      contracts: [{ chain: "ethereum", address: "0xaaa", decimals: 18 }],
    },
    {
      id: "coin-b",
      contracts: [{ chain: "ethereum", address: "0xbbb", decimals: 18 }],
    },
  ];
  return mockRegistry({ stablecoins });
});

vi.mock("../../dex-liquidity/pool-helpers", () => ({
  getTrackedContracts: vi.fn((coin: { contracts?: unknown[] }) => coin.contracts ?? []),
}));

vi.mock("../../../lib/price-validation", () => ({
  loadPriceValidationReferences: vi.fn(async () => undefined),
}));

vi.mock("../crawl-sources", () => ({
  crawlCoin: vi.fn(async () => ({
    pools: [
      { poolId: "ethereum:0xpool1" },
      { poolId: "base:0xpool2" },
    ],
    unresolvedChains: [],
    deploymentOutcomes: [],
    checkedDeploymentKeys: [],
  })),
}));

vi.mock("../crawl-dexscreener-pools", () => ({
  createDexScreenerDiscoveryRunState: vi.fn(() => ({
    allowed: null,
    attemptedRequests: 0,
    successfulRequests: 0,
    hardRefusal: null,
    outcomeRecorded: false,
  })),
  finalizeDexScreenerDiscoveryRun: vi.fn(async () => undefined),
}));

vi.mock("../deployment-outcomes", () => ({
  buildFailedCrawlDeploymentOutcomes: vi.fn(
    ({
      stablecoinId,
      deployments,
      nowSec,
    }: {
      stablecoinId: string;
      deployments: Array<{ chain: string; address: string }>;
      nowSec: number;
    }) =>
      deployments.map((deployment) => ({
        stablecoinId,
        ...deployment,
        outcome: "provider_inaccessible",
        providers: ["coingecko"],
        reason: "bounded crawl failed",
        observedPoolCount: 0,
        observedAt: nowSec,
      })),
  ),
  buildStaticInaccessibleDeploymentOutcomes: vi.fn(() => []),
  upsertDexDeploymentOutcomes: vi.fn(async (_db: D1Database, rows: unknown[]) => rows.length),
}));

vi.mock("../persistence", () => ({
  cleanupStaging: vi.fn(async () => {}),
  incrementRunSeq: vi.fn(async () => 1),
  readDiscoveryCensusSummaries: vi.fn(async () => new Map()),
  readDiscoveryMeta: vi.fn(async () => new Map()),
  readDiscoveryTargetCursors: vi.fn(async () => new Map()),
  recordDiscoveryAttemptFence: vi.fn(async () => {}),
  updateDiscoveryMeta: vi.fn(async () => {}),
  upsertStagedPools: vi.fn(async () => {}),
  writeDiscoveryTargetCursors: vi.fn(async () => {}),
}));

import {
  DEX_DISCOVERY_FINALIZATION_TAIL_BUDGET_MS,
  DEX_DISCOVERY_RUN_BUDGET_MS,
  syncDexDiscovery,
} from "../orchestrator";
import { crawlCoin } from "../crawl-sources";
import { loadPriceValidationReferences } from "../../../lib/price-validation";
import {
  buildFailedCrawlDeploymentOutcomes,
  upsertDexDeploymentOutcomes,
} from "../deployment-outcomes";
import {
  cleanupStaging,
  incrementRunSeq,
  readDiscoveryMeta,
  readDiscoveryTargetCursors,
  recordDiscoveryAttemptFence,
  updateDiscoveryMeta,
  upsertStagedPools,
} from "../persistence";

const mockValidationReferences = {
  rates: {},
  type: "none" as const,
  updatedAt: null,
};

function makeStagedPool(poolId: string) {
  return {
    poolId,
    stablecoinId: "coin-a",
    source: "dexscreener" as const,
    chain: "ethereum",
    protocol: "uniswap-v3",
    dexId: "uniswap-v3",
    symbol: "COINA",
    tvlUsd: 100_000,
    volume24h: 25_000,
    qualityMultiplier: 1,
    poolType: "concentrated",
    feeTier: 500,
    balanceRatio: 1,
    isStable: true,
    baseToken: "0xaaa",
    quoteToken: "0xusdc",
    quoteSymbol: "USDC",
    priceUsd: 1,
    lockedLiqPct: null,
    rawJson: null,
    discoveredAt: 1_700_000_000,
    refreshedAt: 1_700_000_000,
  };
}

const db = {
  prepare: (sql: string) => ({
    all: async () => ({
      results: sql.includes("FROM dex_liquidity")
        ? [
            { stablecoin_id: "coin-a", pool_count: 0, chain_count: 0 },
            { stablecoin_id: "coin-b", pool_count: 3, chain_count: 1 },
          ]
        : [],
    }),
  }),
} as unknown as D1Database;

describe("syncDexDiscovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadPriceValidationReferences).mockResolvedValue(mockValidationReferences);
    vi.mocked(readDiscoveryMeta).mockResolvedValue(new Map());
    vi.mocked(readDiscoveryTargetCursors).mockResolvedValue(new Map());
    vi.mocked(incrementRunSeq).mockResolvedValue(2);
    vi.mocked(recordDiscoveryAttemptFence).mockResolvedValue();
    vi.mocked(updateDiscoveryMeta).mockResolvedValue();
    vi.mocked(upsertStagedPools).mockResolvedValue();
    vi.mocked(crawlCoin).mockResolvedValue({
      pools: [
        makeStagedPool("ethereum:0xpool1"),
        makeStagedPool("base:0xpool2"),
      ],
      unresolvedChains: [],
      deploymentOutcomes: [],
      checkedDeploymentKeys: [],
    });
  });

  it("returns the discovery contract metadata without legacy telemetry fields", async () => {
    const result = await syncDexDiscovery(db, null);

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(1);
    expect(vi.mocked(crawlCoin)).toHaveBeenCalledTimes(1);
    expect(recordDiscoveryAttemptFence).toHaveBeenCalledWith(
      db,
      "coin-a",
      [{ chain: "ethereum", address: "0xaaa", decimals: 18 }],
      expect.any(Number),
      undefined,
    );
    expect(
      vi.mocked(recordDiscoveryAttemptFence).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(crawlCoin).mock.invocationCallOrder[0]!);
    expect(vi.mocked(upsertStagedPools)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateDiscoveryMeta)).toHaveBeenCalledWith(db, "coin-a", 2, expect.any(Number), undefined);
    expect(vi.mocked(cleanupStaging)).toHaveBeenCalledTimes(1);

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata).toMatchObject({
      coinsCrawled: 1,
      poolsDiscovered: 2,
      budgetExhausted: false,
      runSeq: 2,
      failedCoins: [],
      tierBreakdown: {
        t1: 1,
        t2: 0,
        t3: 0,
        dormant: 0,
        skipped: 1,
      },
    });
  });

  it("returns degraded and skips staging when the finalization tail budget is exhausted", async () => {
    vi.mocked(incrementRunSeq).mockResolvedValue(1);

    let nowMs = 1_700_000_000_000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    vi.mocked(crawlCoin).mockImplementation(async () => {
      nowMs += DEX_DISCOVERY_RUN_BUDGET_MS + 1_000;
      return {
        pools: [makeStagedPool("ethereum:0xpool1")],
        unresolvedChains: [],
        deploymentOutcomes: [],
        checkedDeploymentKeys: [],
      };
    });

    const result = await syncDexDiscovery(db, null);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(vi.mocked(crawlCoin)).toHaveBeenCalledTimes(1);
    expect(recordDiscoveryAttemptFence).toHaveBeenCalledWith(
      db,
      "coin-a",
      [{ chain: "ethereum", address: "0xaaa", decimals: 18 }],
      expect.any(Number),
      undefined,
    );
    expect(vi.mocked(upsertStagedPools)).not.toHaveBeenCalled();
    expect(vi.mocked(cleanupStaging)).not.toHaveBeenCalled();

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata).toMatchObject({
      coinsCrawled: 0,
      poolsDiscovered: 0,
      budgetExhausted: true,
      stagingWritesSkippedForBudget: 1,
      cleanupSkippedForBudget: true,
      finalizationTailBudgetMs: DEX_DISCOVERY_FINALIZATION_TAIL_BUDGET_MS,
      runSeq: 1,
      tierBreakdown: {
        t1: 1,
        t2: 0,
        t3: 0,
        dormant: 0,
        skipped: 1,
      },
    });

    dateNowSpy.mockRestore();
  });

  it("fences prior deployment outcomes before recording a failed crawl", async () => {
    vi.mocked(crawlCoin).mockRejectedValueOnce(new Error("provider unavailable"));

    const result = await syncDexDiscovery(db, null);

    expect(result.status).toBe("degraded");
    expect(buildFailedCrawlDeploymentOutcomes).toHaveBeenCalledWith({
      stablecoinId: "coin-a",
      deployments: [
        { chain: "ethereum", address: "0xaaa", decimals: 18 },
      ],
      nowSec: expect.any(Number),
    });
    expect(upsertDexDeploymentOutcomes).toHaveBeenLastCalledWith(
      db,
      [
        expect.objectContaining({
          stablecoinId: "coin-a",
          outcome: "provider_inaccessible",
        }),
      ],
      undefined,
    );
    expect(updateDiscoveryMeta).toHaveBeenCalledWith(
      db,
      "coin-a",
      0,
      expect.any(Number),
      undefined,
    );
    expect(recordDiscoveryAttemptFence).toHaveBeenCalledWith(
      db,
      "coin-a",
      [{ chain: "ethereum", address: "0xaaa", decimals: 18 }],
      expect.any(Number),
      undefined,
    );
    expect(
      JSON.parse(result.metadata ?? "{}"),
    ).toMatchObject({
      failedCoins: ["coin-a"],
      deploymentOutcomesWritten: 1,
    });
  });

  it("fences prior outcomes when result persistence fails after a successful crawl", async () => {
    vi.mocked(upsertStagedPools).mockRejectedValueOnce(
      new Error("staging persistence unavailable"),
    );

    const result = await syncDexDiscovery(db, null);

    expect(result.status).toBe("degraded");
    expect(buildFailedCrawlDeploymentOutcomes).not.toHaveBeenCalled();
    expect(upsertDexDeploymentOutcomes).toHaveBeenCalledTimes(1);
    expect(recordDiscoveryAttemptFence).toHaveBeenCalledWith(
      db,
      "coin-a",
      [{ chain: "ethereum", address: "0xaaa", decimals: 18 }],
      expect.any(Number),
      undefined,
    );
    expect(updateDiscoveryMeta).not.toHaveBeenCalled();
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      failedCoins: ["coin-a"],
      deploymentOutcomesWritten: 0,
    });
  });

  it("persists the attempt fence before an in-flight abort", async () => {
    const controller = new AbortController();
    vi.mocked(crawlCoin).mockImplementationOnce(async () => {
      controller.abort(new Error("stop-discovery"));
      throw controller.signal.reason;
    });

    const result = await syncDexDiscovery(
      db,
      null,
      controller.signal,
    );

    expect(result.status).toBe("error");
    expect(recordDiscoveryAttemptFence).toHaveBeenCalledWith(
      db,
      "coin-a",
      [{ chain: "ethereum", address: "0xaaa", decimals: 18 }],
      expect.any(Number),
      controller.signal,
    );
    expect(
      vi.mocked(recordDiscoveryAttemptFence).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(crawlCoin).mock.invocationCallOrder[0]!);
    expect(upsertStagedPools).not.toHaveBeenCalled();
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      error: "stop-discovery",
    });
  });
});
