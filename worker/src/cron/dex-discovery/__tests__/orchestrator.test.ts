import { describe, expect, it } from "vitest";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import {
  DEX_DISCOVERY_BOUNDED_CRAWL_REASON,
  DEX_DISCOVERY_FAILED_CRAWL_REASON,
} from "@shared/lib/dex-deployment-coverage";
import type { ContractDeployment } from "@shared/types/core";
import type { DiscoveryMeta } from "../types";
import { DISCOVERY_TIERS, STAGED_POOL_FRESH_HOURS } from "../types";
import { getTrackedContracts } from "../../dex-liquidity/pool-helpers";
import {
  DEX_DEPLOYMENT_CENSUS_MAX_AGE_SEC,
  type DexDeploymentCensusRow,
} from "../../dex-liquidity/deployment-census-coverage";
import {
  compareDiscoveryMeta,
  computeEffectiveTier,
  DEX_DISCOVERY_OUTCOME_REVISIT_SEC,
  DEX_DISCOVERY_VERIFIED_EMPTY_REVISIT_SEC,
  hasRemappedUnsupportedCensusRow,
  hasVerifiedEmptyCensus,
  isDiscoveryEvidenceRefreshDue,
  selectDueDiscoveryDeployments,
} from "../orchestrator";

const nowSec = 1710000000;

describe("computeEffectiveTier", () => {
  it("refreshes admitted supplemental coverage before expiry without changing weekly discovery", () => {
    const target = { chain: "ethereum", address: "0x1111111111111111111111111111111111111111", decimals: 18 };
    const meta: DiscoveryMeta = { stablecoinId: "coin-a", consecutiveMisses: 0,
      lastCrawlAt: nowSec - 18 * 3600, lastHitAt: nowSec - 18 * 3600 };
    expect(isDiscoveryEvidenceRefreshDue([target], meta, nowSec - 1)).toBe(false);
    expect(isDiscoveryEvidenceRefreshDue([target], meta, nowSec)).toBe(true);
    expect(computeEffectiveTier("coin-a", 20, 4, meta, 1, nowSec, false, true)).toBe("refresh");
    expect(computeEffectiveTier("coin-a", 20, 4, meta, 1, nowSec)).toBe("skip");
    const footprint = Array.from({ length: 30 }, (_, index) => ({ ...target,
      address: `0x${(index + 1).toString(16).padStart(40, "0")}` }));
    // Oversized footprints get every six-hour discovery tick.
    expect(isDiscoveryEvidenceRefreshDue(footprint, { ...meta, lastCrawlAt: nowSec - 6 * 3600 }, nowSec)).toBe(true);
    expect(isDiscoveryEvidenceRefreshDue(footprint, { ...meta, lastCrawlAt: nowSec - 5 * 3600 }, nowSec)).toBe(false);
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
        remappedUnsupportedCount: 0,
      }),
    ).toBe(true);
  });

  it("ignores the unsupported-chain remainder instead of demoting the reviewed scope", () => {
    expect(
      hasVerifiedEmptyCensus([ethereumTarget, unsupportedTarget], {
        verifiedNoPoolsCount: 1,
        observedPoolsCount: 0,
        providerSupportedInaccessibleCount: 0,
        remappedUnsupportedCount: 0,
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
        remappedUnsupportedCount: 0,
      }),
    ).toBe(false);
    // Pools were observed somewhere in the footprint.
    expect(
      hasVerifiedEmptyCensus([ethereumTarget], {
        verifiedNoPoolsCount: 1,
        observedPoolsCount: 1,
        providerSupportedInaccessibleCount: 0,
        remappedUnsupportedCount: 0,
      }),
    ).toBe(false);
    // A provider-supported deployment is still unanswered.
    expect(
      hasVerifiedEmptyCensus([ethereumTarget, secondEthereumTarget], {
        verifiedNoPoolsCount: 2,
        observedPoolsCount: 0,
        providerSupportedInaccessibleCount: 1,
        remappedUnsupportedCount: 0,
      }),
    ).toBe(false);
    // No census read at all, and a footprint with no reviewable deployment.
    expect(hasVerifiedEmptyCensus([ethereumTarget], undefined)).toBe(false);
    expect(
      hasVerifiedEmptyCensus([unsupportedTarget], {
        verifiedNoPoolsCount: 0,
        observedPoolsCount: 0,
        providerSupportedInaccessibleCount: 0,
        remappedUnsupportedCount: 0,
      }),
    ).toBe(false);
  });
});

