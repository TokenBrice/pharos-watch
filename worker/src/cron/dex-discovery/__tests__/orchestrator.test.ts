import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import type { ContractDeployment } from "@shared/types/core";
import type { DiscoveryMeta } from "../types";
import { DISCOVERY_TIERS } from "../types";
import { getTrackedContracts } from "../../dex-liquidity/pool-helpers";
import {
  compareDiscoveryMeta,
  computeEffectiveTier,
  hasVerifiedEmptyCensus,
  isEligibleThisRun,
  isSupplementalRefreshDue,
} from "../orchestrator";

const nowSec = 1710000000;

describe("computeEffectiveTier", () => {
  it("refreshes admitted supplemental coverage before expiry without changing weekly discovery", () => {
    const target = { chain: "ethereum", address: "0x1111111111111111111111111111111111111111", decimals: 18 };
    const meta: DiscoveryMeta = { stablecoinId: "coin-a", consecutiveMisses: 0,
      lastCrawlAt: nowSec - 18 * 3600, lastHitAt: nowSec - 18 * 3600 };
    expect(isSupplementalRefreshDue([target], meta, nowSec - 1)).toBe(false);
    expect(isSupplementalRefreshDue([target], meta, nowSec)).toBe(true);
    expect(computeEffectiveTier("coin-a", 20, 4, meta, 1, nowSec, false, true)).toBe("refresh");
    expect(computeEffectiveTier("coin-a", 20, 4, meta, 1, nowSec)).toBe("skip");
    const footprint = Array.from({ length: 30 }, (_, index) => ({ ...target,
      address: `0x${(index + 1).toString(16).padStart(40, "0")}` }));
    expect(isSupplementalRefreshDue(footprint, { ...meta, lastCrawlAt: nowSec - 2 * 3600 }, nowSec)).toBe(true);
    expect(isSupplementalRefreshDue(footprint, { ...meta, lastCrawlAt: nowSec - 3600 }, nowSec)).toBe(false);
  });

  it("applies base tiers and weekly cadence gating", () => {
    expect(computeEffectiveTier("coin-a", 0, 0, undefined, 1, nowSec)).toBe("t1");
    expect(computeEffectiveTier("coin-a", 3, 1, undefined, 1, nowSec)).toBe("skip");
    expect(computeEffectiveTier("coin-91", 3, 1, undefined, 84, nowSec)).toBe("t2");
    expect(computeEffectiveTier("coin-d", 5, 2, undefined, 1, nowSec)).toBe("skip");
    expect(computeEffectiveTier("coin-91", 5, 2, undefined, 84, nowSec)).toBe("t3");
  });

  it("shards lower-tier weekly cadence by stablecoin id", () => {
    expect(computeEffectiveTier("coin-91", 3, 1, undefined, 84, nowSec)).toBe("t2");
    expect(computeEffectiveTier("coin-92", 3, 1, undefined, 84, nowSec)).toBe("skip");
    expect(computeEffectiveTier("coin-92", 3, 1, undefined, 85, nowSec)).toBe("t2");
  });

  it("demotes missed coins to lower cadences", () => {
    const meta: DiscoveryMeta = {
      stablecoinId: "coin-91",
      consecutiveMisses: 5,
      lastCrawlAt: nowSec - 100,
      lastHitAt: null,
    };

    expect(computeEffectiveTier("coin-91", 0, 0, meta, 1, nowSec)).toBe("skip");
    expect(computeEffectiveTier("coin-91", 0, 0, meta, 84, nowSec)).toBe("t2");
  });

  it("puts long-miss coins into dormant mode with daily gating", () => {
    const recentDormant: DiscoveryMeta = {
      stablecoinId: "coin-91",
      consecutiveMisses: 10,
      lastCrawlAt: nowSec - 100,
      lastHitAt: null,
    };
    const staleDormant: DiscoveryMeta = {
      stablecoinId: "coin-91",
      consecutiveMisses: 10,
      lastCrawlAt: nowSec - 86401,
      lastHitAt: null,
    };

    expect(computeEffectiveTier("coin-91", 0, 0, recentDormant, 1, nowSec)).toBe("skip");
    expect(computeEffectiveTier("coin-91", 0, 0, staleDormant, 84, nowSec)).toBe("dormant");
  });
});

