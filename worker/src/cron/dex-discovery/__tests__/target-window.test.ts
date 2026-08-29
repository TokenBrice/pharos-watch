import { describe, expect, it } from "vitest";
import type { ContractDeployment } from "@shared/types/core";
import {
  advanceDiscoveryTargetCursor,
  DEX_DISCOVERY_PER_COIN_BUDGET_MS,
  DISCOVERY_WINDOWED_CRAWL_INTERVAL_SEC,
  discoveryTargetCursorKey,
  estimateDeploymentCrawlCostMs,
  estimateDiscoverySweepPeriodSec,
  estimateDiscoverySweepWindowCount,
  selectDiscoveryTargetWindow,
} from "../target-window";

// CoinGecko on-chain chains are the cheap head of a crawl; the GeckoTerminal-only
// chains are the 2s-paced tail that used to be starved every run.
const CG_CHAINS = [
  "ethereum",
  "arbitrum",
  "base",
  "optimism",
  "polygon",
  "avalanche",
  "celo",
  "gnosis",
  "bsc",
  "fantom",
];
const GT_ONLY_CHAINS = [
  "linea",
  "scroll",
  "mantle",
  "mode",
  "manta",
  "zksync",
  "sonic",
  "taiko",
  "unichain",
  "worldchain",
];

function deployment(chain: string, index: number): ContractDeployment {
  return { chain, address: `0x${(index + 1).toString(16).padStart(40, "0")}`, decimals: 18 };
}

const megaFootprint: ContractDeployment[] = [...CG_CHAINS, ...GT_ONLY_CHAINS].map(deployment);

function windowCost(targets: readonly ContractDeployment[]): number {
  return targets.reduce((sum, target) => sum + estimateDeploymentCrawlCostMs(target.chain), 0);
}

function keysOf(targets: readonly ContractDeployment[]): string[] {
  return targets.map(discoveryTargetCursorKey);
}

/** Simulate consecutive runs where every windowed target is reached. */
function sweep(
  targets: readonly ContractDeployment[],
  runs: number,
  budgetMs = DEX_DISCOVERY_PER_COIN_BUDGET_MS,
): { windows: string[][]; cursors: (string | null)[] } {
  let cursor: string | null = null;
  const windows: string[][] = [];
  const cursors: (string | null)[] = [];
  for (let run = 0; run < runs; run++) {
    const selected = selectDiscoveryTargetWindow({ targets, cursor, budgetMs });
    windows.push(keysOf(selected.targets));
    cursor = advanceDiscoveryTargetCursor(selected.targets, new Set(keysOf(selected.targets)));
    cursors.push(cursor);
  }
  return { windows, cursors };
}

describe("estimateDeploymentCrawlCostMs", () => {
  it("prices every registered stage instead of only the first provider", () => {
    expect(estimateDeploymentCrawlCostMs("ethereum")).toBeGreaterThan(
      estimateDeploymentCrawlCostMs("linea"),
    );
  });

  it("charges nothing for chains with no registered discovery provider", () => {
    expect(estimateDeploymentCrawlCostMs("not-a-chain")).toBe(0);
  });

  it("prices native Horizon and Aquarius queries for Stellar", () => {
    expect(estimateDeploymentCrawlCostMs("stellar")).toBe(1_600);
    expect(
      estimateDeploymentCrawlCostMs(
        "stellar",
        "EURC-GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2",
      ),
    ).toBe(1_600);
    expect(
      estimateDeploymentCrawlCostMs(
        "stellar",
        "CDWOB6T7SVSMMQN5V3P2OPTBAXOP7DAZHGVW3PYTZIKHVFKN6TBSXR6A",
      ),
    ).toBe(8_000);
  });

  it("prices each newly registered census stage", () => {
    expect(estimateDeploymentCrawlCostMs("tezos", "KT1XRPEPXbZK25r3Htzp2o1x7xdMMmfocKNW")).toBe(16_000);
    expect(estimateDeploymentCrawlCostMs("icon", "cx88fd7df7ddff82f7cc735c871dc519838cb235bb")).toBe(8_000);
    expect(estimateDeploymentCrawlCostMs("kava", "usdx")).toBeGreaterThan(16_000);
  });

  it("prices only EVM-shaped MANTRA deployments for GeckoTerminal", () => {
    expect(estimateDeploymentCrawlCostMs("mantra", "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b")).toBe(
      2_800,
    );
    expect(
      estimateDeploymentCrawlCostMs(
        "mantra",
        "ibc/6749D16BC09F419C090C330FC751FFF1C96143DB7A4D2FCAEC2F348A3E17618A",
      ),
    ).toBe(0);
  });

  it("prices the registered Hedera and Injective GeckoTerminal queries", () => {
    expect(estimateDeploymentCrawlCostMs("hedera", "0.0.6070123")).toBe(2_800);
    expect(
      estimateDeploymentCrawlCostMs(
        "injective",
        "factory/inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk/inj1qspaxnztkkzahvp6scq6xfpgafejmj2td83r9j",
      ),
    ).toBe(2_800);
  });
});