describe("hasRemappedUnsupportedCensusRow", () => {
  const ethereumTarget: ContractDeployment = {
    chain: "ethereum",
    address: "0x1111111111111111111111111111111111111111",
    decimals: 18,
  };
  const providerlessTarget: ContractDeployment = { chain: "hive", address: "hbd", decimals: 3 };
  const summary = {
    verifiedNoPoolsCount: 0,
    observedPoolsCount: 0,
    providerSupportedInaccessibleCount: 0,
    remappedUnsupportedCount: 1,
  };

  it("schedules a stale unsupported-chain row on a now-mapped chain for re-census", () => {
    expect(hasRemappedUnsupportedCensusRow([ethereumTarget], summary)).toBe(true);
    // The remapped row flips a deep-in-the-ladder dormant coin out of its
    // daily/weekly sleep into the refresh tier, so the crawl rotation
    // overwrites the row instead of keeping it.
    const meta: DiscoveryMeta = {
      stablecoinId: "coin-a",
      consecutiveMisses: DISCOVERY_TIERS.BACKOFF_DORMANT_MISSES,
      lastCrawlAt: nowSec - 2 * DISCOVERY_TIERS.DORMANT_INTERVAL_SEC,
      lastHitAt: null,
    };
    expect(computeEffectiveTier("coin-a", 0, 0, meta, 1, nowSec, false, false)).toBe("skip");
    expect(
      computeEffectiveTier(
        "coin-a",
        0,
        0,
        meta,
        1,
        nowSec,
        false,
        hasRemappedUnsupportedCensusRow([ethereumTarget], summary) &&
          isDiscoveryEvidenceRefreshDue([ethereumTarget], meta, nowSec),
      ),
    ).toBe("refresh");
  });

  it("keeps the ladder untouched without a remapped row or a supported target", () => {
    expect(hasRemappedUnsupportedCensusRow([ethereumTarget], { ...summary, remappedUnsupportedCount: 0 })).toBe(false);
    expect(hasRemappedUnsupportedCensusRow([providerlessTarget], summary)).toBe(false);
    expect(hasRemappedUnsupportedCensusRow([ethereumTarget], undefined)).toBe(false);
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

describe("verified-empty revisit interval", () => {
  const target: ContractDeployment = {
    chain: "ethereum",
    address: "0x1111111111111111111111111111111111111111",
    decimals: 18,
  };

  it("revisits a census-complete footprint at the census bound instead of the 18h sweep target", () => {
    expect(DEX_DISCOVERY_VERIFIED_EMPTY_REVISIT_SEC).toBe(
      DEX_DEPLOYMENT_CENSUS_MAX_AGE_SEC - CRON_INTERVALS["sync-dex-discovery"],
    );
    const meta: DiscoveryMeta = {
      stablecoinId: "coin-a",
      consecutiveMisses: 12,
      lastCrawlAt: nowSec - DEX_DISCOVERY_VERIFIED_EMPTY_REVISIT_SEC + 1,
      lastHitAt: null,
    };
    // The ordinary 18h sweep target is already past.
    expect(isDiscoveryEvidenceRefreshDue([target], meta, nowSec)).toBe(true);
    // A verified-empty census waits for its own bound minus one tick.
    expect(isDiscoveryEvidenceRefreshDue([target], meta, nowSec, true)).toBe(false);
    expect(
      isDiscoveryEvidenceRefreshDue([target], meta, nowSec + 1, true),
    ).toBe(true);
    // An unfinished census keeps the aggressive maintenance cadence.
    expect(isDiscoveryEvidenceRefreshDue([target], meta, nowSec, false)).toBe(true);
  });

  it("keeps every revisit bound inside the published census freshness floor", () => {
    expect(DEX_DISCOVERY_OUTCOME_REVISIT_SEC.verifiedNoPools).toBeLessThan(
      DEX_DISCOVERY_VERIFIED_EMPTY_REVISIT_SEC,
    );
    expect(DEX_DISCOVERY_VERIFIED_EMPTY_REVISIT_SEC).toBeLessThan(DEX_DEPLOYMENT_CENSUS_MAX_AGE_SEC);
    expect(DEX_DISCOVERY_OUTCOME_REVISIT_SEC.observedPools).toBe(STAGED_POOL_FRESH_HOURS * 3600);
    expect(DEX_DISCOVERY_OUTCOME_REVISIT_SEC.observedPools).toBeLessThan(DEX_DEPLOYMENT_CENSUS_MAX_AGE_SEC);
  });
});

describe("deployment-grain due filter", () => {
  const current: ContractDeployment = {
    chain: "ethereum",
    address: "0x1111111111111111111111111111111111111111",
    decimals: 18,
  };
  const second: ContractDeployment = {
    chain: "ethereum",
    address: "0x2222222222222222222222222222222222222222",
    decimals: 18,
  };

  function storedRow(overrides: Partial<DexDeploymentCensusRow> = {}): DexDeploymentCensusRow {
    return {
      stablecoin_id: "coin-a",
      chain: "ethereum",
      contract_address: current.address,
      outcome: "verified_no_pools",
      provider_set_json: '["coingecko"]',
      reason: "A provider completed the direct-token query with no eligible pool",
      observed_pool_count: 0,
      observed_at: nowSec - 3_600,
      discovery_last_crawl_at: nowSec - 3_600,
      deployment_last_attempt_at: nowSec - 3_600,
      deployment_fence_attribution_at: nowSec - 3_600,
      ...overrides,
    };
  }

  it("skips a verified-empty deployment until its revisit bound", () => {
    expect(selectDueDiscoveryDeployments({
      targets: [current], rows: [storedRow()], nowSec,
    })).toEqual({ due: [], current: [current] });
    expect(selectDueDiscoveryDeployments({
      targets: [current],
      rows: [storedRow({
        observed_at: nowSec - DEX_DISCOVERY_OUTCOME_REVISIT_SEC.verifiedNoPools,
        discovery_last_crawl_at: nowSec - DEX_DISCOVERY_OUTCOME_REVISIT_SEC.verifiedNoPools,
        deployment_last_attempt_at: nowSec - DEX_DISCOVERY_OUTCOME_REVISIT_SEC.verifiedNoPools,
        deployment_fence_attribution_at: nowSec - DEX_DISCOVERY_OUTCOME_REVISIT_SEC.verifiedNoPools,
      })],
      nowSec,
    })).toEqual({ due: [], current: [current] });
    // One second past the bound the deployment is due again.
    expect(selectDueDiscoveryDeployments({
      targets: [current],
      rows: [storedRow({
        observed_at: nowSec - DEX_DISCOVERY_OUTCOME_REVISIT_SEC.verifiedNoPools - 1,
        discovery_last_crawl_at: nowSec - DEX_DISCOVERY_OUTCOME_REVISIT_SEC.verifiedNoPools - 1,
        deployment_last_attempt_at: nowSec - DEX_DISCOVERY_OUTCOME_REVISIT_SEC.verifiedNoPools - 1,
        deployment_fence_attribution_at: nowSec - DEX_DISCOVERY_OUTCOME_REVISIT_SEC.verifiedNoPools - 1,
      })],
      nowSec,
    })).toEqual({ due: [current], current: [] });
  });

  it("keeps an observed-pools deployment only inside the staged-pool freshness window", () => {
    const observed = storedRow({
      outcome: "observed_pools",
      reason: "At least one eligible direct-token pool was observed",
      observed_pool_count: 2,
      observed_at: nowSec - DEX_DISCOVERY_OUTCOME_REVISIT_SEC.observedPools,
      discovery_last_crawl_at: nowSec - DEX_DISCOVERY_OUTCOME_REVISIT_SEC.observedPools,
      deployment_last_attempt_at: nowSec - DEX_DISCOVERY_OUTCOME_REVISIT_SEC.observedPools,
      deployment_fence_attribution_at: nowSec - DEX_DISCOVERY_OUTCOME_REVISIT_SEC.observedPools,
    });
    expect(selectDueDiscoveryDeployments({ targets: [current], rows: [observed], nowSec }))
      .toEqual({ due: [], current: [current] });
    const older = nowSec - DEX_DISCOVERY_OUTCOME_REVISIT_SEC.observedPools - 1;
    expect(selectDueDiscoveryDeployments({
      targets: [current],
      rows: [{
        ...observed,
        observed_at: older,
        discovery_last_crawl_at: older,
        deployment_last_attempt_at: older,
        deployment_fence_attribution_at: older,
      }],
      nowSec,
    })).toEqual({ due: [current], current: [] });
  });

  it("re-reads an outcome superseded by a newer attempt instead of trusting its old empty answer", () => {
    expect(selectDueDiscoveryDeployments({
      targets: [current],
      rows: [storedRow({
        discovery_last_crawl_at: nowSec - 60,
        deployment_last_attempt_at: nowSec - 60,
        deployment_fence_attribution_at: nowSec - 60,
      })],
      nowSec,
    })).toEqual({ due: [current], current: [] });
  });

  it("keeps an interrupted attempt and a provider-set change due", () => {
    for (const reason of [DEX_DISCOVERY_BOUNDED_CRAWL_REASON, DEX_DISCOVERY_FAILED_CRAWL_REASON]) {
      expect(selectDueDiscoveryDeployments({
        targets: [current],
        rows: [storedRow({ outcome: "provider_inaccessible", reason })],
        nowSec,
      })).toEqual({ due: [current], current: [] });
    }
    // Naming a provider the registry no longer resolves for this deployment
    // makes the row superseded metadata, not a current census answer.
    expect(selectDueDiscoveryDeployments({
      targets: [current],
      rows: [storedRow({ provider_set_json: '["aquarius"]' })],
      nowSec,
    })).toEqual({ due: [current], current: [] });
  });

  it("keeps only the deployments without a complete current row due", () => {
    expect(selectDueDiscoveryDeployments({
      targets: [current, second],
      rows: [storedRow()],
      nowSec,
    })).toEqual({ due: [second], current: [current] });
  });
});

describe("compareDiscoveryMeta", () => {
  it("sorts never-crawled coins before previously crawled coins", () => {
    const coins = [{ id: "seen" }, { id: "never" }];
    const metaById = new Map<string, DiscoveryMeta>([
      ["seen", { stablecoinId: "seen", consecutiveMisses: 0, lastCrawlAt: 1000, lastHitAt: null }],
    ]);

    coins.sort((a, b) => compareDiscoveryMeta(metaById.get(a.id), metaById.get(b.id)));

    expect(coins.map((coin) => coin.id)).toEqual(["never", "seen"]);
  });

  it("sorts older crawls before newer crawls", () => {
    const coins = [{ id: "newer" }, { id: "older" }];
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
    const canonical = { chain: "ethereum", address: "0xaaa", decimals: 6 };
    const traded = { chain: "ethereum", address: "0xbbb", decimals: 6 };
    const targets = getTrackedContracts({ contracts: [canonical], tradedContracts: [traded, canonical] });
    expect(targets).toEqual([canonical, traded]);
  });
});
