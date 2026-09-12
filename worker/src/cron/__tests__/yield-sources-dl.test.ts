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
import { buildDlStablecoinPoolsCache, parseDlStablecoinPoolsCache } from "../yield-sync/cache";
import { STALE_THRESHOLD_MS } from "../../lib/yield-ranking-helpers";
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

  it("accepts the freshness-contract boundary and fetches one second beyond it", async () => {
    // B10/D12 — the DL cache bound is derived from the same 3x-hourly contract that
    // evaluation.ts uses to null a DL row's PYS as `source-stale`.
    const maxAgeSec = STALE_THRESHOLD_MS / 1000;
    expect(maxAgeSec).toBe(180 * 60);

    for (const age of [maxAgeSec, maxAgeSec + 1]) {
      vi.mocked(getCache).mockResolvedValue({
        updatedAt: nowSec - age,
        value: buildDlStablecoinPoolsCache([makeDlYieldPool({ pool: "cached" })], nowSec - age),
      });
      vi.mocked(fetchJsonWithRetry).mockResolvedValue({
        response: new Response(), body: { data: [makeDlYieldPool({ pool: "direct" })] },
      });
      const result = await loadDlStablecoinPools({} as D1Database);
      expect(result.pools.map((pool) => pool.pool)).toEqual([age === maxAgeSec ? "cached" : "direct"]);
      expect(fetchJsonWithRetry).toHaveBeenCalledTimes(age === maxAgeSec ? 0 : 1);
    }
    expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), expect.anything(), true);
  });

  it("rejects and counts pools above the APY envelope", async () => {
    // B12 — a 1000% single-exposure stablecoin pool is not a yield observation.
    vi.mocked(getCache).mockResolvedValue({
      updatedAt: nowSec - 60,
      value: buildDlStablecoinPoolsCache([
        makeDlYieldPool({ pool: "plausible", apy: 8, apyBase: 8 }),
        makeDlYieldPool({ pool: "absurd", apy: 1000, apyBase: 1000 }),
      ], nowSec - 60),
    });

    const result = await loadDlStablecoinPools({} as D1Database);
    expect(result.pools.map((pool) => pool.pool)).toEqual(["plausible"]);

    const parsed = parseDlStablecoinPoolsCache(
      buildDlStablecoinPoolsCache([
        makeDlYieldPool({ pool: "plausible", apy: 8, apyBase: 8 }),
        makeDlYieldPool({ pool: "absurd", apy: 1000, apyBase: 1000 }),
      ], nowSec - 60),
      nowSec - 60,
      nowSec,
    );
    expect(parsed?.pools.map((pool) => pool.pool)).toEqual(["plausible"]);
    expect(parsed?.envelopeRejectedCount).toBe(1);
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