describe("selectDiscoveryTargetWindow", () => {
  it("leaves a footprint that fits the per-coin budget untouched", () => {
    const targets = CG_CHAINS.slice(0, 3).map(deployment);
    const selected = selectDiscoveryTargetWindow({
      targets,
      cursor: null,
      budgetMs: DEX_DISCOVERY_PER_COIN_BUDGET_MS,
    });

    expect(selected.windowed).toBe(false);
    expect(keysOf(selected.targets)).toEqual(keysOf(targets));
  });

  it("windows an oversized footprint without exceeding the per-coin budget", () => {
    const selected = selectDiscoveryTargetWindow({
      targets: megaFootprint,
      cursor: null,
      budgetMs: DEX_DISCOVERY_PER_COIN_BUDGET_MS,
    });

    expect(selected.windowed).toBe(true);
    expect(selected.targets.length).toBeLessThan(megaFootprint.length);
    expect(windowCost(selected.targets)).toBeLessThanOrEqual(DEX_DISCOVERY_PER_COIN_BUDGET_MS);
    expect(selected.totalEstimatedCostMs).toBeGreaterThan(DEX_DISCOVERY_PER_COIN_BUDGET_MS);
  });

  it("is deterministic for the same footprint and cursor", () => {
    const first = selectDiscoveryTargetWindow({
      targets: megaFootprint,
      cursor: discoveryTargetCursorKey(megaFootprint[3]!),
      budgetMs: DEX_DISCOVERY_PER_COIN_BUDGET_MS,
    });
    const second = selectDiscoveryTargetWindow({
      targets: megaFootprint,
      cursor: discoveryTargetCursorKey(megaFootprint[3]!),
      budgetMs: DEX_DISCOVERY_PER_COIN_BUDGET_MS,
    });

    expect(keysOf(first.targets)).toEqual(keysOf(second.targets));
  });

  it("resumes after the cursor so consecutive runs crawl different tails", () => {
    const { windows } = sweep(megaFootprint, 2);

    expect(windows[0]).not.toEqual(windows[1]);
    expect(windows[1]![0]).not.toBe(windows[0]![0]);
  });

  it("covers every deployment across the runs one rotation needs", () => {
    const totalCostMs = windowCost(megaFootprint);
    const runsPerRotation = Math.ceil(totalCostMs / DEX_DISCOVERY_PER_COIN_BUDGET_MS);
    const { windows } = sweep(megaFootprint, runsPerRotation);

    expect(new Set(windows.flat())).toEqual(new Set(keysOf(megaFootprint)));
  });

  it("restarts the rotation from the first deployment when the cursor is unknown", () => {
    const fromMissingCursor = selectDiscoveryTargetWindow({
      targets: megaFootprint,
      cursor: "retired-chain:0xdead",
      budgetMs: DEX_DISCOVERY_PER_COIN_BUDGET_MS,
    });
    const fromNoCursor = selectDiscoveryTargetWindow({
      targets: megaFootprint,
      cursor: null,
      budgetMs: DEX_DISCOVERY_PER_COIN_BUDGET_MS,
    });

    expect(keysOf(fromMissingCursor.targets)).toEqual(keysOf(fromNoCursor.targets));
  });

  it("always admits at least one deployment even when it alone overruns the budget", () => {
    const selected = selectDiscoveryTargetWindow({
      targets: megaFootprint,
      cursor: null,
      budgetMs: 1,
    });

    expect(selected.targets).toHaveLength(1);
  });
});

