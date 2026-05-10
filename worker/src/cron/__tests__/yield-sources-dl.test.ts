import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/db-cache", () => ({
  getCache: vi.fn(),
}));

vi.mock("../../lib/circuit-breaker", () => ({
  recordOutcome: vi.fn(),
  shouldAttemptFetch: vi.fn(),
}));

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

import { getCache } from "../../lib/db-cache";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { loadDlStablecoinPools } from "../yield-sync/sources-dl";
import { buildDlStablecoinPoolsCache } from "../yield-sync/cache";

describe("loadDlStablecoinPools", () => {
  const nowSec = 1_710_500_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowSec * 1000));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("filters non-yield-relevant cached DL rows before returning cache hits", async () => {
    vi.mocked(getCache).mockResolvedValue({
      updatedAt: nowSec - 60,
      value: buildDlStablecoinPoolsCache([
        {
          pool: "relevant",
          chain: "Ethereum",
          project: "maker",
          symbol: "sDAI",
          tvlUsd: 100_000_000,
          apy: 5,
          apyBase: 5,
          apyReward: null,
          apyMean30d: 5,
          stablecoin: true,
          exposure: "single",
          underlyingTokens: null,
        },
        {
          pool: "irrelevant",
          chain: "Ethereum",
          project: "curve",
          symbol: "ETH",
          tvlUsd: 100_000_000,
          apy: 2,
          apyBase: 2,
          apyReward: null,
          apyMean30d: 2,
          stablecoin: false,
          exposure: "multi",
          underlyingTokens: null,
        },
      ], nowSec - 60),
    });

    const result = await loadDlStablecoinPools({} as D1Database);

    expect(result.pools.map((pool) => pool.pool)).toEqual(["relevant"]);
    expect(result.meta.poolCount).toBe(1);
    expect(shouldAttemptFetch).not.toHaveBeenCalled();
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });
});
