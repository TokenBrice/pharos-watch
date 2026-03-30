import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeApiRequest, stubCryptoForAuth } from "./helpers/auth";
import { mockFetch } from "./helpers/mock-fetch";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";

stubCryptoForAuth();

afterEach(() => {
  vi.restoreAllMocks();
});

const { handleStatus } = await import("../status");

/** Build a mock cache row with a recent updated_at */
function makeCacheRow(key: string, ageSec = 300) {
  return {
    key,
    updated_at: Math.floor(Date.now() / 1000) - ageSec,
    value: JSON.stringify(key === "fx-rates" ? { peggedEUR: 1.08 } : []),
  };
}

/** Build a mock cron_runs row */
function makeCronRow(job: string, status = "ok", ageSec = 300) {
  return {
    job,
    started_at: Math.floor(Date.now() / 1000) - ageSec,
    duration_ms: 1500,
    status,
    error: null,
    item_count: 100,
    metadata: null,
  };
}

describe("handleStatus", () => {
  it("returns 401 when no ops-api access signal is provided", async () => {
    const db = mockD1([]);
    const res = await handleStatus(db, undefined, undefined);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 200 with status body when authorized", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });

    const db = mockD1([
      // buildCacheStatuses queries the cache table
      {
        match: "cache WHERE key IN",
        rows: [makeCacheRow("stablecoins"), makeCacheRow("stablecoin-charts")],
      },
      // Table freshness queries (dex-liquidity, yield-data, dews)
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      // cron_runs query
      {
        match: "cron_runs",
        rows: [
          {
            ...makeCronRow("sync-stablecoins"),
            metadata: JSON.stringify({
              priceSourceHealth: {
                sourceDistribution: {
                  coingecko: 14,
                  "coingecko+defillama-list": 118,
                  defillama: 10,
                  "defillama-list": 0,
                  "protocol-redeem": 1,
                  "defillama-contract": 4,
                  coinmarketcap: 2,
                  dexscreener: 1,
                  jupiter: 0,
                  pyth: 0,
                  binance: 0,
                  kraken: 0,
                  bitstamp: 0,
                  coinbase: 0,
                  redstone: 0,
                  "curve-onchain": 0,
                  "dex-promoted": 0,
                  geckoterminal: 0,
                  "pool-tvl-weighted": 0,
                  cached: 4,
                  missing: 3,
                },
                confidenceDistribution: {
                  high: 127,
                  "single-source": 15,
                  low: 8,
                  fallback: 6,
                },
                totalAssets: 156,
                lastSync: now - 60,
              },
            }),
          },
          {
            ...makeCronRow("sync-dex-liquidity"),
            metadata: JSON.stringify({
              failedSources: ["defillama-yields"],
              sourceCoverage: {
                currentCoverage: 120,
                previousCoverage: 125,
                currentGlobalTvl: 123_000_000,
                previousGlobalTvl: 125_000_000,
                currentTop10CoveredTvl: 100_000_000,
                previousTop10CoveredTvl: 102_000_000,
                nearCoverageGuard: false,
                nearValueGuard: false,
                nearMajorCoverageGuard: false,
                currentCoverageClasses: {
                  primary: 80,
                  mixed: 20,
                  fallback: 20,
                  legacy: 0,
                  unobserved: 36,
                },
                previousCoverageClasses: {
                  primary: 82,
                  mixed: 18,
                  fallback: 25,
                  legacy: 0,
                  unobserved: 31,
                },
              },
            }),
          },
          makeCronRow("sync-stablecoin-charts"),
          makeCronRow("sync-blacklist"),
        ],
      },
      {
        match: "MAX(last_seen) as latest FROM discovery_candidates",
        rows: [],
        first: { latest: now - 120 },
      },
      {
        match: "FROM discovery_candidates WHERE dismissed = 0",
        rows: [
          {
            id: 12,
            gecko_id: "usdq",
            llama_id: null,
            name: "USDQ",
            symbol: "USDQ",
            market_cap: 18_200_000,
            source: "coingecko",
            first_seen: now - 172_800,
            last_seen: now - 120,
            dismissed: 0,
          },
        ],
      },
      // Data quality: stablecoins cache for missing prices
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      // Data quality: blacklist totals
      { match: "blacklist_events", rows: [], first: { total: 10, missing: 2 } },
      // Data quality: active depegs
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      // Data quality: stale on-chain supply
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      // Data quality: on-chain divergences (empty — no rows)
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      timestamp: number;
      dbHealthy: boolean;
      overallStatus: string;
      caches: Record<string, unknown>;
      crons: Record<string, unknown>;
      dataQuality: Record<string, unknown>;
      telegramBot: Record<string, unknown> | null;
      sectionErrors: Record<string, { code: string; message: string } | undefined>;
      datasetFreshness: Record<string, number | null>;
      state: Record<string, unknown>;
      priceSourceHealth: Record<string, unknown> | null;
      coingeckoPriceDiff: Record<string, unknown> | null;
      liquidityHealth: Record<string, unknown> | null;
      discoveryCandidates: Array<Record<string, unknown>> | null;
      mintBurnReconciliation: Record<string, unknown> | null;
      reserveComposition: Record<string, unknown>;
    };

    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("dbHealthy");
    expect(body).toHaveProperty("overallStatus");
    expect(body).toHaveProperty("caches");
    expect(body).toHaveProperty("crons");
    expect(body).toHaveProperty("dataQuality");
    expect(body).toHaveProperty("telegramBot");
    expect(body).toHaveProperty("sectionErrors");
    expect(body).toHaveProperty("datasetFreshness");
    expect(body).toHaveProperty("state");
    expect(body).toHaveProperty("priceSourceHealth");
    expect(body).toHaveProperty("coingeckoPriceDiff");
    expect(body).toHaveProperty("liquidityHealth");
    expect(body).toHaveProperty("discoveryCandidates");
    expect(body).toHaveProperty("mintBurnReconciliation");
    expect(body).toHaveProperty("reserveComposition");
    expect(typeof body.dbHealthy).toBe("boolean");
    expect(body.datasetFreshness).toHaveProperty("stablecoins");
    expect(body.datasetFreshness).toHaveProperty("mintBurn");
    expect(body.datasetFreshness).toHaveProperty("safetyGrades");
    expect(body.datasetFreshness).toHaveProperty("discoveryCandidates");
    expect(body.state).toMatchObject({
      scope: "global",
      thresholds: {
        escalateToDegraded: 2,
        escalateToStale: 1,
        recoverToDegraded: 2,
        recoverToHealthy: 3,
      },
      minDwellSec: 120,
      staleMinDwellSec: 180,
    });
    expect(body.priceSourceHealth).toMatchObject({
      totalAssets: 156,
    });
    expect(body.coingeckoPriceDiff).toBeNull();
    expect(body.liquidityHealth).toMatchObject({
      currentCoverage: 120,
      failedSources: ["defillama-yields"],
    });
    expect(body.discoveryCandidates).toHaveLength(1);
    expect(["healthy", "degraded", "stale"]).toContain(body.overallStatus);
  });

  it("treats cron history query failure as unknown telemetry instead of stale cron health", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          makeCacheRow("stablecoins"),
          makeCacheRow("stablecoin-charts"),
          makeCacheRow("usds-status"),
          makeCacheRow("treasury-stable-exposure"),
          makeCacheRow("bluechip-ratings"),
          {
            key: "fx-rates",
            updated_at: now - 300,
            value: JSON.stringify({ peggedEUR: 1.08 }),
          },
          {
            key: "fx-rates-meta",
            updated_at: now - 300,
            value: JSON.stringify({
              usableSyncAt: now - 300,
              mode: "live",
              sourceUpdatedAtByPeg: { peggedEUR: now - 300 },
              sourceModeByPeg: { peggedEUR: "live" },
              sourceCadenceByPeg: { peggedEUR: "intraday" },
              sourceDateByPeg: { peggedEUR: null },
            }),
          },
        ],
      },
      { match: "cron_runs", rows: [], throwError: new Error("cron_runs unavailable") },
      { match: "cron_run_progress", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cache", rows: [], first: { value: stablecoinsCache, updated_at: now - 60 } },
      { match: "blacklist_events", rows: [], first: { total: 10, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
      { match: "FROM discovery_candidates WHERE dismissed = 0", rows: [] },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      availabilityStatus: string;
      summary: { unhealthyCrons: number };
      crons: Record<string, { healthy: boolean; telemetryUnknown?: boolean }>;
      causes: { availability: Array<{ code: string }> };
    };

    expect(body.availabilityStatus).toBe("healthy");
    expect(body.summary.unhealthyCrons).toBe(0);
    expect(body.crons["sync-stablecoins"]?.healthy).toBe(true);
    expect(body.crons["sync-stablecoins"]?.telemetryUnknown).toBe(true);
    expect(body.causes.availability.some((cause) => cause.code === "cron_history_query_failed")).toBe(true);
  });

  it("surfaces tracked CoinGecko price mismatches above threshold", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [
        {
          id: "usdt-tether",
          name: "Tether",
          symbol: "USDT",
          geckoId: "tether",
          pegType: "peggedUSD",
          pegMechanism: "fiat-backed",
          price: 1,
          priceSource: "coingecko+defillama-list",
          priceConfidence: "high",
          circulating: { peggedUSD: 100_000_000 },
          chainCirculating: {},
          chains: [],
        },
        {
          id: "pyusd-paypal",
          name: "PayPal USD",
          symbol: "PYUSD",
          geckoId: "paypal-usd",
          pegType: "peggedUSD",
          pegMechanism: "fiat-backed",
          price: 0.9,
          priceSource: "defillama",
          priceConfidence: "single-source",
          circulating: { peggedUSD: 100_000_000 },
          chainCirculating: {},
          chains: [],
        },
      ],
    });

    mockFetch([
      {
        match: "/simple/price",
        body: {
          tether: { usd: 1 },
          "paypal-usd": { usd: 1 },
        },
      },
    ]);

    const db = mockD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
      { match: "cache", rows: [], first: { value: stablecoinsCache, updated_at: now - 60 } },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
      { match: "FROM discovery_candidates WHERE dismissed = 0", rows: [] },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request, "cg-test-key");
    const body = (await res.json()) as {
      coingeckoPriceDiff: {
        checkedAt: number;
        trackedWithGeckoId: number;
        comparedCoins: number;
        mismatchedCount: number;
        thresholdPct: number;
        rows: Array<{
          stablecoinId: string;
          symbol: string;
          name: string;
          ourPrice: number;
          coinGeckoPrice: number;
          diffPct: number;
          priceSource: string;
          priceConfidence: string | null;
        }>;
      } | null;
    };

    expect(res.status).toBe(200);
    expect(body.coingeckoPriceDiff).toMatchObject({
      trackedWithGeckoId: 2,
      comparedCoins: 2,
      mismatchedCount: 1,
      thresholdPct: 5,
    });
    expect(body.coingeckoPriceDiff?.rows[0]).toMatchObject({
      stablecoinId: "pyusd-paypal",
      symbol: "PYUSD",
      name: "PayPal USD",
      ourPrice: 0.9,
      coinGeckoPrice: 1,
      priceSource: "defillama",
      priceConfidence: "single-source",
    });
    expect(body.coingeckoPriceDiff?.rows[0].diffPct ?? 0).toBeGreaterThan(5);
  });

  it("surfaces CoinGecko comparison loader failures through sectionErrors", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [
        {
          id: "usdt-tether",
          name: "Tether",
          symbol: "USDT",
          geckoId: "tether",
          pegType: "peggedUSD",
          pegMechanism: "fiat-backed",
          price: 1,
          priceSource: "coingecko",
          priceConfidence: "single-source",
          circulating: { peggedUSD: 100_000_000 },
          chainCirculating: {},
          chains: [],
        },
      ],
    });

    mockFetch([
      {
        match: "/simple/price",
        body: { error: "cg down" },
        status: 503,
      },
    ]);

    const db = mockD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
      { match: "cache", rows: [], first: { value: stablecoinsCache, updated_at: now - 60 } },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
      { match: "FROM discovery_candidates WHERE dismissed = 0", rows: [] },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request, "cg-test-key");
    const body = (await res.json()) as {
      coingeckoPriceDiff: unknown;
      sectionErrors: Record<string, { code: string; message: string } | undefined>;
    };

    expect(res.status).toBe(200);
    expect(body.coingeckoPriceDiff).toBeNull();
    expect(body.sectionErrors.coingeckoPriceDiff).toEqual({
      code: "coingecko_price_diff_query_failed",
      message: "CoinGecko simple price fetch failed (503)",
    });
  });

  it("limits CoinGecko drift comparisons to active tracked Pharos assets", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [
        {
          id: "usdt-tether",
          name: "Tether",
          symbol: "USDT",
          geckoId: "tether",
          pegType: "peggedUSD",
          pegMechanism: "fiat-backed",
          price: 1,
          priceSource: "coingecko",
          priceConfidence: "single-source",
          circulating: { peggedUSD: 100_000_000 },
          chainCirculating: {},
          chains: [],
        },
        {
          id: "usds-thestandard",
          name: "TheStandard USD",
          symbol: "USDS",
          geckoId: "the-standard-usd",
          pegType: "peggedUSD",
          pegMechanism: "crypto-backed",
          price: 1.0001,
          priceSource: "coinbase+kraken",
          priceConfidence: "high",
          circulating: { peggedUSD: 10_000_000 },
          chainCirculating: {},
          chains: [],
        },
        {
          id: "pyusd-paypal",
          name: "PayPal USD",
          symbol: "PYUSD",
          geckoId: "paypal-usd",
          pegType: "peggedUSD",
          pegMechanism: "fiat-backed",
          price: 0.9,
          priceSource: "defillama",
          priceConfidence: "single-source",
          circulating: { peggedUSD: 100_000_000 },
          chainCirculating: {},
          chains: [],
        },
      ],
    });

    mockFetch([
      {
        match: "/simple/price",
        body: {
          tether: { usd: 1 },
          "the-standard-usd": { usd: 0.700692 },
          "paypal-usd": { usd: 1 },
        },
      },
    ]);

    const db = mockD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
      { match: "cache", rows: [], first: { value: stablecoinsCache, updated_at: now - 60 } },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
      { match: "FROM discovery_candidates WHERE dismissed = 0", rows: [] },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request, "cg-test-key");
    const body = (await res.json()) as {
      coingeckoPriceDiff: {
        trackedWithGeckoId: number;
        comparedCoins: number;
        mismatchedCount: number;
        rows: Array<{ stablecoinId: string; symbol: string; name: string }>;
      } | null;
    };

    expect(res.status).toBe(200);
    expect(body.coingeckoPriceDiff).toMatchObject({
      trackedWithGeckoId: 2,
      comparedCoins: 2,
      mismatchedCount: 1,
    });
    expect(body.coingeckoPriceDiff?.rows).toEqual([
      expect.objectContaining({
        stablecoinId: "pyusd-paypal",
        symbol: "PYUSD",
        name: "PayPal USD",
      }),
    ]);
  });

  it("emits cache warnings alongside degraded FX-source warnings", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          {
            key: "fx-rates",
            updated_at: now - 300,
            value: JSON.stringify({ peggedEUR: 1.08 }),
          },
          {
            key: "fx-rates-meta",
            updated_at: now - 300,
            value: JSON.stringify({
              usableSyncAt: now - 300,
              mode: "live",
              sourceUpdatedAtByPeg: { peggedEUR: now - (8 * 3600) },
              sourceModeByPeg: { peggedEUR: "live" },
              sourceCadenceByPeg: { peggedEUR: "intraday" },
              sourceDateByPeg: { peggedEUR: null },
            }),
          },
          {
            key: "stablecoins",
            updated_at: now - 4_000,
            value: JSON.stringify({
              peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1, circulating: { peggedUSD: 1 } }],
            }),
          },
        ],
      },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins")] },
      { match: "cron_run_progress", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      {
        match: "cache",
        rows: [],
        first: {
          value: JSON.stringify({
            peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
          }),
          updated_at: now - 60,
        },
      },
      { match: "blacklist_events", rows: [], first: { total: 10, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
      { match: "FROM discovery_candidates WHERE dismissed = 0", rows: [] },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      causes: { availability: Array<{ code: string }> };
    };
    const codes = body.causes.availability.map((cause) => cause.code);
    expect(codes).toContain("fx_source_degraded");
    expect(codes).toContain("cache_warning");
  });

  it("surfaces status persistence failures as a section error", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins")] },
      { match: "cron_run_progress", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cache", rows: [], first: { value: stablecoinsCache, updated_at: now - 60 } },
      { match: "blacklist_events", rows: [], first: { total: 10, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
      { match: "FROM discovery_candidates WHERE dismissed = 0", rows: [] },
      {
        match: "FROM status_state",
        rows: [],
        throwError: new Error("no such table: status_state"),
      },
      {
        match: "INSERT INTO status_state",
        rows: [],
        throwError: new Error("no such table: status_state"),
      },
      {
        match: "FROM status_probe_runs",
        rows: [],
        throwError: new Error("no such table: status_probe_runs"),
      },
      {
        match: "SELECT consecutive_divergent FROM status_discrepancy_state",
        rows: [],
        throwError: new Error("no such table: status_discrepancy_state"),
      },
      {
        match: "FROM status_transitions",
        rows: [],
        throwError: new Error("no such table: status_transitions"),
      },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      sectionErrors: Record<string, { code: string; message: string } | undefined>;
    };
    expect(body.sectionErrors.statusState?.code).toBe("status_persistence_degraded");
    expect(body.sectionErrors.statusState?.message).toMatch(/status_state/i);
  });

  it("uses writer timestamps for event-backed freshness rows", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const blacklistWriterAt = now - 15 * 60;
    const mintBurnWriterAt = now - 8 * 60;
    const depegWriterAt = now - 12 * 60;
    const discoveryWriterAt = now - 20 * 60;

    const db = mockD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      {
        match: "FROM cron_runs\n         WHERE job IN",
        rows: [
          makeCronRow("sync-stablecoins", "ok", 12 * 60),
          makeCronRow("sync-blacklist", "ok", 15 * 60),
          makeCronRow("sync-mint-burn", "ok", 8 * 60),
          makeCronRow("sync-mint-burn-extended", "ok", 18 * 60),
          makeCronRow("discovery-scan", "ok", 20 * 60),
        ],
      },
      {
        match: "SELECT MAX(started_at) as latest",
        matchBinds: ["sync-blacklist", "ok", "degraded"],
        rows: [],
        first: { latest: blacklistWriterAt },
      },
      {
        match: "SELECT MAX(started_at) as latest",
        matchBinds: ["sync-mint-burn", "sync-mint-burn-extended", "ok", "degraded"],
        rows: [],
        first: { latest: mintBurnWriterAt },
      },
      {
        match: "SELECT MAX(started_at) as latest",
        matchBinds: ["sync-stablecoins", "ok", "degraded"],
        rows: [],
        first: { latest: depegWriterAt },
      },
      {
        match: "SELECT MAX(started_at) as latest",
        matchBinds: ["sync-stablecoins", "discovery-scan", "ok", "degraded"],
        rows: [],
        first: { latest: discoveryWriterAt },
      },
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], first: { total: 10_000, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
      {
        match: "FROM discovery_candidates WHERE dismissed = 0",
        rows: [],
      },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      datasetFreshness: {
        blacklist: number | null;
        mintBurn: number | null;
        depegs: number | null;
        discoveryCandidates: number | null;
      };
    };

    expect(body.datasetFreshness.blacklist).toBe(blacklistWriterAt);
    expect(body.datasetFreshness.mintBurn).toBe(mintBurnWriterAt);
    expect(body.datasetFreshness.depegs).toBe(depegWriterAt);
    expect(body.datasetFreshness.discoveryCandidates).toBe(discoveryWriterAt);
  });

  it("marks data quality stale when the stablecoins cache is malformed", async () => {
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
      { match: "cache", rows: [], first: { value: "{bad-json", updated_at: Math.floor(Date.now() / 1000) - 60 } },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      dataQualityStatus: string;
      dataQuality: {
        stablecoinsCacheStatus: string;
        stablecoinsCacheReason: string | null;
      };
      causes: { dataQuality: Array<{ code: string }> };
    };

    expect(body.dataQualityStatus).toBe("stale");
    expect(body.dataQuality.stablecoinsCacheStatus).toBe("error");
    expect(body.dataQuality.stablecoinsCacheReason).toBe("json-parse-failed");
    expect(body.causes.dataQuality.some((cause) => cause.code === "stablecoins_cache_unavailable")).toBe(true);
  });

  it("marks data quality degraded when the blacklist-gap query fails", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], throwError: "blacklist query failed" },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      dataQualityStatus: string;
      dataQuality: {
        blacklistGapStatus: string;
        sourceFailures: Array<{ source: string; message: string }>;
      };
      causes: { dataQuality: Array<{ code: string }> };
    };

    expect(body.dataQualityStatus).toBe("degraded");
    expect(body.dataQuality.blacklistGapStatus).toBe("failed");
    expect(body.dataQuality.sourceFailures).toContainEqual({
      source: "blacklist-gaps",
      message: "blacklist query failed",
    });
    expect(body.causes.dataQuality.some((cause) => cause.code === "blacklist_gap_query_failed")).toBe(true);
  });

  it("returns Cache-Control: no-store", async () => {
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [] },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);

    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("includes cron health data in the response", async () => {
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      {
        match: "cron_runs",
        rows: [makeCronRow("sync-stablecoins", "ok", 100)],
      },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      crons: Record<string, { lastRun: unknown; healthy: boolean; expectedIntervalSec: number }>;
    };

    expect(body.crons).toHaveProperty("sync-stablecoins");
    const syncStablecoins = body.crons["sync-stablecoins"];
    expect(syncStablecoins).toHaveProperty("lastRun");
    expect(syncStablecoins).toHaveProperty("healthy");
    expect(syncStablecoins).toHaveProperty("expectedIntervalSec");
  });

  it("includes in-flight cron progress when a leased job is still running", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [makeCronRow("sync-blacklist", "ok", 30)] },
      {
        match: "cron_leases",
        rows: [{ job: "sync-blacklist", lease_owner: "lease-123", lease_until: now + 600 }],
      },
      {
        match: "cron_run_progress",
        rows: [
          {
            job: "sync-blacklist",
            started_at: now - 120,
            updated_at: now - 10,
            stage: "scan-config",
            items_done: 2,
            items_total: 7,
            message: "Scanning USDC on Ethereum",
            lease_owner: "lease-123",
            metadata: JSON.stringify({ budgetUsed: 18, budgetLimit: 900 }),
          },
        ],
      },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      crons: Record<
        string,
        { inFlight?: { stage?: string; stale: boolean; itemsDone?: number; itemsTotal?: number } | null }
      >;
    };

    expect(body.crons["sync-blacklist"]?.inFlight).toMatchObject({
      stage: "scan-config",
      stale: false,
      itemsDone: 2,
      itemsTotal: 7,
    });
  });

  it("treats a fresh in-flight recovery run as healthy even if the last completed run errored", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const jobs = Object.keys(CRON_INTERVALS);
    const cronRows = [
      ...jobs.map((job) => makeCronRow(job, job === "sync-blacklist" ? "error" : "ok", 30)),
      makeCronRow("sync-redemption-backstops", "ok", 30),
    ];
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          makeCacheRow("stablecoins"),
          makeCacheRow("stablecoin-charts"),
          makeCacheRow("usds-status"),
          makeCacheRow("fx-rates"),
          makeCacheRow("treasury-stable-exposure"),
          makeCacheRow("bluechip-ratings"),
        ],
      },
      { match: "dex_liquidity", rows: [], first: { age: 60 } },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "cron_runs", rows: cronRows },
      {
        match: "cron_leases",
        rows: [{ job: "sync-blacklist", lease_owner: "lease-456", lease_until: now + 600 }],
      },
      {
        match: "cron_run_progress",
        rows: [
          {
            job: "sync-blacklist",
            started_at: now - 120,
            updated_at: now - 10,
            stage: "scan-config",
            items_done: 4,
            items_total: 7,
            message: "Scanning USDT on Ethereum",
            lease_owner: "lease-456",
            metadata: JSON.stringify({ budgetUsed: 31, budgetLimit: 900 }),
          },
        ],
      },
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], first: { total: 1000, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - 5 * 86400, tracked: 12 } },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      availabilityStatus: string;
      summary: { unhealthyCrons: number; cronErrors: number };
      crons: Record<string, { healthy: boolean }>;
    };

    expect(body.crons["sync-blacklist"]?.healthy).toBe(true);
    expect(body.summary.unhealthyCrons).toBe(0);
    expect(body.summary.cronErrors).toBe(0);
    expect(body.availabilityStatus).toBe("healthy");
  });

  it("ignores orphaned in-flight progress when the lease is no longer active", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [makeCronRow("sync-blacklist", "error", 30)] },
      { match: "cron_leases", rows: [] },
      {
        match: "cron_run_progress",
        rows: [
          {
            job: "sync-blacklist",
            started_at: now - 120,
            updated_at: now - 10,
            stage: "scan-config",
            items_done: 4,
            items_total: 7,
            message: "Scanning USDT on Ethereum",
            lease_owner: "stale-lease",
            metadata: JSON.stringify({ budgetUsed: 31, budgetLimit: 900 }),
          },
        ],
      },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      crons: Record<string, { healthy: boolean; inFlight?: unknown | null }>;
      summary: { unhealthyCrons: number };
      availabilityStatus: string;
    };

    expect(body.crons["sync-blacklist"]?.inFlight).toBeNull();
    expect(body.crons["sync-blacklist"]?.healthy).toBe(false);
    expect(body.summary.unhealthyCrons).toBeGreaterThan(0);
    expect(body.availabilityStatus).toBe("stale");
  });

  it("includes Telegram bot subscriber stats when Telegram tables are present", async () => {
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [makeCronRow("dispatch-telegram-alerts", "ok", 60)] },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
      {
        match: "FROM telegram_subscribers s",
        rows: [],
        first: {
          total_chats: 12,
          alert_enabled_chats: 10,
          deliverable_chats: 9,
          subscribed_chats: 11,
          empty_alert_chats: 1,
          muted_chats_with_subscriptions: 2,
          dews_chats: 8,
          depeg_chats: 7,
          safety_chats: 6,
          all_types_chats: 5,
          total_subscriptions: 37,
          avg_subscriptions_per_subscribed_chat: 3.36,
          last_subscriber_activity_at: 1772000000,
        },
      },
      {
        match: "FROM telegram_pending_disambiguation",
        rows: [],
        first: { pending_count: 3 },
      },
      {
        match: "FROM telegram_pending_alerts",
        rows: [],
        first: { pending_count: 4 },
      },
      {
        match: "GROUP BY stablecoin_id",
        rows: [
          { stablecoin_id: "usdc-circle", subscribers: 7 },
          { stablecoin_id: "usde-ethena", subscribers: 4 },
        ],
      },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      telegramBot: {
        totalChats: number;
        deliverableChats: number;
        totalSubscriptions: number;
        pendingDisambiguations: number;
        pendingDeliveries: number;
        customPreferenceChats: number;
        quietHoursEnabledChats: number;
        alertTypeChats: { dews: number; depeg: number; safety: number; allTypes: number };
        topStablecoins: Array<{ stablecoinId: string; symbol: string; subscribers: number }>;
      } | null;
    };

    expect(body.telegramBot).not.toBeNull();
    expect(body.telegramBot?.totalChats).toBe(12);
    expect(body.telegramBot?.deliverableChats).toBe(9);
    expect(body.telegramBot?.totalSubscriptions).toBe(37);
    expect(body.telegramBot?.pendingDisambiguations).toBe(3);
    expect(body.telegramBot?.pendingDeliveries).toBe(4);
    expect(body.telegramBot?.customPreferenceChats).toBe(0);
    expect(body.telegramBot?.quietHoursEnabledChats).toBe(0);
    expect(body.telegramBot?.alertTypeChats).toEqual({
      dews: 8,
      depeg: 7,
      safety: 6,
      allTypes: 5,
    });
    expect(body.telegramBot?.topStablecoins).toEqual([
      { stablecoinId: "usdc-circle", symbol: "USDC", subscribers: 7 },
      { stablecoinId: "usde-ethena", symbol: "USDe", subscribers: 4 },
    ]);
  });

  it("returns telegramBot=null when Telegram tables are unavailable", async () => {
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 100)] },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
      {
        match: "FROM telegram_subscribers s",
        rows: [],
        throwError: "no such table: telegram_subscribers",
      },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as { telegramBot: unknown };

    expect(res.status).toBe(200);
    expect(body.telegramBot).toBeNull();
  });

  it("surfaces subsection loader failures through sectionErrors", async () => {
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 100)] },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
      {
        match: "FROM discovery_candidates WHERE dismissed = 0",
        rows: [],
        throwError: "discovery query exploded",
      },
      {
        match: "FROM telegram_subscribers s",
        rows: [],
        throwError: "no such table: telegram_subscribers",
      },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      sectionErrors: Record<string, { code: string; message: string } | undefined>;
      discoveryCandidates: unknown;
      telegramBot: unknown;
    };

    expect(body.discoveryCandidates).toBeNull();
    expect(body.telegramBot).toBeNull();
    expect(body.sectionErrors.discoveryCandidates).toEqual({
      code: "discovery_candidates_query_failed",
      message: "discovery query exploded",
    });
    expect(body.sectionErrors.telegramBot).toEqual({
      code: "telegram_bot_stats_query_failed",
      message: "no such table: telegram_subscribers",
    });
  });

  it("marks status degraded and skips data-quality queries when DB sentinel fails", async () => {
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
    ]) as D1Database & { prepare: (sql: string) => D1PreparedStatement };

    const seenSql: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      seenSql.push(sql);
      if (sql.trim() === "SELECT 1") {
        return {
          bind: () => ({
            all: async () => ({ results: [], success: true, meta: {} }),
            first: async () => {
              throw new Error("db down");
            },
            run: async () => ({ success: true, meta: {} }),
          }),
          all: async () => ({ results: [], success: true, meta: {} }),
          first: async () => {
            throw new Error("db down");
          },
          run: async () => ({ success: true, meta: {} }),
        } as unknown as D1PreparedStatement;
      }
      return originalPrepare(sql);
    }) as typeof db.prepare;

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      dbHealthy: boolean;
      rawOverallStatus: string;
      overallStatus: string;
    };

    expect(res.status).toBe(200);
    expect(body.dbHealthy).toBe(false);
    expect(["degraded", "stale"]).toContain(body.rawOverallStatus);
    expect(["degraded", "stale"]).toContain(body.overallStatus);
    expect(seenSql.some((sql) => sql.includes("FROM depeg_events"))).toBe(false);
    expect(seenSql.some((sql) => sql.includes("FROM onchain_supply"))).toBe(false);
  });

  it("keeps cron healthy when latest run is skipped_locked but a fresh ok run exists", async () => {
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      {
        match: "cron_runs",
        rows: [makeCronRow("sync-stablecoins", "skipped_locked", 30), makeCronRow("sync-stablecoins", "ok", 90)],
      },
      { match: "cache", rows: [] },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      crons: Record<string, { healthy: boolean }>;
    };

    expect(body.crons["sync-stablecoins"]?.healthy).toBe(true);
  });

  it("treats fresh degraded cron runs as warning-only (not availability unhealthy)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const jobs = Object.keys(CRON_INTERVALS);
    const cronRows = [
      ...jobs.map((job) => makeCronRow(job, job === "fetch-tbill-rate" ? "degraded" : "ok", 30)),
      makeCronRow("sync-redemption-backstops", "ok", 30),
    ];
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          makeCacheRow("stablecoins"),
          makeCacheRow("stablecoin-charts"),
          makeCacheRow("usds-status"),
          makeCacheRow("fx-rates"),
          makeCacheRow("treasury-stable-exposure"),
          makeCacheRow("bluechip-ratings"),
        ],
      },
      { match: "dex_liquidity", rows: [], first: { age: 60 } },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "cron_runs", rows: cronRows },
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], first: { total: 1000, missing: 1, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - 5 * 86400, tracked: 12 } },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      availabilityStatus: string;
      summary: { unhealthyCrons: number; degradedCrons: number };
      crons: Record<string, { healthy: boolean }>;
    };

    expect(body.crons["fetch-tbill-rate"]?.healthy).toBe(true);
    expect(body.summary.unhealthyCrons).toBe(0);
    expect(body.summary.degradedCrons).toBe(1);
    expect(body.availabilityStatus).toBe("healthy");
  });

  it("marks on-chain monitor unavailable instead of forcing stale data quality", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "dex_liquidity", rows: [], first: { age: 60 } },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      // Latest on-chain update is too old -> monitor unavailable.
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - 5 * 86400, tracked: 12 } },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      dataQualityStatus: string;
      dataQuality: {
        onchainSupplyMonitoring: string;
        staleOnchainSupply: number;
        onchainSupplyDivergences: number;
      };
      causes: {
        dataQuality: Array<{ code: string }>;
        overall: Array<{ code: string }>;
      };
    };

    expect(body.dataQuality.onchainSupplyMonitoring).toBe("unavailable");
    expect(body.dataQuality.staleOnchainSupply).toBe(0);
    expect(body.dataQuality.onchainSupplyDivergences).toBe(0);
    expect(body.dataQualityStatus).toBe("healthy");
    // Info-level cause is emitted when monitor is unavailable (does not affect health status)
    expect(body.causes.dataQuality.some((cause) => cause.code === "onchain_monitor_unavailable")).toBe(true);
    expect(body.causes.overall.some((cause) => cause.code === "onchain_monitor_unavailable")).toBe(true);
  });

  it("counts only recently refreshed on-chain rows as actively monitored", async () => {
    const now = Math.floor(Date.now() / 1000);
    const onchainActiveWindowStart = now - 3 * 24 * 3600;
    const onchainFreshWindowStart = now - 2 * 3600;
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "kau-kinesis", symbol: "KAU", price: 3000, circulating: { peggedXAU: 90_000_000 } }],
    });
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "dex_liquidity", rows: [], first: { age: 60 } },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      // Overall latest row is fresh, but only 2 coins are inside the active monitoring window.
      {
        match: "MAX(updated_at) as latest",
        matchBinds: [onchainActiveWindowStart],
        rows: [],
        first: { latest: now - 60, tracked: 2 },
      },
      // No stale coins inside the active monitoring window.
      {
        match: "HAVING latest_update < ?",
        matchBinds: [onchainActiveWindowStart, onchainFreshWindowStart],
        rows: [],
        first: { cnt: 0 },
      },
      {
        match: "onchain_supply WHERE updated_at >",
        matchBinds: [onchainFreshWindowStart],
        rows: [],
        first: null,
      },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      dataQualityStatus: string;
      dataQuality: {
        onchainSupplyMonitoring: string;
        onchainSupplyTrackedCoins: number;
        staleOnchainSupply: number;
        onchainStaleRatio: number;
      };
    };

    expect(body.dataQuality.onchainSupplyMonitoring).toBe("active");
    expect(body.dataQuality.onchainSupplyTrackedCoins).toBe(2);
    expect(body.dataQuality.staleOnchainSupply).toBe(0);
    expect(body.dataQuality.onchainStaleRatio).toBe(0);
    expect(body.dataQualityStatus).toBe("healthy");

    const seenSql = db.getHistory().map((entry) => entry.sql.replace(/\s+/g, " ").trim());
    expect(
      seenSql.some((sql) =>
        sql.includes("COUNT(DISTINCT CASE WHEN updated_at >= ? THEN stablecoin_id END) as tracked FROM onchain_supply"),
      ),
    ).toBe(true);
    expect(
      seenSql.some((sql) =>
        sql.includes("FROM onchain_supply WHERE updated_at >= ? GROUP BY stablecoin_id HAVING latest_update < ?"),
      ),
    ).toBe(true);
  });

  it("does not let a tiny on-chain monitor population escalate data quality via ratios alone", async () => {
    const now = Math.floor(Date.now() / 1000);
    const onchainActiveWindowStart = now - 3 * 24 * 3600;
    const onchainFreshWindowStart = now - 2 * 3600;
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "kau-kinesis", symbol: "KAU", price: 3000, circulating: { peggedXAU: 90_000_000 } }],
    });
    const jobs = Object.keys(CRON_INTERVALS);
    const cronRows = [
      ...jobs.map((job) => makeCronRow(job, "ok", 30)),
      makeCronRow("sync-redemption-backstops", "ok", 30),
    ];
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          makeCacheRow("stablecoins"),
          makeCacheRow("stablecoin-charts"),
          makeCacheRow("usds-status"),
          {
            key: "fx-rates",
            updated_at: now - 60,
            value: JSON.stringify({ peggedEUR: 1.08 }),
          },
          makeCacheRow("treasury-stable-exposure"),
          makeCacheRow("bluechip-ratings"),
        ],
      },
      { match: "dex_liquidity", rows: [], first: { age: 60 } },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "cron_runs", rows: cronRows },
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      {
        match: "MAX(updated_at) as latest",
        matchBinds: [onchainActiveWindowStart],
        rows: [],
        first: { latest: now - 60, tracked: 2 },
      },
      {
        match: "HAVING latest_update < ?",
        matchBinds: [onchainActiveWindowStart, onchainFreshWindowStart],
        rows: [],
        first: { cnt: 0 },
      },
      {
        match: "onchain_supply WHERE updated_at >",
        matchBinds: [onchainFreshWindowStart],
        rows: [{ stablecoin_id: "kau-kinesis", total_supply: 1 }, { stablecoin_id: "kag-kinesis", total_supply: 2 }],
        first: null,
      },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      dataQualityStatus: string;
      rawOverallStatus: string;
      causes: {
        dataQuality: Array<{ code: string }>;
      };
      dataQuality: {
        onchainSupplyMonitoring: string;
        onchainSupplyTrackedCoins: number;
        onchainSupplyDivergences: number;
        onchainDivergenceRatio: number;
      };
    };

    expect(body.dataQuality.onchainSupplyMonitoring).toBe("active");
    expect(body.dataQuality.onchainSupplyTrackedCoins).toBe(2);
    expect(body.dataQuality.onchainSupplyDivergences).toBe(1);
    expect(body.dataQuality.onchainDivergenceRatio).toBe(0.5);
    expect(body.dataQualityStatus).toBe("healthy");
    expect(body.rawOverallStatus).toBe("healthy");
    expect(body.causes.dataQuality.some((cause) => cause.code === "onchain_monitor_low_sample")).toBe(true);
    expect(body.causes.dataQuality.some((cause) => cause.code === "onchain_integrity_stale")).toBe(false);
  });

  it("keeps availability degraded and emits FX fallback causes when usable FX sync is fresh but source data is old", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const jobs = Object.keys(CRON_INTERVALS);
    const cronRows = [
      ...jobs.map((job) => makeCronRow(job, "ok", 30)),
      makeCronRow("sync-redemption-backstops", "ok", 30),
    ];
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          makeCacheRow("stablecoins"),
          makeCacheRow("stablecoin-charts"),
          makeCacheRow("usds-status"),
          {
            key: "fx-rates",
            updated_at: now - 60,
            value: JSON.stringify({ peggedEUR: 1.08 }),
          },
          {
            key: "fx-rates-meta",
            updated_at: now - 60,
            value: JSON.stringify({
              usableSyncAt: now - 60,
              mode: "cached-fallback",
              sourceUpdatedAtByPeg: { peggedEUR: now - 8 * 3600 },
              sourceModeByPeg: { peggedEUR: "cached" },
              sourceCadenceByPeg: { peggedEUR: "intraday" },
              consecutiveFallbackRuns: 4,
            }),
          },
          makeCacheRow("treasury-stable-exposure"),
          makeCacheRow("bluechip-ratings"),
        ],
      },
      { match: "dex_liquidity", rows: [], first: { age: 60 } },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "cron_runs", rows: cronRows },
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - 5 * 86400, tracked: 12 } },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      availabilityStatus: string;
      caches: Record<string, { mode?: string; sourceStatus?: string }>;
      causes: { availability: Array<{ code: string }> };
    };

    expect(body.availabilityStatus).toBe("degraded");
    expect(body.caches["fx-rates"]).toMatchObject({
      mode: "cached-fallback",
      sourceStatus: "degraded",
    });
    expect(body.causes.availability.some((cause) => cause.code === "fx_cached_fallback")).toBe(true);
    expect(body.causes.availability.some((cause) => cause.code === "fx_source_degraded")).toBe(true);
  });

  it("degrades availability when the critical mint/burn lane is in public degraded mode", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const cronRows = Object.keys(CRON_INTERVALS).map((job) =>
      makeCronRow(job, job === "sync-mint-burn" ? "degraded" : "ok", 60),
    );
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          makeCacheRow("stablecoins"),
          makeCacheRow("stablecoin-charts"),
          makeCacheRow("usds-status"),
          makeCacheRow("fx-rates"),
          makeCacheRow("treasury-stable-exposure"),
          makeCacheRow("bluechip-ratings"),
        ],
      },
      { match: "dex_liquidity", rows: [], first: { age: 60 } },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "mint_burn_hourly", rows: [], first: { total: 1234 } },
      { match: "SELECT MAX(timestamp) as latest FROM mint_burn_events", rows: [], first: { latest: now - 30 } },
      { match: "SELECT MAX(hour_ts) as latest FROM mint_burn_hourly", rows: [], first: { latest: now - 3600 } },
      { match: "SELECT symbol, MAX(timestamp) as latest", rows: [{ symbol: "USDT", latest: now - 300 }] },
      { match: "SELECT status", rows: [], first: { status: "degraded" } },
      { match: "status = 'ok'", rows: [], first: { started_at: now - 600 } },
      { match: "cron_runs", rows: cronRows },
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - 5 * 86400, tracked: 12 } },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      availabilityStatus: string;
      causes: { availability: Array<{ code: string }> };
    };

    expect(body.availabilityStatus).toBe("degraded");
    expect(body.causes.availability.some((cause) => cause.code === "mint_burn_public_degraded")).toBe(true);
  });

  it("degrades availability when three or more circuit groups are open", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const cronRows = Object.keys(CRON_INTERVALS).map((job) => makeCronRow(job, "ok", 60));
    const openCircuitValue = (openedAt: number) => JSON.stringify({
      state: "open",
      consecutiveFailures: 3,
      lastFailureAt: openedAt - 30,
      lastSuccessAt: null,
      openedAt,
    });
    const db = mockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          makeCacheRow("stablecoins"),
          makeCacheRow("stablecoin-charts"),
          makeCacheRow("usds-status"),
          makeCacheRow("fx-rates"),
          makeCacheRow("treasury-stable-exposure"),
          makeCacheRow("bluechip-ratings"),
        ],
      },
      { match: "dex_liquidity", rows: [], first: { age: 60 } },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "cron_runs", rows: cronRows },
      {
        match: "key LIKE 'circuit:%'",
        rows: [
          { key: "circuit:defillama-stablecoins", value: openCircuitValue(now - 600) },
          { key: "circuit:coingecko-prices", value: openCircuitValue(now - 540) },
          { key: "circuit:dexscreener-prices", value: openCircuitValue(now - 480) },
        ],
      },
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - 5 * 86400, tracked: 12 } },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      availabilityStatus: string;
      causes: { availability: Array<{ code: string }> };
    };

    expect(body.availabilityStatus).toBe("degraded");
    expect(body.causes.availability.some((cause) => cause.code === "open_circuit_groups")).toBe(true);
  });

  it("keeps data quality healthy when blacklist gaps are low-ratio and not recent", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "dex_liquidity", rows: [], first: { age: 60 } },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], first: { total: 20000, missing: 40, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - 5 * 86400, tracked: 12 } },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      dataQualityStatus: string;
      dataQuality: { blacklistMissingRatio: number; blacklistRecentMissingAmounts: number };
    };

    expect(body.dataQuality.blacklistMissingRatio).toBeCloseTo(0.002, 6);
    expect(body.dataQuality.blacklistRecentMissingAmounts).toBe(0);
    expect(body.dataQualityStatus).toBe("healthy");
  });

  it("excludes intentional Tron blacklist/unblacklist null amounts from blacklist gap metric", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "dex_liquidity", rows: [], first: { age: 60 } },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
      {
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], first: { total: 100, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - 5 * 86400, tracked: 12 } },
    ]) as D1Database & { prepare: (sql: string) => D1PreparedStatement };

    const seenSql: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      seenSql.push(sql);
      return originalPrepare(sql);
    }) as typeof db.prepare;

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    expect(res.status).toBe(200);

    const blacklistSql = seenSql.find((sql) => sql.includes("FROM blacklist_events")) ?? "";
    expect(blacklistSql).toContain("amount_status IN ('recoverable_pending', 'provider_failed', 'ambiguous')");
  });

  it("returns a degraded fallback payload when the DB health sentinel fails", async () => {
    const db = mockD1([{ match: "SELECT 1", rows: [], throwError: new Error("db down") }]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      dbHealthy: boolean;
      availabilityStatus: "healthy" | "degraded" | "stale";
      dataQualityStatus: "healthy" | "degraded" | "stale";
      overallStatus: "healthy" | "degraded" | "stale";
      causes: { availability: Array<{ code: string }> };
      caches: Record<string, unknown>;
    };

    expect(body.dbHealthy).toBe(false);
    expect(body.availabilityStatus).toBe("stale");
    expect(body.dataQualityStatus).toBe("stale");
    expect(body.overallStatus).toBe("stale");
    expect(body.caches).toEqual({});
    expect(body.causes.availability.some((cause) => cause.code === "db_unhealthy")).toBe(true);
  });

  it("surfaces cache freshness query failures as availability causes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const db = mockD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "dex_liquidity", rows: [], throwError: new Error("dex freshness failed") },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
      { match: "cache", rows: [], first: { value: stablecoinsCache, updated_at: now - 60 } },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - 5 * 86400, tracked: 12 } },
    ]);

    const request = makeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      availabilityStatus: "healthy" | "degraded" | "stale";
      causes: { availability: Array<{ code: string }> };
    };

    expect(body.availabilityStatus).toBe("stale");
    expect(body.causes.availability.some((cause) => cause.code === "cache_freshness_query_failed")).toBe(true);
  });
});
