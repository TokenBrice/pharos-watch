import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcome: vi.fn(async () => {}),
}));

vi.mock("../../lib/dexscreener", async () => {
  const actual = await vi.importActual<typeof import("../../lib/dexscreener")>("../../lib/dexscreener");
  return {
    ...actual,
    fetchDsTokenPoolsWithStatus: vi.fn(async () => ({ ok: true, pairs: [] })),
    dsRateLimit: vi.fn(async () => {}),
  };
});

import { fetchDsFallbackPools, getFallbackTargets } from "../dex-liquidity/fetch-fallbacks";
import { createKnownPoolIdentityIndex } from "../dex-liquidity/pool-identity";
import { initMetrics } from "../dex-liquidity/pool-helpers";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { fetchDsTokenPoolsWithStatus } from "../../lib/dexscreener";
import { CIRCUIT_SOURCE } from "../../lib/constants";

function createMockDb(): D1Database {
  return {
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
}

describe("getFallbackTargets", () => {
  it("targets coins with zero pools, missing dex price observations, or weak partial coverage", () => {
    const metrics = new Map<string, ReturnType<typeof initMetrics>>();
    const zeroPools = initMetrics("usdt-tether", "USDT");
    zeroPools.poolCount = 0;
    metrics.set("usdt-tether", zeroPools);

    const missingPrice = initMetrics("usdc-circle", "USDC");
    missingPrice.poolCount = 3;
    metrics.set("usdc-circle", missingPrice);

    const covered = initMetrics("dai-makerdao", "DAI");
    covered.poolCount = 4;
    covered.totalTvlUsd = 500_000;
    covered.totalTvlForBalance = 200_000;
    metrics.set("dai-makerdao", covered);

    const priceObservations = new Map([
      ["usdt-tether", [{ price: 1, tvl: 100_000, chain: "ethereum", protocol: "curve" }]],
      ["dai-makerdao", [
        { price: 1, tvl: 150_000, chain: "ethereum", protocol: "curve" },
        { price: 1, tvl: 100_000, chain: "base", protocol: "uniswap-v3" },
      ]],
    ]);

    const targetIds = new Set(
      getFallbackTargets(metrics, priceObservations, { requireTrackedContracts: true }).map((meta) => meta.id),
    );

    expect(targetIds.has("usdt-tether")).toBe(true);
    expect(targetIds.has("usdc-circle")).toBe(true);
    expect(targetIds.has("dai-makerdao")).toBe(false);
  });

  it("can restrict orderbook fallback targets to coins with a geckoId", () => {
    const metrics = new Map<string, ReturnType<typeof initMetrics>>();
    const noGecko = initMetrics("rwausdi-multipli", "rwaUSDi");
    metrics.set("rwausdi-multipli", noGecko);

    const targetIds = new Set(
      getFallbackTargets(metrics, new Map(), { requireGeckoId: true }).map((meta) => meta.id),
    );

    expect(targetIds.has("rwausdi-multipli")).toBe(false);
  });
});

describe("fetchDsFallbackPools circuit breaker", () => {
  beforeEach(() => {
    vi.mocked(shouldAttemptFetch).mockReset();
    vi.mocked(recordOutcome).mockReset();
    vi.mocked(fetchDsTokenPoolsWithStatus).mockReset();
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
    vi.mocked(recordOutcome).mockResolvedValue(undefined);
    vi.mocked(fetchDsTokenPoolsWithStatus).mockResolvedValue({ ok: true, pairs: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips DexScreener when dexscreener-prices breaker is open", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) =>
      source !== CIRCUIT_SOURCE.DEXSCREENER_PRICES,
    );

    // Seed metrics so the fallback has targets (zero pools triggers enrichment).
    const metrics = new Map<string, ReturnType<typeof initMetrics>>();
    const zeroPools = initMetrics("usdt-tether", "USDT");
    zeroPools.poolCount = 0;
    metrics.set("usdt-tether", zeroPools);

    const db = createMockDb();
    await fetchDsFallbackPools(
      db,
      metrics,
      new Map(),
      createKnownPoolIdentityIndex(),
    );

    expect(fetchDsTokenPoolsWithStatus).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it("records success when DexScreener fetch succeeds", async () => {
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
    vi.mocked(fetchDsTokenPoolsWithStatus).mockResolvedValue({ ok: true, pairs: [] });

    const metrics = new Map<string, ReturnType<typeof initMetrics>>();
    const zeroPools = initMetrics("usdt-tether", "USDT");
    zeroPools.poolCount = 0;
    metrics.set("usdt-tether", zeroPools);

    const db = createMockDb();
    await fetchDsFallbackPools(
      db,
      metrics,
      new Map(),
      createKnownPoolIdentityIndex(),
    );

    expect(fetchDsTokenPoolsWithStatus).toHaveBeenCalled();
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.DEXSCREENER_PRICES,
      true,
    );
  });

  it("records failure when DexScreener fetch fails", async () => {
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
    vi.mocked(fetchDsTokenPoolsWithStatus).mockResolvedValue({ ok: false, pairs: [] });

    const metrics = new Map<string, ReturnType<typeof initMetrics>>();
    const zeroPools = initMetrics("usdt-tether", "USDT");
    zeroPools.poolCount = 0;
    metrics.set("usdt-tether", zeroPools);

    const db = createMockDb();
    await fetchDsFallbackPools(
      db,
      metrics,
      new Map(),
      createKnownPoolIdentityIndex(),
    );

    expect(fetchDsTokenPoolsWithStatus).toHaveBeenCalled();
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.DEXSCREENER_PRICES,
      false,
    );
  });
});
