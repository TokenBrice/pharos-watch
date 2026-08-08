import { describe, expect, it } from "vitest";
import type { ContractDeployment } from "@shared/types/core";
import {
  advanceDiscoveryTargetCursor,
  discoveryTargetCursorKey,
  estimateDeploymentCrawlCostMs,
  selectDiscoveryTargetWindow,
} from "../target-window";
import { DEX_DISCOVERY_PER_COIN_BUDGET_MS } from "../orchestrator";

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
  it("prices a GeckoTerminal-only chain above a CoinGecko chain", () => {
    expect(estimateDeploymentCrawlCostMs("ethereum")).toBeLessThan(
      estimateDeploymentCrawlCostMs("linea"),
    );
  });

  it("charges nothing for chains with no registered discovery provider", () => {
    expect(estimateDeploymentCrawlCostMs("not-a-chain")).toBe(0);
  });
});

describe("selectDiscoveryTargetWindow", () => {
  it("leaves a footprint that fits the per-coin budget untouched", () => {
    const targets = CG_CHAINS.slice(0, 4).map(deployment);
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
