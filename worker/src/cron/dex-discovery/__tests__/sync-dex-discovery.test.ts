import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../../test-helpers/cron";
import type { DiscoveryRunCheckpoint } from "../types";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import type { CronProgressReporter } from "../../../lib/cron-logger";

vi.mock("@shared/lib/stablecoins/worker-runtime-registry", () => {
  const stablecoins = [
    {
      id: "coin-a",
      symbol: "COINA",
      contracts: [{ chain: "ethereum", address: "0xaaa", decimals: 18 }],
    },
    {
      id: "coin-b",
      symbol: "COINB",
      contracts: [{ chain: "ethereum", address: "0xbbb", decimals: 18 }],
    },
  ];
  const registry = mockRegistry({ stablecoins });
  return {
    WORKER_ACTIVE_STABLECOINS: registry.ACTIVE_STABLECOINS,
    WORKER_TRACKED_META_BY_ID: registry.TRACKED_META_BY_ID,
  };
});

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
  readDiscoveryRunCheckpoint: vi.fn(async () => null),
  readDiscoveryTargetCursors: vi.fn(async () => new Map()),
  recordDiscoveryAttemptFence: vi.fn(async () => {}),
  updateDiscoveryMeta: vi.fn(async () => {}),
  upsertStagedPools: vi.fn(async (_db: D1Database, pools: unknown[]) => pools.length),
  writeDiscoveryRunCheckpoint: vi.fn(async () => {}),
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
  readDiscoveryRunCheckpoint,
  readDiscoveryTargetCursors,
  recordDiscoveryAttemptFence,
  updateDiscoveryMeta,
  upsertStagedPools,
  writeDiscoveryRunCheckpoint,
} from "../persistence";
import { stagedPool } from "./discovery.test-support";
import { classifyDexPlaceholderCoverage } from "../../dex-liquidity/deployment-census-coverage";

const mockValidationReferences = {
  rates: {},
  type: "none" as const,
  updatedAt: null,
};

function makeStagedPool(poolId: string) {
  return stagedPool({
    poolId, stablecoinId: "coin-a", protocol: "uniswap-v3", dexId: "uniswap-v3", symbol: "COINA",
    tvlUsd: 100_000, volume24h: 25_000, poolType: "concentrated", feeTier: 500, balanceRatio: 1,
    isStable: true, baseToken: "0xaaa", quoteToken: "0xusdc",
    discoveredAt: 1_700_000_000, refreshedAt: 1_700_000_000,
  });
}

const db = makeNoopD1({
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
});