describe("estimateDiscoverySweepWindowCount", () => {
  it("needs no window for an empty footprint", () => {
    expect(estimateDiscoverySweepWindowCount([])).toBe(0);
  });

  it("sweeps a footprint that fits the per-coin budget in one window", () => {
    expect(estimateDiscoverySweepWindowCount(CG_CHAINS.slice(0, 3).map(deployment))).toBe(1);
  });

  it("matches the runs one real rotation needs for an oversized footprint", () => {
    const windows = estimateDiscoverySweepWindowCount(megaFootprint);
    expect(windows).toBeGreaterThan(1);

    const full = sweep(megaFootprint, windows);
    expect(new Set(full.windows.flat())).toEqual(new Set(keysOf(megaFootprint)));

    const short = sweep(megaFootprint, windows - 1);
    expect(new Set(short.windows.flat()).size).toBeLessThan(megaFootprint.length);
  });

  it("prices a repeated deployment once, like the crawl footprint", () => {
    expect(estimateDiscoverySweepWindowCount([...megaFootprint, ...megaFootprint])).toBe(
      estimateDiscoverySweepWindowCount(megaFootprint),
    );
  });

  it("never decreases as the footprint grows", () => {
    let previous = 0;
    for (let length = 1; length <= megaFootprint.length; length++) {
      const windows = estimateDiscoverySweepWindowCount(megaFootprint.slice(0, length));
      expect(windows).toBeGreaterThanOrEqual(previous);
      previous = windows;
    }
    expect(previous).toBe(estimateDiscoverySweepWindowCount(megaFootprint));
  });
});

describe("estimateDiscoverySweepPeriodSec", () => {
  it("spends one t3 cohort cadence per window", () => {
    // Ten two-hour discovery runs between crawls of the same t3 cohort coin.
    expect(DISCOVERY_WINDOWED_CRAWL_INTERVAL_SEC).toBe(20 * 3600);
    expect(estimateDiscoverySweepPeriodSec(megaFootprint)).toBe(
      estimateDiscoverySweepWindowCount(megaFootprint) * DISCOVERY_WINDOWED_CRAWL_INTERVAL_SEC,
    );
  });
});

describe("advanceDiscoveryTargetCursor", () => {
  it("stops at the last deployment a provider actually reached", () => {
    const window = megaFootprint.slice(0, 5);
    const checked = new Set(keysOf(window.slice(0, 3)));

    expect(advanceDiscoveryTargetCursor(window, checked)).toBe(
      discoveryTargetCursorKey(window[2]!),
    );
  });

  it("holds the cursor when no provider reached the window", () => {
    expect(advanceDiscoveryTargetCursor(megaFootprint.slice(0, 5), new Set())).toBeNull();
  });

  it("skips past trailing deployments no provider can serve", () => {
    const window = [...megaFootprint.slice(0, 3), deployment("not-a-chain", 99)];

    expect(advanceDiscoveryTargetCursor(window, new Set())).toBe(
      discoveryTargetCursorKey(window[3]!),
    );
  });

  it("does not skip an unreached deployment that a provider should have served", () => {
    const window = megaFootprint.slice(0, 4);
    const checked = new Set(keysOf(window.slice(0, 2)));
    const cursor = advanceDiscoveryTargetCursor(window, checked);

    const next = selectDiscoveryTargetWindow({
      targets: megaFootprint,
      cursor,
      budgetMs: DEX_DISCOVERY_PER_COIN_BUDGET_MS,
    });

    expect(keysOf(next.targets)).toContain(discoveryTargetCursorKey(window[2]!));
  });
});
