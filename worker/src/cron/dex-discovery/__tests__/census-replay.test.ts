import { describe, expect, it } from "vitest";
import type { ContractDeployment } from "@shared/types/core";
import { classifyDexPlaceholderCoverage, type DexDeploymentCensusRow } from "../../dex-liquidity/deployment-census-coverage";
import { advanceDiscoveryTargetCursor, DEX_DISCOVERY_PER_COIN_BUDGET_MS, discoveryTargetCursorKey,
  estimateDiscoverySweepWindowCount, selectDiscoveryTargetWindow } from "../target-window";

const NOW_SEC = 1_800_000_000;

function deployment(index: number): ContractDeployment {
  return { chain: "osmosis", address: `ibc/${index.toString(16).padStart(64, "0").toUpperCase()}`, decimals: 6 };
}

function reviewedEmptyRow(target: ContractDeployment): DexDeploymentCensusRow {
  return {
    stablecoin_id: "synthetic-empty", chain: target.chain, contract_address: target.address,
    outcome: "verified_no_pools", provider_set_json: JSON.stringify(["geckoterminal"]),
    reason: "A provider completed the direct-token query with no eligible pool",
    observed_pool_count: 0, observed_at: NOW_SEC, discovery_last_crawl_at: NOW_SEC,
  };
}

describe("DEX census rotating sweep", () => {
  it("moves from discovery deferral to complete-empty only after the production sweep reviews every target", () => {
    const targets = Array.from({ length: 10 }, (_, index) => deployment(index + 1));
    const expectedWindows = estimateDiscoverySweepWindowCount(targets);
    const rows = new Map<string, DexDeploymentCensusRow>();
    let cursor: string | null = null;
    expect(expectedWindows).toBeGreaterThan(1);

    for (let run = 0; run < expectedWindows; run++) {
      const window = selectDiscoveryTargetWindow({
        targets, cursor, budgetMs: DEX_DISCOVERY_PER_COIN_BUDGET_MS,
      });
      const checked = new Set(window.targets.map(discoveryTargetCursorKey));
      for (const target of window.targets) {
        rows.set(discoveryTargetCursorKey(target), reviewedEmptyRow(target));
      }
      cursor = advanceDiscoveryTargetCursor(window.targets, checked);
      const classification = classifyDexPlaceholderCoverage({
        deployments: targets, outcomeRows: [...rows.values()], nowSec: NOW_SEC,
      });
      if (run === 0) {
        expect(classification.state).toBe("discovery-deferral");
        expect(classification.census.missingOutcomeCount).toBeGreaterThan(0);
      }
    }

    expect(new Set(rows.keys())).toEqual(new Set(targets.map(discoveryTargetCursorKey)));
    expect(classifyDexPlaceholderCoverage({
      deployments: targets, outcomeRows: [...rows.values()], nowSec: NOW_SEC,
    })).toMatchObject({
      state: "complete-empty",
      census: { missingOutcomeCount: 0, staleOutcomeCount: 0, verifiedNoPoolsCount: targets.length },
    });
  });
});
