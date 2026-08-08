import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractDeployment } from "@shared/types/core";

// A mega-multichain footprint: a cheap CoinGecko head plus a GeckoTerminal-only
// tail whose 2s pacing floor cannot fit in the same per-coin budget.
const { CG_CHAINS, GT_ONLY_CHAINS, FOOTPRINT, cursorStore } = vi.hoisted(() => {
  const cgChains = ["ethereum", "arbitrum", "base", "optimism", "polygon", "avalanche", "celo", "gnosis", "bsc", "fantom"];
  const gtOnlyChains = ["linea", "scroll", "mantle", "mode", "manta", "zksync", "sonic", "taiko", "unichain", "worldchain"];
  return {
    CG_CHAINS: cgChains,
    GT_ONLY_CHAINS: gtOnlyChains,
    FOOTPRINT: [...cgChains, ...gtOnlyChains].map((chain, index) => ({
      chain,
      address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
      decimals: 18,
    })),
    cursorStore: new Map<string, string>(),
  };
});

vi.mock("@shared/lib/stablecoins/registry", () => {
  const stablecoins = [{ id: "mega-coin", contracts: FOOTPRINT }];
  return {
    TRACKED_STABLECOINS: stablecoins,
    ACTIVE_STABLECOINS: stablecoins,
    TRACKED_META_BY_ID: new Map(stablecoins.map((coin) => [coin.id, coin])),
  };
});

vi.mock("../../dex-liquidity/pool-helpers", () => ({
  getTrackedContracts: vi.fn((coin: { contracts?: ContractDeployment[] }) => coin.contracts ?? []),
}));

vi.mock("../../../lib/price-validation", () => ({
  loadPriceValidationReferences: vi.fn(async () => undefined),
}));

vi.mock("../crawl-sources", () => ({ crawlCoin: vi.fn() }));

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
  buildFailedCrawlDeploymentOutcomes: vi.fn(() => []),
  buildStaticInaccessibleDeploymentOutcomes: vi.fn(() => []),
  upsertDexDeploymentOutcomes: vi.fn(async (_db: D1Database, rows: unknown[]) => rows.length),
}));

vi.mock("../persistence", () => ({
  cleanupStaging: vi.fn(async () => {}),
  incrementRunSeq: vi.fn(async () => 1),
  readDiscoveryMeta: vi.fn(async () => new Map()),
  readDiscoveryTargetCursors: vi.fn(async () => new Map(cursorStore)),
  recordDiscoveryAttemptFence: vi.fn(async () => {}),
  updateDiscoveryMeta: vi.fn(async () => {}),
  upsertStagedPools: vi.fn(async () => {}),
  writeDiscoveryTargetCursors: vi.fn(async (_db: D1Database, cursors: ReadonlyMap<string, string>) => {
    cursorStore.clear();
    for (const [key, value] of cursors) cursorStore.set(key, value);
  }),
}));

import { syncDexDiscovery } from "../orchestrator";
import { crawlCoin } from "../crawl-sources";
import { discoveryTargetCursorKey, estimateDeploymentCrawlCostMs } from "../target-window";

const db = {
  prepare: () => ({
    all: async () => ({ results: [{ stablecoin_id: "mega-coin", pool_count: 0, chain_count: 0 }] }),
  }),
} as unknown as D1Database;

function totalFootprintCostMs(): number {
  return FOOTPRINT.reduce((sum, target) => sum + estimateDeploymentCrawlCostMs(target.chain), 0);
}

/** Deployment keys handed to the most recent coin crawl. */
function lastCrawlWindow(): string[] {
  const calls = vi.mocked(crawlCoin).mock.calls;
  const coinTargets = calls[calls.length - 1]![2] as ContractDeployment[];
  return coinTargets.map(discoveryTargetCursorKey);
}

describe("dex discovery deployment-window rotation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cursorStore.clear();
    // Every windowed target is reachable inside the window; the point of the test
    // is which targets a run is handed, not provider behaviour.
    vi.mocked(crawlCoin).mockImplementation(async (_db, _id, coinTargets) => ({
      pools: [],
      unresolvedChains: [],
      deploymentOutcomes: [],
      checkedDeploymentKeys: coinTargets.map(discoveryTargetCursorKey),
    }));
  });

  it("covers the whole footprint across consecutive runs instead of repeating one prefix", async () => {
    const runsPerRotation = Math.ceil(totalFootprintCostMs() / 25_000);
    expect(runsPerRotation).toBeGreaterThan(1);

    const runWindows: string[][] = [];
    for (let run = 0; run < runsPerRotation; run++) {
      const result = await syncDexDiscovery(db, null);
      expect(result.status).toBe("ok");
      runWindows.push(lastCrawlWindow());
      expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({ windowedCoins: 1 });
    }

    // Each run gets a different slice, and the union is the full census scope.
    expect(runWindows[0]).not.toEqual(runWindows[1]);
    expect(new Set(runWindows.flat())).toEqual(
      new Set(FOOTPRINT.map(discoveryTargetCursorKey)),
    );
  });

  it("hands the starved GeckoTerminal-only tail to a later run", async () => {
    const gtOnlyKeys = new Set(
      FOOTPRINT.filter((target) => GT_ONLY_CHAINS.includes(target.chain)).map(discoveryTargetCursorKey),
    );

    await syncDexDiscovery(db, null);
    const firstWindow = lastCrawlWindow();
    await syncDexDiscovery(db, null);
    const secondWindow = lastCrawlWindow();

    const firstTail = firstWindow.filter((key) => gtOnlyKeys.has(key));
    const secondTail = secondWindow.filter((key) => gtOnlyKeys.has(key));
    expect(firstTail.length).toBeLessThan(gtOnlyKeys.size);
    expect(secondTail.some((key) => !firstTail.includes(key))).toBe(true);
  });

  it("advances past a window whose crawl failed so it cannot block the rotation", async () => {
    await syncDexDiscovery(db, null);
    const firstWindow = lastCrawlWindow();

    vi.mocked(crawlCoin).mockRejectedValueOnce(new Error("provider unavailable"));
    await syncDexDiscovery(db, null);
    const failedWindow = lastCrawlWindow();
    await syncDexDiscovery(db, null);
    const thirdWindow = lastCrawlWindow();

    expect(failedWindow).not.toEqual(firstWindow);
    expect(thirdWindow).not.toEqual(failedWindow);
  });

  it("holds the cursor when no provider reached the window", async () => {
    vi.mocked(crawlCoin).mockImplementation(async () => ({
      pools: [],
      unresolvedChains: [],
      deploymentOutcomes: [],
      checkedDeploymentKeys: [],
    }));

    await syncDexDiscovery(db, null);
    const firstWindow = lastCrawlWindow();
    await syncDexDiscovery(db, null);
    const secondWindow = lastCrawlWindow();

    expect(cursorStore.size).toBe(0);
    expect(secondWindow).toEqual(firstWindow);
  });
});
