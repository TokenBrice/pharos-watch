import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type { DiscoveryMeta } from "../types";
import { getTrackedContracts } from "../../dex-liquidity/pool-helpers";
import {
  compareDiscoveryMeta,
  computeEffectiveTier,
  isEligibleThisRun,
} from "../orchestrator";

const nowSec = 1710000000;

describe("computeEffectiveTier", () => {
  it("applies base tiers and cadence gating", () => {
    expect(computeEffectiveTier(0, 0, undefined, 1, nowSec)).toBe("t1");
    expect(computeEffectiveTier(3, 1, undefined, 1, nowSec)).toBe("skip");
    expect(computeEffectiveTier(3, 1, undefined, 3, nowSec)).toBe("t2");
    expect(computeEffectiveTier(5, 2, undefined, 1, nowSec)).toBe("skip");
    expect(computeEffectiveTier(5, 2, undefined, 10, nowSec)).toBe("t3");
  });

  it("demotes missed coins to lower cadences", () => {
    const meta: DiscoveryMeta = {
      stablecoinId: "x",
      consecutiveMisses: 5,
      lastCrawlAt: nowSec - 100,
      lastHitAt: null,
    };

    expect(computeEffectiveTier(0, 0, meta, 1, nowSec)).toBe("skip");
    expect(computeEffectiveTier(0, 0, meta, 3, nowSec)).toBe("t2");
  });

  it("puts long-miss coins into dormant mode with daily gating", () => {
    const recentDormant: DiscoveryMeta = {
      stablecoinId: "x",
      consecutiveMisses: 10,
      lastCrawlAt: nowSec - 100,
      lastHitAt: null,
    };
    const staleDormant: DiscoveryMeta = {
      stablecoinId: "x",
      consecutiveMisses: 10,
      lastCrawlAt: nowSec - 86401,
      lastHitAt: null,
    };

    expect(computeEffectiveTier(0, 0, recentDormant, 1, nowSec)).toBe("skip");
    expect(computeEffectiveTier(0, 0, staleDormant, 10, nowSec)).toBe("dormant");
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

    const tier = computeEffectiveTier(0, 0, meta, 1, nowSec);
    expect(tier).toBe("t1");
  });

  it("dormant coin becomes eligible after 24h", () => {
    const meta: DiscoveryMeta = {
      stablecoinId: "test-coin",
      consecutiveMisses: 15,
      lastCrawlAt: nowSec - 86401,
      lastHitAt: null,
    };

    const tier = computeEffectiveTier(0, 0, meta, 10, nowSec);
    expect(tier).not.toBe("skip");
  });

  it("dormant coin with recent crawl is skipped", () => {
    const meta: DiscoveryMeta = {
      stablecoinId: "test-coin",
      consecutiveMisses: 15,
      lastCrawlAt: nowSec - 3600,
      lastHitAt: null,
    };

    const tier = computeEffectiveTier(0, 0, meta, 10, nowSec);
    expect(tier).toBe("skip");
  });
});