describe("hasVerifiedEmptyCensus", () => {
  const ethereumTarget: ContractDeployment = {
    chain: "ethereum",
    address: "0x1111111111111111111111111111111111111111",
    decimals: 18,
  };
  const secondEthereumTarget: ContractDeployment = {
    chain: "ethereum",
    address: "0x2222222222222222222222222222222222222222",
    decimals: 18,
  };
  const unsupportedTarget: ContractDeployment = { chain: "hive", address: "hbd", decimals: 3 };

  it("holds when every provider-supported deployment is verified empty", () => {
    expect(
      hasVerifiedEmptyCensus([ethereumTarget, secondEthereumTarget], {
        verifiedNoPoolsCount: 2,
        observedPoolsCount: 0,
        providerSupportedInaccessibleCount: 0,
      }),
    ).toBe(true);
  });

  it("ignores the unsupported-chain remainder instead of demoting the reviewed scope", () => {
    expect(
      hasVerifiedEmptyCensus([ethereumTarget, unsupportedTarget], {
        verifiedNoPoolsCount: 1,
        observedPoolsCount: 0,
        providerSupportedInaccessibleCount: 0,
      }),
    ).toBe(true);
  });

  it("does not hold on a partial, contradicted, or unanswered census", () => {
    // A missing outcome row for one of two supported deployments.
    expect(
      hasVerifiedEmptyCensus([ethereumTarget, secondEthereumTarget], {
        verifiedNoPoolsCount: 1,
        observedPoolsCount: 0,
        providerSupportedInaccessibleCount: 0,
      }),
    ).toBe(false);
    // Pools were observed somewhere in the footprint.
    expect(
      hasVerifiedEmptyCensus([ethereumTarget], {
        verifiedNoPoolsCount: 1,
        observedPoolsCount: 1,
        providerSupportedInaccessibleCount: 0,
      }),
    ).toBe(false);
    // A provider-supported deployment is still unanswered.
    expect(
      hasVerifiedEmptyCensus([ethereumTarget, secondEthereumTarget], {
        verifiedNoPoolsCount: 2,
        observedPoolsCount: 0,
        providerSupportedInaccessibleCount: 1,
      }),
    ).toBe(false);
    // No census read at all, and a footprint with no reviewable deployment.
    expect(hasVerifiedEmptyCensus([ethereumTarget], undefined)).toBe(false);
    expect(
      hasVerifiedEmptyCensus([unsupportedTarget], {
        verifiedNoPoolsCount: 0,
        observedPoolsCount: 0,
        providerSupportedInaccessibleCount: 0,
      }),
    ).toBe(false);
  });
});

describe("verified-empty census cadence (ODR-B1a)", () => {
  const RUN_INTERVAL_SEC = CRON_INTERVALS["sync-dex-discovery"];

  /**
   * Replay the real run loop for a coin whose honest answer is "no pools
   * anywhere": every crawl finds zero pools, so `updateDiscoveryMeta`
   * increments `consecutive_misses` on every eligible run.
   */
  function simulateZeroPoolRuns(
    stablecoinId: string,
    censusVerifiedEmpty: boolean,
    runCount: number,
  ): { tiers: (string | null)[]; crawlRuns: number[] } {
    const meta: DiscoveryMeta = {
      stablecoinId,
      consecutiveMisses: 0,
      lastCrawlAt: 0,
      lastHitAt: null,
    };
    const tiers: (string | null)[] = [];
    const crawlRuns: number[] = [];
    for (let run = 1; run <= runCount; run++) {
      const runNowSec = nowSec + run * RUN_INTERVAL_SEC;
      const tier = computeEffectiveTier(
        stablecoinId,
        0,
        0,
        meta,
        run,
        runNowSec,
        censusVerifiedEmpty,
      );
      tiers.push(tier === "skip" ? null : tier);
      if (tier !== "skip") {
        crawlRuns.push(run);
        meta.consecutiveMisses += 1;
        meta.lastCrawlAt = runNowSec;
      }
    }
    return { tiers, crawlRuns };
  }

  function maxGapRuns(crawlRuns: number[], runCount: number): number {
    let gap = crawlRuns.length > 0 ? crawlRuns[0]! : runCount;
    for (let i = 1; i < crawlRuns.length; i++) {
      gap = Math.max(gap, crawlRuns[i]! - crawlRuns[i - 1]!);
    }
    return Math.max(gap, runCount - (crawlRuns[crawlRuns.length - 1] ?? 0));
  }

  it("holds a census-adequate tier across a long zero-pool run sequence", () => {
    const runCount = 1_000;
    const { tiers, crawlRuns } = simulateZeroPoolRuns("coin-91", true, runCount);

    // The ladder still backs the coin off, it just never reaches dormant.
    expect(tiers.some((tier) => tier === "t1")).toBe(true);
    expect(tiers.some((tier) => tier === "t3")).toBe(true);
    expect(tiers).not.toContain("dormant");

    // Weekly t3 cadence is the explicit freshness contract for this replay.
    const gapRuns = maxGapRuns(crawlRuns, runCount);
    expect(gapRuns).toBeLessThanOrEqual(DISCOVERY_TIERS.T3_MODULO);
    expect(gapRuns * RUN_INTERVAL_SEC).toBe(
      DISCOVERY_TIERS.T3_MODULO * RUN_INTERVAL_SEC,
    );
  });

  it("still demotes an unanswered zero-pool footprint to dormant", () => {
    const { tiers } = simulateZeroPoolRuns("coin-91", false, 1_000);
    expect(tiers).toContain("dormant");
  });

  it("keeps the dormant ladder for a coin whose census is not verified empty", () => {
    const meta: DiscoveryMeta = {
      stablecoinId: "coin-91",
      consecutiveMisses: DISCOVERY_TIERS.BACKOFF_DORMANT_MISSES,
      lastCrawlAt: nowSec - DISCOVERY_TIERS.DORMANT_INTERVAL_SEC - 1,
      lastHitAt: null,
    };
    expect(computeEffectiveTier("coin-91", 0, 0, meta, 84, nowSec, false)).toBe("dormant");
    expect(computeEffectiveTier("coin-91", 0, 0, meta, 84, nowSec, true)).toBe("t3");
  });

  it("never returns the dormant daily skip for a verified-empty census", () => {
    const meta: DiscoveryMeta = {
      stablecoinId: "coin-91",
      consecutiveMisses: 114,
      lastCrawlAt: nowSec - 100,
      lastHitAt: null,
    };
    expect(computeEffectiveTier("coin-91", 0, 0, meta, 84, nowSec, false)).toBe("skip");
    expect(computeEffectiveTier("coin-91", 0, 0, meta, 84, nowSec, true)).toBe("t3");
  });
});

