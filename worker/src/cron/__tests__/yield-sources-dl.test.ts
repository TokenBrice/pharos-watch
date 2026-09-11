import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/db-cache", () => ({
  getCache: vi.fn(),
}));

vi.mock("../../lib/circuit-breaker", () => ({
  recordOutcome: vi.fn(),
  shouldAttemptFetch: vi.fn(),
}));

vi.mock("../../lib/fetch-retry", () => ({
  fetchJsonWithRetry: vi.fn(),
}));

import { getCache } from "../../lib/db-cache";
import { recordOutcome, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { loadDlStablecoinPools } from "../yield-sync/sources-dl";
import { buildDlStablecoinPoolsCache } from "../yield-sync/cache";
import { makeDlYieldPool } from "./yield-resolve.test-support";

describe("loadDlStablecoinPools", () => {
  const nowSec = 1_710_500_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowSec * 1000));
    vi.clearAllMocks();
    vi.mocked(getCache).mockResolvedValue(null);
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
    vi.mocked(fetchJsonWithRetry).mockReset().mockRejectedValue(new Error("Unexpected network call"));
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
    expect(fetchJsonWithRetry).not.toHaveBeenCalled();
  });

  it("accepts the six-hour boundary and fetches one second beyond it", async () => {
    for (const age of [21600, 21601]) {
      vi.mocked(getCache).mockResolvedValue({
        updatedAt: nowSec - age,
        value: buildDlStablecoinPoolsCache([makeDlYieldPool({ pool: "cached" })], nowSec - age),
      });
      vi.mocked(fetchJsonWithRetry).mockResolvedValue({
        response: new Response(), body: { data: [makeDlYieldPool({ pool: "direct" })] },
      });
      const result = await loadDlStablecoinPools({} as D1Database);
      expect(result.pools.map((pool) => pool.pool)).toEqual([age === 21600 ? "cached" : "direct"]);
      expect(fetchJsonWithRetry).toHaveBeenCalledTimes(age === 21600 ? 0 : 1);
    }
    expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), expect.anything(), true);
  });

  it("recovers malformed and irrelevant-only caches through direct fetch", async () => {
    for (const [value, fallbackMode] of [
      ["{", "cache-parse-failed"],
      [buildDlStablecoinPoolsCache([makeDlYieldPool({ symbol: "ETH", stablecoin: false, exposure: "multi" })], nowSec), "cache-no-relevant-pools"],
    ]) {
      vi.mocked(getCache).mockResolvedValue({ value, updatedAt: nowSec });
      vi.mocked(fetchJsonWithRetry).mockResolvedValue({
        response: new Response(), body: { data: [makeDlYieldPool({ pool: "recovered" })] },
      });
      const result = await loadDlStablecoinPools({} as D1Database);
      expect(result.pools.map((pool) => pool.pool)).toEqual(["recovered"]);
      expect(result.meta).toMatchObject({ mode: "direct-fetch", fallbackMode, ageSeconds: 0, poolCount: 1 });
    }
  });

  it("does not fetch or record an outcome while the circuit is open", async () => {
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    expect(await loadDlStablecoinPools({} as D1Database)).toMatchObject({
      pools: [], meta: { mode: "unavailable", fallbackMode: "circuit-open" },
    });
    expect(fetchJsonWithRetry).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it("distinguishes invalid and empty successful payloads", async () => {
    for (const [body, fallbackMode] of [
      [{ data: {} }, "direct-fetch-invalid-payload"],
      [{ data: [] }, "direct-fetch-empty"],
    ] as const) {
      vi.mocked(fetchJsonWithRetry).mockResolvedValue({ response: new Response(), body });
      expect(await loadDlStablecoinPools({} as D1Database)).toMatchObject({
        pools: [], meta: { mode: "unavailable", fallbackMode, poolCount: 0 },
      });
    }
    expect(vi.mocked(recordOutcome).mock.calls.map((call) => call[2])).toEqual([false, false]);
  });

  it("distinguishes HTTP failure from transport rejection", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValueOnce({ response: new Response(null, { status: 503 }), body: {} });
    expect((await loadDlStablecoinPools({} as D1Database)).meta.fallbackMode).toBe("direct-fetch-failed");
    vi.mocked(fetchJsonWithRetry).mockRejectedValueOnce(new Error("offline"));
    expect((await loadDlStablecoinPools({} as D1Database)).meta.fallbackMode).toBe("direct-fetch-exception");
    expect(vi.mocked(recordOutcome).mock.calls.map((call) => call[2])).toEqual([false, false]);
  });
});