describe("syncDexDiscovery", () => {
  it("retains the coin and provider in progress for abandonment reconciliation", async () => {
    const onProgress = vi.fn(async () => {});
    vi.mocked(crawlCoin).mockImplementationOnce(async (...args) => {
      await args[9]?.("curve");
      return { pools: [], unresolvedChains: [], deploymentOutcomes: [], checkedDeploymentKeys: [] };
    });

    await syncDexDiscovery(db, null, undefined, onProgress);

    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      stage: "crawl-curve:coin-a",
      message: "Crawling coin-a via curve",
    }));
  });

  it("prioritizes due supplemental refresh even when the weekly cohort is ineligible", async () => {
    const refreshDb = makeNoopD1({ prepare: () => ({ all: async () => ({ results: [
      { stablecoin_id: "coin-b", pool_count: 20, chain_count: 4, has_supplemental_coverage: 1 },
      { stablecoin_id: "coin-a", pool_count: 20, chain_count: 4, has_supplemental_coverage: 0 },
    ] }) }) });
    await syncDexDiscovery(refreshDb, null);
    expect(vi.mocked(crawlCoin).mock.calls[0]?.[1]).toBe("coin-b");
  });

  it.each([
    [false, 6], [true, 6], [false, 10], [true, 10],
  ] as const)("refreshes an unanswered census at the existing maintenance cadence (missing row: %s, misses: %s)", async (missingRow, misses) => {
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(readDiscoveryMeta).mockResolvedValue(new Map([
      ["coin-a", { stablecoinId: "coin-a", consecutiveMisses: misses,
        lastCrawlAt: nowSec - 36 * 3600, lastHitAt: null }],
    ]));
    const censusDb = missingRow ? makeNoopD1({
      prepare: (sql: string) => ({ all: async () => ({
        results: sql.includes("FROM dex_liquidity")
          ? [{ stablecoin_id: "coin-b", pool_count: 3, chain_count: 1 }] : [],
      }) }),
    }) : db;

    const result = await syncDexDiscovery(censusDb, null);

    expect(vi.mocked(crawlCoin).mock.calls.map((call) => call[1])).toEqual(["coin-a"]);
    expect(JSON.parse(result.metadata ?? "{}").tierBreakdown).toMatchObject({ refresh: 1, t3: 0, dormant: 0 });
    expect(vi.mocked(crawlCoin).mock.calls[0]?.[2]).toEqual([
      { chain: "ethereum", address: "0xaaa", decimals: 18 },
    ]);
  });

  it("does not accelerate a missing-liquidity-row census before its existing refresh interval", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(readDiscoveryMeta).mockResolvedValue(new Map([
      ["coin-a", { stablecoinId: "coin-a", consecutiveMisses: 10,
        lastCrawlAt: nowSec - 3600, lastHitAt: null }],
    ]));
    const missingRowDb = makeNoopD1({
      prepare: (sql: string) => ({ all: async () => ({
        results: sql.includes("FROM dex_liquidity")
          ? [{ stablecoin_id: "coin-b", pool_count: 3, chain_count: 1 }] : [],
      }) }),
    });

    const result = await syncDexDiscovery(missingRowDb, null);

    expect(vi.mocked(crawlCoin)).not.toHaveBeenCalled();
    expect(JSON.parse(result.metadata ?? "{}").tierBreakdown).toMatchObject({ refresh: 0, skipped: 2 });
  });

  it("keeps a missing published-liquidity row unavailable when scheduled maintenance produces no evidence", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const prepare = vi.fn((sql: string) => ({ all: async () => ({
      results: sql.includes("FROM dex_liquidity")
        ? [{ stablecoin_id: "coin-b", pool_count: 3, chain_count: 1 }] : [],
    }) }));
    const missingRowDb = makeNoopD1({ prepare });
    vi.mocked(readDiscoveryMeta).mockResolvedValue(new Map([
      ["coin-a", { stablecoinId: "coin-a", consecutiveMisses: 10,
        lastCrawlAt: nowSec - 36 * 3600, lastHitAt: null }],
    ]));
    vi.mocked(crawlCoin).mockResolvedValueOnce({
      pools: [], unresolvedChains: [], deploymentOutcomes: [], checkedDeploymentKeys: [],
    });

    const result = await syncDexDiscovery(missingRowDb, null);

    expect(JSON.parse(result.metadata ?? "{}").tierBreakdown).toMatchObject({ refresh: 1 });
    expect(vi.mocked(upsertStagedPools)).toHaveBeenCalledWith(missingRowDb, [], undefined);
    expect(vi.mocked(upsertDexDeploymentOutcomes).mock.calls.every((call) => call[1].length === 0)).toBe(true);
    expect(prepare.mock.calls.some(([sql]) =>
      /(?:INSERT\s+INTO|UPDATE)\s+dex_liquidity\b/i.test(sql))).toBe(false);
    // The actual publication classifier still receives missing outcomes, not a
    // synthetic verified-empty result or zero-liquidity observation.
    const publicationCoverage = classifyDexPlaceholderCoverage({
      deployments: [{ chain: "ethereum", address: "0xaaa", decimals: 18 }],
      outcomeRows: [], nowSec,
    });
    expect(publicationCoverage.state).toBe("discovery-deferral");
    expect(publicationCoverage.coverage).toMatchObject({
      status: "unknown", unsupportedReasons: { deploymentCensusMissingOutcome: 1 },
    });
    expect(publicationCoverage.census.verifiedNoPoolsCount).toBe(0);
    expect(publicationCoverage.census.oldestObservedAtSec).toBeNull();
    expect(publicationCoverage.census.newestObservedAtSec).toBeNull();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadPriceValidationReferences).mockResolvedValue(mockValidationReferences);
    vi.mocked(readDiscoveryMeta).mockResolvedValue(new Map());
    vi.mocked(readDiscoveryTargetCursors).mockResolvedValue(new Map());
    vi.mocked(readDiscoveryRunCheckpoint).mockResolvedValue(null);
    vi.mocked(writeDiscoveryRunCheckpoint).mockResolvedValue();
    vi.mocked(incrementRunSeq).mockResolvedValue(2);
    vi.mocked(recordDiscoveryAttemptFence).mockResolvedValue();
    vi.mocked(updateDiscoveryMeta).mockResolvedValue();
    vi.mocked(upsertStagedPools).mockImplementation(async (_db, pools) => pools.length);
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
        refresh: 1,
        t1: 0,
        t2: 0,
        t3: 0,
        dormant: 0,
        skipped: 1,
      },
    });
  });

  it.each([false, true])("excludes ticker records from pool metadata with mixed sources=%s", async (mixed) => {
    const ticker = stagedPool({
      poolId: "orderbook:example:coin-a", stablecoinId: "coin-a", source: "cg_tickers",
      chain: "orderbook", protocol: "example", tvlUsd: null, volume24h: 100_000, priceUsd: 1,
    });
    const pools = mixed ? [ticker, makeStagedPool("ethereum:0xpool1")] : [ticker];
    vi.mocked(crawlCoin).mockResolvedValue({
      pools, unresolvedChains: [], deploymentOutcomes: [], checkedDeploymentKeys: [],
    });
    const result = await syncDexDiscovery(db, null);
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata.poolsDiscovered).toBe(mixed ? 1 : 0);
    expect(metadata.poolsBySource).toEqual(mixed ? { dexscreener: 1 } : undefined);
    expect(upsertStagedPools).toHaveBeenCalledWith(db, pools, undefined);
    expect(updateDiscoveryMeta).toHaveBeenCalledWith(db, "coin-a", mixed ? 1 : 0, expect.any(Number), undefined);
  });

  it("keeps crawling the cohort queue when the stale-pool refresh pass fails", async () => {
    const failingRegistryDb = makeNoopD1({
      prepare: (sql: string) => ({
        all: async () => ({
          results: sql.includes("FROM dex_liquidity")
            ? [{ stablecoin_id: "coin-a", pool_count: 0, chain_count: 0 }]
            : [],
        }),
        bind: () => ({ all: async () => { throw new Error("D1_ERROR: registry read failed"); } }),
      }),
    });

    const result = await syncDexDiscovery(failingRegistryDb, "cg-key");

    expect(vi.mocked(crawlCoin).mock.calls.map((call) => call[1])).toEqual(["coin-a", "coin-b"]);
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(result.status).toBe("degraded");
    expect(metadata).toMatchObject({
      coinsCrawled: 2,
      reason: "dex-discovery-stale-pool-refresh-failed",
      stalePoolRefresh: { outcome: "failed", error: "D1_ERROR: registry read failed", requests: 0 },
    });
  });

  it("resumes the saved cohort tail without advancing its sequence or repeating refresh", async () => {
    const cohortDb = makeNoopD1({
      prepare: (sql: string) => ({ all: async () => ({
        results: sql.includes("FROM dex_liquidity")
          ? [{ stablecoin_id: "coin-a", pool_count: 0, chain_count: 0 },
            { stablecoin_id: "coin-b", pool_count: 0, chain_count: 0 }]
          : [],
      }) }),
    });
    let checkpoint: DiscoveryRunCheckpoint | null = null;
    vi.mocked(readDiscoveryRunCheckpoint).mockImplementation(async () => checkpoint);
    vi.mocked(writeDiscoveryRunCheckpoint).mockImplementation(async (_db, next) => {
      checkpoint = next == null ? null : structuredClone(next);
    });
    let nowMs = 1_700_000_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    vi.mocked(updateDiscoveryMeta).mockImplementationOnce(async () => {
      nowMs += DEX_DISCOVERY_RUN_BUDGET_MS - DEX_DISCOVERY_FINALIZATION_TAIL_BUDGET_MS + 1;
    });
    try {
      const firstProgress = vi.fn(async () => {});
      const first = await syncDexDiscovery(cohortDb, null, undefined, firstProgress);
      expect(vi.mocked(crawlCoin).mock.calls.map((call) => call[1])).toEqual(["coin-a"]);
      expect(checkpoint).toEqual({
        runSeq: 2, refreshPending: false,
        pendingCandidates: [{ stablecoinId: "coin-b", tier: "refresh" }],
      });
      expect(JSON.parse(first.metadata ?? "{}")).toMatchObject({
        budgetExhausted: true, continuationPending: 1, resumedFromCheckpoint: false,
      });
      expect(firstProgress).toHaveBeenLastCalledWith(expect.objectContaining({
        stage: "deferred", itemsDone: 1, itemsTotal: 2,
      }));

      nowMs += 2 * 3600_000;
      const nextProgress = vi.fn<CronProgressReporter>(async () => {});
      const second = await syncDexDiscovery(cohortDb, null, undefined, nextProgress);
      expect(vi.mocked(crawlCoin).mock.calls.map((call) => call[1])).toEqual(["coin-a", "coin-b"]);
      expect(incrementRunSeq).toHaveBeenCalledTimes(1);
      expect(nextProgress.mock.calls.some(([progress]) => progress.stage === "refresh-stale-pools")).toBe(false);
      expect(JSON.parse(second.metadata ?? "{}")).toMatchObject({
        runSeq: 2, resumedFromCheckpoint: true, continuationPending: 0,
      });
      expect(checkpoint).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it("includes initial reference reads in the wall budget and checkpoints untouched work", async () => {
    let nowMs = 1_700_000_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    vi.mocked(loadPriceValidationReferences).mockImplementationOnce(async () => {
      nowMs += DEX_DISCOVERY_RUN_BUDGET_MS;
      return mockValidationReferences;
    });
    try {
      const result = await syncDexDiscovery(db, null);
      expect(crawlCoin).not.toHaveBeenCalled();
      expect(writeDiscoveryRunCheckpoint).toHaveBeenLastCalledWith(db, {
        runSeq: 2, refreshPending: true,
        pendingCandidates: [{ stablecoinId: "coin-a", tier: "refresh" }],
      }, null, undefined);
      expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
        budgetExhausted: true, continuationPending: 1, coinsCrawled: 0,
        reason: "dex-discovery-budget-exhausted",
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("retains an unfinished candidate after result persistence fails", async () => {
    vi.mocked(upsertStagedPools).mockRejectedValueOnce(new Error("D1 unavailable"));
    const result = await syncDexDiscovery(db, null);
    expect(result.status).toBe("degraded");
    expect(writeDiscoveryRunCheckpoint).toHaveBeenLastCalledWith(db, {
      runSeq: 2, refreshPending: false,
      pendingCandidates: [{ stablecoinId: "coin-a", tier: "refresh" }],
    }, null, undefined);
  });

  it("does not advance the cohort after a failed checkpoint read", async () => {
    vi.mocked(readDiscoveryRunCheckpoint).mockRejectedValueOnce(new Error("checkpoint unavailable"));
    const result = await syncDexDiscovery(db, null);
    expect(result.status).toBe("error");
    expect(incrementRunSeq).not.toHaveBeenCalled();
    expect(crawlCoin).not.toHaveBeenCalled();
    expect(writeDiscoveryRunCheckpoint).not.toHaveBeenCalled();
  });

  it("reports a checkpoint write failure instead of claiming a durable continuation", async () => {
    vi.mocked(writeDiscoveryRunCheckpoint).mockResolvedValueOnce();
    vi.mocked(writeDiscoveryRunCheckpoint).mockRejectedValueOnce(new Error("checkpoint write failed"));
    const result = await syncDexDiscovery(db, null);
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "dex-discovery-persistence-failed",
      persistenceFailures: ["run-checkpoint"],
    });
  });

  it("returns degraded and preserves staging when the finalization tail budget is exhausted", async () => {
    vi.mocked(incrementRunSeq).mockResolvedValue(1);

    let nowMs = 1_700_000_000_000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    vi.mocked(crawlCoin).mockImplementation(async () => {
      nowMs += DEX_DISCOVERY_RUN_BUDGET_MS + 1_000;
      return {
        pools: [makeStagedPool("ethereum:0xpool1")],
        unresolvedChains: [],
        deploymentOutcomes: [{
          stablecoinId: "coin-a", chain: "ethereum", address: "0xaaa",
          outcome: "observed_pools", providers: ["coingecko"], reason: "Observed eligible pools",
          observedPoolCount: 1, observedAt: 1_700_000_000,
        }],
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
    expect(vi.mocked(upsertStagedPools)).toHaveBeenCalledWith(
      db,
      [expect.objectContaining({ poolId: "ethereum:0xpool1" })],
      undefined,
    );
    expect(vi.mocked(cleanupStaging)).not.toHaveBeenCalled();
    expect(upsertDexDeploymentOutcomes).toHaveBeenLastCalledWith(
      db,
      [expect.objectContaining({ outcome: "observed_pools", observedAt: 1_700_000_000 })],
      undefined,
    );
    expect(updateDiscoveryMeta).not.toHaveBeenCalled();

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata).toMatchObject({
      coinsCrawled: 0,
      poolsDiscovered: 0,
      budgetExhausted: true,
      stagingWritesSkippedForBudget: 0,
      cleanupSkippedForBudget: true,
      deploymentOutcomesWritten: 1,
      observedDeploymentOutcomesWritten: 1,
      finalizationTailBudgetMs: DEX_DISCOVERY_FINALIZATION_TAIL_BUDGET_MS,
      runSeq: 1,
      tierBreakdown: {
        refresh: 1,
        t1: 0,
        t2: 0,
        t3: 0,
        dormant: 0,
        skipped: 1,
      },
    });

    dateNowSpy.mockRestore();
  });

  it.each(["verified_no_pools", "provider_inaccessible"] as const)(
    "preserves completed %s census evidence without advancing the exhausted crawl",
    async (outcome) => {
      let nowMs = 1_700_000_000_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      const row = {
        stablecoinId: "coin-a", chain: "ethereum", address: "0xaaa",
        outcome, providers: ["coingecko"], observedPoolCount: 0, observedAt: 1_700_000_000,
        reason: outcome === "verified_no_pools"
          ? "A provider completed the direct-token query with no eligible pool"
          : "Provider census is not exhaustive for this chain",
      };
      vi.mocked(crawlCoin).mockImplementation(async () => {
        nowMs += DEX_DISCOVERY_RUN_BUDGET_MS + 1_000;
        return { pools: [], unresolvedChains: [], deploymentOutcomes: [row], checkedDeploymentKeys: [] };
      });

      const result = await syncDexDiscovery(db, null);

      expect(result.status).toBe("degraded");
      expect(upsertDexDeploymentOutcomes).toHaveBeenLastCalledWith(db, [row], undefined);
      expect(updateDiscoveryMeta).not.toHaveBeenCalled();
      expect(cleanupStaging).not.toHaveBeenCalled();
      expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
        coinsCrawled: 0, budgetExhausted: true, cleanupSkippedForBudget: true,
        deploymentOutcomesWritten: 1,
        observedDeploymentOutcomesWritten: outcome === "verified_no_pools" ? 1 : 0,
        outputPublishedAt: outcome === "verified_no_pools" ? 1_700_000_000 : null,
      });
      clock.mockRestore();
    },
  );

  it("reports budget exhaustion as findings after a completed crawl publishes and advances discovery meta", async () => {
    let nowMs = 1_700_000_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    vi.mocked(crawlCoin).mockImplementation(async () => {
      return { pools: [makeStagedPool("ethereum:0xpool1")], unresolvedChains: [], deploymentOutcomes: [], checkedDeploymentKeys: [] };
    });
    vi.mocked(updateDiscoveryMeta).mockImplementationOnce(async () => {
      nowMs += DEX_DISCOVERY_RUN_BUDGET_MS + 1_000;
    });
    const result = await syncDexDiscovery(db, null);
    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(1);
    expect(updateDiscoveryMeta).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      budgetExhausted: true, quality: { reasons: ["dex-discovery-budget-exhausted"] },
    });
    clock.mockRestore();
  });

  it("fences prior deployment outcomes before recording a failed crawl", async () => {
    vi.mocked(crawlCoin).mockRejectedValueOnce(new Error("provider unavailable"));

    const result = await syncDexDiscovery(db, null);

    expect(result.status).toBe("ok");
    expect(JSON.parse(result.metadata ?? "{}").quality.reasons).toContain("dex-discovery-coins-failed");
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
      persistenceFailedCoins: ["coin-a"],
      reason: "dex-discovery-persistence-failed",
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