describe("isEligibleThisRun", () => {
  it("treats only skip as ineligible", () => {
    expect(isEligibleThisRun("t1")).toBe(true);
    expect(isEligibleThisRun("t2")).toBe(true);
    expect(isEligibleThisRun("t3")).toBe(true);
    expect(isEligibleThisRun("dormant")).toBe(true);
    expect(isEligibleThisRun("skip")).toBe(false);
  });
});

describe("compareDiscoveryMeta", () => {
  it("sorts never-crawled coins before previously crawled coins", () => {
    const coins = [{ id: "never" }, { id: "seen" }];
    const metaById = new Map<string, DiscoveryMeta>([
      ["seen", { stablecoinId: "seen", consecutiveMisses: 0, lastCrawlAt: 1000, lastHitAt: null }],
    ]);

    coins.sort((a, b) => compareDiscoveryMeta(metaById.get(a.id), metaById.get(b.id)));

    expect(coins.map((coin) => coin.id)).toEqual(["never", "seen"]);
  });

  it("sorts older crawls before newer crawls", () => {
    const coins = [{ id: "older" }, { id: "newer" }];
    const metaById = new Map<string, DiscoveryMeta>([
      ["older", { stablecoinId: "older", consecutiveMisses: 0, lastCrawlAt: 500, lastHitAt: null }],
      ["newer", { stablecoinId: "newer", consecutiveMisses: 0, lastCrawlAt: 1000, lastHitAt: null }],
    ]);

    coins.sort((a, b) => compareDiscoveryMeta(metaById.get(a.id), metaById.get(b.id)));

    expect(coins.map((coin) => coin.id)).toEqual(["older", "newer"]);
  });
});

describe("chain-aware routing", () => {
  it("discovery targets include traded contracts and preserve same-chain deployments", () => {
    const usdt = ACTIVE_STABLECOINS.find((stablecoin) => stablecoin.id === "usdt-tether");
    expect(usdt).toBeDefined();
    expect(usdt?.tradedContracts?.length ?? 0).toBeGreaterThan(0);

    const targets = getTrackedContracts(usdt!);

    expect(targets.some((contract) =>
      usdt?.tradedContracts?.some((traded) =>
        traded.chain === contract.chain && traded.address === contract.address
      )
    )).toBe(true);
    expect(targets.length).toBeGreaterThanOrEqual((usdt?.contracts?.length ?? 0) + (usdt?.tradedContracts?.length ?? 0) - 1);
  });
});

describe("backoff reset integration", () => {
  const nowSec = 1710000000;

  it("after miss reset, coin returns to base tier", () => {
    const meta: DiscoveryMeta = {
      stablecoinId: "test-coin",
      consecutiveMisses: 0,
      lastCrawlAt: nowSec - 100,
      lastHitAt: nowSec - 100,
    };

    const tier = computeEffectiveTier("test-coin", 0, 0, meta, 1, nowSec);
    expect(tier).toBe("t1");
  });

  it("dormant coin becomes eligible after 24h", () => {
    const meta: DiscoveryMeta = {
      stablecoinId: "coin-91",
      consecutiveMisses: 15,
      lastCrawlAt: nowSec - 86401,
      lastHitAt: null,
    };

    const tier = computeEffectiveTier("coin-91", 0, 0, meta, 84, nowSec);
    expect(tier).not.toBe("skip");
  });

  it("dormant coin with recent crawl is skipped", () => {
    const meta: DiscoveryMeta = {
      stablecoinId: "coin-91",
      consecutiveMisses: 15,
      lastCrawlAt: nowSec - 3600,
      lastHitAt: null,
    };

    const tier = computeEffectiveTier("coin-91", 0, 0, meta, 84, nowSec);
    expect(tier).toBe("skip");
  });
});
