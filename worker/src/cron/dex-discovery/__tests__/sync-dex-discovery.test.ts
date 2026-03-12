import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/stablecoins", () => ({
  TRACKED_STABLECOINS: [
    {
      id: "coin-a",
      contracts: [{ chain: "ethereum", address: "0xaaa", decimals: 18 }],
    },
    {
      id: "coin-b",
      contracts: [{ chain: "ethereum", address: "0xbbb", decimals: 18 }],
    },
  ],
}));

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
    priceObs: [],
  })),
}));

vi.mock("../persistence", () => ({
  cleanupStaging: vi.fn(async () => {}),
  incrementRunSeq: vi.fn(async () => 1),
  readDiscoveryMeta: vi.fn(async () => new Map()),
  updateDiscoveryMeta: vi.fn(async () => {}),
  upsertStagedPools: vi.fn(async () => {}),
}));

import { syncDexDiscovery } from "../orchestrator";
import { crawlCoin } from "../crawl-sources";
import { loadPriceValidationReferences } from "../../../lib/price-validation";
import {
  cleanupStaging,
  incrementRunSeq,
  readDiscoveryMeta,
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
    vi.mocked(incrementRunSeq).mockResolvedValue(1);
    vi.mocked(crawlCoin).mockResolvedValue({
      pools: [
        makeStagedPool("ethereum:0xpool1"),
        makeStagedPool("base:0xpool2"),
      ],
      priceObs: [],
    });
  });

  it("returns the discovery contract metadata without shadow telemetry", async () => {
    const result = await syncDexDiscovery(db, null);

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(1);
    expect(vi.mocked(crawlCoin)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(upsertStagedPools)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateDiscoveryMeta)).toHaveBeenCalledWith(db, "coin-a", 2, expect.any(Number));
    expect(vi.mocked(cleanupStaging)).toHaveBeenCalledTimes(1);

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata).toMatchObject({
      coinsCrawled: 1,
      poolsDiscovered: 2,
      budgetExhausted: false,
      runSeq: 1,
      failedCoins: [],
      tierBreakdown: {
        t1: 1,
        t2: 0,
        t3: 0,
        dormant: 0,
        skipped: 1,
      },
    });
    expect(metadata).not.toHaveProperty("priceValidationShadow");
  });
});
