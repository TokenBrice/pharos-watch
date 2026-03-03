import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/coingecko-onchain", () => ({
  initOnchainAvailability: vi.fn(),
  isOnchainAvailable: vi.fn(() => true),
}));

vi.mock("../dex-liquidity/fetch-primary", () => ({
  fetchDataSources: vi.fn(async () => null),
  buildCurveLookups: vi.fn(),
  fetchUniV3Data: vi.fn(),
  fetchAerodromeData: vi.fn(),
  buildKnownPoolAddresses: vi.fn(),
  fetchGtTokenBatch: vi.fn(),
  fetchCgTokenBatchPrices: vi.fn(),
}));

vi.mock("../dex-liquidity/fetch-crawlers", () => ({
  fetchCgPools: vi.fn(),
  mergeCgPools: vi.fn(),
  fetchGtPools: vi.fn(),
  mergeGtPools: vi.fn(),
}));

vi.mock("../dex-liquidity/fetch-fallbacks", () => ({
  fetchDsFallbackPools: vi.fn(),
  fetchCgTickersFallback: vi.fn(),
}));

vi.mock("../dex-liquidity/process-pools", () => ({
  processPoolMetrics: vi.fn(),
}));

vi.mock("../dex-liquidity/scoring", () => ({
  computeStablecoinScores: vi.fn(),
  computeDepthStability: vi.fn(),
  computeDexPrices: vi.fn(),
}));

vi.mock("../dex-liquidity/persistence", () => ({
  persistScores: vi.fn(),
  writeHistoricalSnapshots: vi.fn(),
}));

import { syncDexLiquidity } from "../dex-liquidity";

const db = {
  prepare: () => ({
    bind: () => ({
      all: async () => ({ results: [] }),
      first: async () => null,
      run: async () => ({ success: true, meta: {} }),
    }),
    all: async () => ({ results: [] }),
    first: async () => null,
    run: async () => ({ success: true, meta: {} }),
  }),
  batch: async () => [],
  exec: async () => ({ count: 0, duration: 0 }),
  dump: async () => new ArrayBuffer(0),
} as unknown as D1Database;

describe("syncDexLiquidity", () => {
  it("throws on catastrophic source failure instead of silently returning", async () => {
    await expect(syncDexLiquidity(db, "graph-key", "cg-key")).rejects.toThrow(
      "catastrophic source failure",
    );
  });
});
