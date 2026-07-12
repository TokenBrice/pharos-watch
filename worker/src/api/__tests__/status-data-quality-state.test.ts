import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleStatus,
  makeCacheRow,
  makeCronRow,
  cleanupStatusTest,
  fixtureMockD1,
  fixtureMakeApiRequest,
  fixtureCRON_INTERVALS,
  fixtureACTIVE_STABLECOINS,
} from "./status.test-support";

describe("handleStatus", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
  });
  afterEach(cleanupStatusTest);
  it("marks on-chain monitor unavailable instead of forcing stale data quality", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const db = fixtureMockD1([
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

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
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
    const db = fixtureMockD1([
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

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
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
    const jobs = Object.keys(fixtureCRON_INTERVALS);
    const cronRows = [
      ...jobs.map((job) => makeCronRow(job, "ok", 30)),
      makeCronRow("sync-redemption-backstops", "ok", 30),
    ];
    const db = fixtureMockD1([
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
        rows: [
          { stablecoin_id: "kau-kinesis", total_supply: 1 },
          { stablecoin_id: "kag-kinesis", total_supply: 2 },
        ],
        first: null,
      },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
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
    // As of the 2026-04-13 status-stability hardening,
    // `onchain_monitor_low_sample` is suppressed below the structural floor
    // (tracked < 3) because the 2-coin population is the permanent state of
    // the Kinesis-only writer set, not a diagnostic worth surfacing. The
    // ratio-escalation guard (!representative) is still verified by the
    // dataQualityStatus === "healthy" assertion above.
    expect(body.causes.dataQuality.some((cause) => cause.code === "onchain_monitor_low_sample")).toBe(false);
    expect(body.causes.dataQuality.some((cause) => cause.code === "onchain_integrity_stale")).toBe(false);
  });

  it("keeps availability degraded and emits FX fallback causes when usable FX sync is fresh but source data is old", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const jobs = Object.keys(fixtureCRON_INTERVALS);
    const cronRows = [
      ...jobs.map((job) => makeCronRow(job, "ok", 30)),
      makeCronRow("sync-redemption-backstops", "ok", 30),
    ];
    const db = fixtureMockD1([
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

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
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
    const cronRows = Object.keys(fixtureCRON_INTERVALS).map((job) =>
      makeCronRow(job, job === "sync-mint-burn" ? "degraded" : "ok", 60),
    );
    const db = fixtureMockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          makeCacheRow("stablecoins"),
          makeCacheRow("stablecoin-charts"),
          makeCacheRow("usds-status"),
          makeCacheRow("fx-rates"),
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

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
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
    const cronRows = Object.keys(fixtureCRON_INTERVALS).map((job) => makeCronRow(job, "ok", 60));
    const openCircuitValue = (openedAt: number) =>
      JSON.stringify({
        state: "open",
        consecutiveFailures: 3,
        lastFailureAt: openedAt - 30,
        lastSuccessAt: null,
        openedAt,
      });
    const db = fixtureMockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          makeCacheRow("stablecoins"),
          makeCacheRow("stablecoin-charts"),
          makeCacheRow("usds-status"),
          makeCacheRow("fx-rates"),
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

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      availabilityStatus: string;
      causes: { availability: Array<{ code: string }> };
    };

    expect(body.availabilityStatus).toBe("degraded");
    expect(body.causes.availability.some((cause) => cause.code === "open_circuit_groups")).toBe(true);
  });

  it("keeps availability healthy when only live-reserve circuit groups are open", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const cronRows = Object.keys(fixtureCRON_INTERVALS).map((job) => makeCronRow(job, "ok", 60));
    const openCircuitValue = (openedAt: number) =>
      JSON.stringify({
        state: "open",
        consecutiveFailures: 3,
        lastFailureAt: openedAt - 30,
        lastSuccessAt: null,
        openedAt,
      });
    const db = fixtureMockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          makeCacheRow("stablecoins"),
          makeCacheRow("stablecoin-charts"),
          makeCacheRow("usds-status"),
          makeCacheRow("fx-rates"),
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
          { key: "circuit:live-reserves:ethena", value: openCircuitValue(now - 600) },
          { key: "circuit:live-reserves:feusd-felix", value: openCircuitValue(now - 540) },
          { key: "circuit:live-reserves:mtbill-midas", value: openCircuitValue(now - 480) },
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

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      availabilityStatus: string;
      causes: { availability: Array<{ code: string }> };
    };

    expect(body.availabilityStatus).toBe("healthy");
    expect(body.causes.availability.some((cause) => cause.code === "open_circuit_groups")).toBe(false);
  });

  it("keeps data quality healthy when blacklist gaps are low-ratio and not recent", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const db = fixtureMockD1([
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

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      dataQualityStatus: string;
      dataQuality: { blacklistMissingRatio: number; blacklistRecentMissingAmounts: number };
    };

    expect(body.dataQuality.blacklistMissingRatio).toBeCloseTo(0.002, 6);
    expect(body.dataQuality.blacklistRecentMissingAmounts).toBe(0);
    expect(body.dataQualityStatus).toBe("healthy");
  });

  it("keeps data quality healthy for an isolated recent blacklist amount gap", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const db = fixtureMockD1([
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
      { match: "blacklist_events", rows: [], first: { total: 16000, missing: 1, missing_recent: 1 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - 5 * 86400, tracked: 12 } },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    const body = (await res.json()) as {
      dataQualityStatus: string;
      causes: { dataQuality: Array<{ code: string }> };
      dataQuality: { blacklistMissingRatio: number; blacklistRecentMissingAmounts: number };
    };

    expect(body.dataQuality.blacklistMissingRatio).toBeCloseTo(1 / 16000, 8);
    expect(body.dataQuality.blacklistRecentMissingAmounts).toBe(1);
    expect(body.causes.dataQuality.some((cause) => cause.code === "blacklist_gaps_degraded")).toBe(false);
    expect(body.dataQualityStatus).toBe("healthy");
  });

  it("excludes intentional Tron blacklist/unblacklist null amounts from blacklist gap metric", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const db = fixtureMockD1([
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

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    expect(res.status).toBe(200);

    const blacklistSql = seenSql.find((sql) => sql.includes("FROM blacklist_events")) ?? "";
    expect(blacklistSql).toContain("amount_status IN ('recoverable_pending', 'provider_failed', 'ambiguous')");
  });

  it("returns a degraded fallback payload when the DB health sentinel fails", async () => {
    const db = fixtureMockD1([{ match: "SELECT 1", rows: [], throwError: new Error("db down") }]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
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
    const db = fixtureMockD1([
      {
        match: "cache WHERE key IN",
        rows: [
          makeCacheRow("stablecoins"),
          makeCacheRow("stablecoin-charts"),
          makeCacheRow("usds-status"),
          makeCacheRow("fx-rates"),
          makeCacheRow("bluechip-ratings"),
        ],
      },
      { match: "dex_liquidity", rows: [], throwError: new Error("dex freshness failed") },
      { match: "yield_data", rows: [], first: { age: 60 } },
      { match: "stress_signals", rows: [], first: { age: 60 } },
      { match: "GROUP BY job", rows: [{ job: "sync-dex-liquidity", started_at: now - 300 }] },
      { match: "UNION ALL", rows: [], throwError: new Error("cron history unavailable") },
      { match: "cache", rows: [], first: { value: stablecoinsCache, updated_at: now - 60 } },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - 5 * 86400, tracked: 12 } },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus(db, true, request);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      availabilityStatus: "healthy" | "degraded" | "stale";
      causes: { availability: Array<{ code: string }> };
    };

    expect(body.availabilityStatus).toBe("healthy");
    expect(body.causes.availability.some((cause) => cause.code === "cache_freshness_query_failed")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2026-04-13 status-stability hardening: missing-price thresholds.
  // -------------------------------------------------------------------------
  //
  // Raise `missingPriceRatio` thresholds from 0.15/0.40 to 0.18/0.45 so the
  // normal ~15% operating point with 181 active canonical stablecoins no
  // longer flaps at the 15% boundary. Add a new info-severity
  // `missing_prices_elevated` cause in the 15-18% band for early-warning
  // observability.
  describe("missingPriceRatio raised thresholds + elevated info cause", () => {
    /**
     * Build a peggedAssets list using real canonical IDs from
     * ACTIVE_STABLECOINS. The first `total` active IDs are used; the first
     * `missing` of those get `price: null`. This ensures the canonical-
     * scoping filter in `getDataQuality` keeps them in the denominator.
     */
    function buildPeggedAssets(total: number, missing: number): unknown[] {
      const ids = fixtureACTIVE_STABLECOINS.slice(0, total).map((c) => c.id);
      return ids.map((id, i) => ({
        id,
        symbol: id.toUpperCase(),
        pegType: "peggedUSD",
        price: i < missing ? null : 1,
        circulating: { peggedUSD: 10_000_000 },
      }));
    }

    function buildBaselineDb(total: number, missing: number) {
      const now = Math.floor(Date.now() / 1000);
      const stablecoinsCache = JSON.stringify({
        peggedAssets: buildPeggedAssets(total, missing),
      });
      return fixtureMockD1([
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
    }

    type DataQualityCause = { code: string; severity: string; threshold?: number };
    type StatusBody = {
      dataQualityStatus: string;
      overallStatus: string;
      causes: { dataQuality: DataQualityCause[] };
    };

    it("stays healthy just below the 18% degraded threshold", async () => {
      const total = fixtureACTIVE_STABLECOINS.length;
      const missing = Math.floor(total * 0.18);
      const db = buildBaselineDb(total, missing);
      const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
      const res = await handleStatus(db, true, request);
      const body = (await res.json()) as StatusBody;
      expect(body.dataQualityStatus).toBe("healthy");
      const codes = body.causes.dataQuality.map((c) => c.code);
      expect(codes).not.toContain("missing_prices_degraded");
      expect(codes).not.toContain("missing_prices_stale");
    });

    it("degrades just above the 18% threshold", async () => {
      const total = fixtureACTIVE_STABLECOINS.length;
      const missing = Math.floor(total * 0.18) + 1;
      const db = buildBaselineDb(total, missing);
      const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
      const res = await handleStatus(db, true, request);
      const body = (await res.json()) as StatusBody;
      expect(body.dataQualityStatus).toBe("degraded");
      const degradedCause = body.causes.dataQuality.find((c) => c.code === "missing_prices_degraded");
      expect(degradedCause).toBeDefined();
      expect(degradedCause?.threshold).toBe(0.18);
      expect(degradedCause?.severity).toBe("warning");
    });

    it("stays healthy and emits missing_prices_elevated in the 15-18% band", async () => {
      const total = fixtureACTIVE_STABLECOINS.length;
      const missing = Math.ceil(total * 0.16);
      const db = buildBaselineDb(total, missing);
      const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
      const res = await handleStatus(db, true, request);
      const body = (await res.json()) as StatusBody;
      expect(body.dataQualityStatus).toBe("healthy");
      const elevatedCause = body.causes.dataQuality.find((c) => c.code === "missing_prices_elevated");
      expect(elevatedCause).toBeDefined();
      expect(elevatedCause?.severity).toBe("info");
      expect(elevatedCause?.threshold).toBe(0.15);
    });

    it("does not emit missing_prices_elevated below the 15% elevated floor", async () => {
      const total = fixtureACTIVE_STABLECOINS.length;
      const missing = Math.floor(total * 0.14);
      const db = buildBaselineDb(total, missing);
      const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
      const res = await handleStatus(db, true, request);
      const body = (await res.json()) as StatusBody;
      expect(body.dataQualityStatus).toBe("healthy");
      const codes = body.causes.dataQuality.map((c) => c.code);
      expect(codes).not.toContain("missing_prices_elevated");
      expect(codes).not.toContain("missing_prices_degraded");
      expect(codes).not.toContain("missing_prices_stale");
    });

    it("goes stale just above the 45% threshold", async () => {
      const total = fixtureACTIVE_STABLECOINS.length;
      const missing = Math.floor(total * 0.45) + 1;
      const db = buildBaselineDb(total, missing);
      const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
      const res = await handleStatus(db, true, request);
      const body = (await res.json()) as StatusBody;
      expect(body.dataQualityStatus).toBe("stale");
      const staleCause = body.causes.dataQuality.find((c) => c.code === "missing_prices_stale");
      expect(staleCause).toBeDefined();
      expect(staleCause?.threshold).toBe(0.45);
      expect(staleCause?.severity).toBe("critical");
    });
  });

  // -------------------------------------------------------------------------
  // Follow-up #4 — scope missingPriceRatio denominator to active canonical
  // -------------------------------------------------------------------------
  //
  // The pre-follow-up implementation counted all peggedAssets in the cache,
  // including DefiLlama residuals (numeric IDs from the DL API that we are
  // not actively tracking). In prod that inflated the denominator beyond the
  // active canonical set, giving a baseline missing ratio that was always
  // flapping near the 15% threshold. Restricting the denominator to
  // ACTIVE_STABLECOINS drops the prod baseline to the true canonical-missing
  // ratio.
  describe("missingPriceRatio canonical scoping", () => {
    function buildMixedCacheDb(params: {
      canonicalTotal: number;
      canonicalMissing: number;
      residuals: number;
      residualsMissing: number;
      publicationCoverage?: Record<string, unknown>;
    }) {
      const now = Math.floor(Date.now() / 1000);
      const canonicalIds = fixtureACTIVE_STABLECOINS.slice(0, params.canonicalTotal).map((c) => c.id);
      type Asset = {
        id: string;
        symbol: string;
        pegType: string;
        price: number | null;
        circulating: Record<string, number>;
      };
      const assets: Asset[] = [];
      canonicalIds.forEach((id, i) => {
        assets.push({
          id,
          symbol: id.toUpperCase(),
          pegType: "peggedUSD",
          price: i < params.canonicalMissing ? null : 1,
          circulating: { peggedUSD: 10_000_000 },
        });
      });
      for (let i = 0; i < params.residuals; i++) {
        assets.push({
          id: `residual-${i}`, // intentionally not in ACTIVE_IDS
          symbol: `RES${i}`,
          pegType: "peggedUSD",
          price: i < params.residualsMissing ? null : 1,
          circulating: { peggedUSD: 5_000_000 },
        });
      }
      const stablecoinsCache = JSON.stringify({ peggedAssets: assets });
      return fixtureMockD1([
        { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
        { match: "dex_liquidity", rows: [], first: { age: 300 } },
        { match: "yield_data", rows: [], first: { age: 300 } },
        { match: "stress_signals", rows: [], first: { age: 300 } },
        ...(params.publicationCoverage
          ? [{
              match: "job = 'sync-stablecoins' AND metadata IS NOT NULL",
              rows: [],
              first: {
                started_at: now - 30,
                metadata: JSON.stringify({ activePublicationCoverage: params.publicationCoverage }),
              },
            }]
          : []),
        { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
        { match: "cache", rows: [], first: { value: stablecoinsCache, updated_at: now - 60 } },
        { match: "blacklist_events", rows: [], first: { total: 0, missing: 0, missing_recent: 0 } },
        { match: "depeg_events", rows: [], first: { cnt: 0 } },
        { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
        { match: "onchain_supply WHERE updated_at >", rows: [] },
        { match: "FROM discovery_candidates WHERE dismissed = 0", rows: [] },
      ]);
    }

    type CanonicalScopeBody = {
      dataQualityStatus: string;
      dataQuality: {
        totalStablecoins: number;
        missingPrices: number;
        stablecoinPublication?: { status: string; missingActiveIds: string[] };
      };
      causes: { dataQuality: Array<{ code: string }> };
    };

    it("excludes DL residuals from the denominator even when they are all unpriced", async () => {
      const canonicalTotal = fixtureACTIVE_STABLECOINS.length;
      // The exact active universe is fully priced while 100 DL residuals are
      // unpriced. Residual rows must not enter the canonical denominator.
      const db = buildMixedCacheDb({
        canonicalTotal,
        canonicalMissing: 0,
        residuals: 100,
        residualsMissing: 100,
      });
      const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
      const res = await handleStatus(db, true, request);
      const body = (await res.json()) as CanonicalScopeBody;
      expect(body.dataQualityStatus).toBe("healthy");
      expect(body.dataQuality.totalStablecoins).toBe(canonicalTotal);
      expect(body.dataQuality.missingPrices).toBe(0);
      const codes = body.causes.dataQuality.map((c) => c.code);
      expect(codes).not.toContain("missing_prices_degraded");
      expect(codes).not.toContain("missing_prices_stale");
    });

    it("counts canonical missing prices without double-counting residuals", async () => {
      const canonicalTotal = fixtureACTIVE_STABLECOINS.length;
      const canonicalMissing = Math.ceil(canonicalTotal * 0.2);
      // Priced residuals must not dilute a real canonical missing-price issue.
      const db = buildMixedCacheDb({
        canonicalTotal,
        canonicalMissing,
        residuals: 50,
        residualsMissing: 0,
      });
      const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
      const res = await handleStatus(db, true, request);
      const body = (await res.json()) as CanonicalScopeBody;
      expect(body.dataQualityStatus).toBe("degraded");
      expect(body.dataQuality.totalStablecoins).toBe(canonicalTotal);
      expect(body.dataQuality.missingPrices).toBe(canonicalMissing);
      const degradedCause = body.causes.dataQuality.find((c) => c.code === "missing_prices_degraded");
      expect(degradedCause).toBeDefined();
    });

    it("names an absent active ID and degrades the admin data-quality plane", async () => {
      const missingId = fixtureACTIVE_STABLECOINS[fixtureACTIVE_STABLECOINS.length - 1]!.id;
      const expectedActiveCount = fixtureACTIVE_STABLECOINS.length;
      const db = buildMixedCacheDb({
        canonicalTotal: expectedActiveCount - 1,
        canonicalMissing: 0,
        residuals: 0,
        residualsMissing: 0,
        publicationCoverage: {
          complete: false,
          expectedActiveCount,
          presentActiveCount: expectedActiveCount - 1,
          waivedActiveCount: 0,
          missingActiveIds: [missingId],
          waivedActiveIds: [],
          expiredWaiverIds: [],
        },
      });
      const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });

      const res = await handleStatus(db, true, request);
      const body = (await res.json()) as CanonicalScopeBody;

      expect(body.dataQualityStatus).toBe("degraded");
      expect(body.dataQuality.totalStablecoins).toBe(expectedActiveCount);
      expect(body.dataQuality.missingPrices).toBe(1);
      expect(body.dataQuality.stablecoinPublication).toEqual(expect.objectContaining({
        status: "incomplete",
        missingActiveIds: [missingId],
      }));
      expect(body.causes.dataQuality.map((cause) => cause.code)).toContain("stablecoin_publication_incomplete");
    });
  });

  // -------------------------------------------------------------------------
  // 2026-04-13 status-stability hardening: on-chain low-sample suppression.
  // -------------------------------------------------------------------------
  //
  // Suppress the `onchain_monitor_low_sample` info cause when the on-chain
  // monitor is at the structural floor (tracked coins < 3). Currently only
  // sync-kinesis-supply writes to onchain_supply (KAU + KAG = 2 coins), so
  // the 10-coin ratio threshold will never be reached and the info cause
  // fires forever. Emit it only when tracked is in the legitimate
  // partial-coverage band [3, 9].
  describe("onchain_monitor_low_sample structural floor suppression", () => {
    function buildOnchainDb(params: { trackedCoins: number; staleSupply: number }) {
      const now = Math.floor(Date.now() / 1000);
      const stablecoinsCache = JSON.stringify({
        peggedAssets: [
          {
            id: "usdt-tether",
            symbol: "USDT",
            pegType: "peggedUSD",
            price: 1,
            circulating: { peggedUSD: 100_000_000 },
          },
        ],
      });
      return fixtureMockD1([
        { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
        { match: "dex_liquidity", rows: [], first: { age: 300 } },
        { match: "yield_data", rows: [], first: { age: 300 } },
        { match: "stress_signals", rows: [], first: { age: 300 } },
        { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
        { match: "cache", rows: [], first: { value: stablecoinsCache, updated_at: now - 60 } },
        { match: "blacklist_events", rows: [], first: { total: 0, missing: 0, missing_recent: 0 } },
        { match: "depeg_events", rows: [], first: { cnt: 0 } },
        // On-chain monitor query: latest recent + given tracked count to
        // activate the monitor. Without the explicit match the default mock
        // returns null/0 and monitoring becomes "unavailable" instead of
        // "active", which short-circuits the low-sample cause path.
        {
          match: "SELECT MAX(updated_at) as latest",
          rows: [],
          first: { latest: now - 60, tracked: params.trackedCoins },
        },
        // Stale supply count — drives the `staleSupply > 0` condition that is
        // one of the two triggers for the low-sample cause.
        { match: "HAVING latest_update", rows: [], first: { cnt: params.staleSupply } },
        // Divergence query — keep empty so the divergence branch is quiet.
        { match: "SUM(supply) as total_supply", rows: [] },
        { match: "FROM discovery_candidates WHERE dismissed = 0", rows: [] },
      ]);
    }

    type DataQualityBody = {
      dataQualityStatus: string;
      causes: { dataQuality: Array<{ code: string; severity: string }> };
    };

    it("does not emit onchain_monitor_low_sample when tracked coins are below the structural floor", async () => {
      // Tracked = 2 is the current prod state (KAU + KAG from sync-kinesis-supply).
      // staleSupply = 1 ensures the cause-emission trigger would otherwise fire.
      const db = buildOnchainDb({ trackedCoins: 2, staleSupply: 1 });
      const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
      const res = await handleStatus(db, true, request);
      const body = (await res.json()) as DataQualityBody;
      const codes = body.causes.dataQuality.map((c) => c.code);
      expect(codes).not.toContain("onchain_monitor_low_sample");
    });

    it("still emits onchain_monitor_low_sample when tracked coins are in the partial-coverage band [3, 9]", async () => {
      const db = buildOnchainDb({ trackedCoins: 6, staleSupply: 1 });
      const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
      const res = await handleStatus(db, true, request);
      const body = (await res.json()) as DataQualityBody;
      const cause = body.causes.dataQuality.find((c) => c.code === "onchain_monitor_low_sample");
      expect(cause).toBeDefined();
      expect(cause?.severity).toBe("info");
    });
  });

  // -------------------------------------------------------------------------
  // 2026-04-13 status-stability hardening: transition-count observability.
  // -------------------------------------------------------------------------
  //
  // Surface the 24-hour transition count in the status summary so operators
  // can detect new flapping lanes as thresholds drift.
  describe("summary.transitionsLast24h", () => {
    function buildTransitionCountDb(transitionsLast24h: number) {
      const now = Math.floor(Date.now() / 1000);
      const stablecoinsCache = JSON.stringify({
        peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1, circulating: { peggedUSD: 100_000_000 } }],
      });
      return fixtureMockD1([
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
        // The new transitions-count query introduced by Workstream 5.
        { match: "FROM status_transitions WHERE scope", rows: [], first: { cnt: transitionsLast24h } },
      ]);
    }

    type SummaryBody = { summary: { transitionsLast24h: number } };

    it("reports the number of status_transitions rows inserted in the last 24h", async () => {
      const db = buildTransitionCountDb(4);
      const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
      const res = await handleStatus(db, true, request);
      const body = (await res.json()) as SummaryBody;
      expect(body.summary.transitionsLast24h).toBe(4);
    });

    it("reports 0 when the transitions count query returns nothing", async () => {
      const db = buildTransitionCountDb(0);
      const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
      const res = await handleStatus(db, true, request);
      const body = (await res.json()) as SummaryBody;
      expect(body.summary.transitionsLast24h).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Task 2: handleStatus must be read-only w.r.t. status_state. The cron
  // (status-self-check, */15 min) is the sole writer. The API used to call
  // reconcileStatusState whenever staleness.isStale was true, racing with the
  // cron's own reconcile and dropping transitions.
  // -------------------------------------------------------------------------
  describe("handleStatus — read-only w.r.t. status_state", () => {
    function buildBaseStatusTables(now: number, stateRow: Record<string, unknown> | null) {
      const stablecoinsCache = JSON.stringify({
        peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1, circulating: { peggedUSD: 100_000_000 } }],
      });
      return [
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
        { match: "FROM status_state", rows: [], first: stateRow },
      ];
    }

    it("does not write status_state when snapshot is stale", async () => {
      const now = Math.floor(Date.now() / 1000);
      // Snapshot age > STATUS_SYSTEM_FRESHNESS_SEC (1800s) → stale.
      const staleStateRow = {
        scope: "global",
        current_status: "healthy",
        raw_status: "healthy",
        last_evaluated_at: now - 3600,
        last_changed_at: now - 3600,
        consecutive_healthy: 5,
        consecutive_degraded: 0,
        consecutive_stale: 0,
        confidence: 0.9,
        causes_json: "[]",
      };
      const db = fixtureMockD1(buildBaseStatusTables(now, staleStateRow));
      const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
      const res = await handleStatus(db, true, request);
      expect(res.status).toBe(200);

      const writes = db
        .getHistory()
        .filter((entry) =>
          /INSERT INTO status_state|UPDATE status_state|INSERT INTO status_transitions/i.test(entry.sql),
        );
      expect(writes).toEqual([]);

      const body = (await res.json()) as { staleness: { isStale: boolean } };
      expect(body.staleness.isStale).toBe(true);
    });

    it("returns fallback state when snapshot is absent (first boot), without writing", async () => {
      const now = Math.floor(Date.now() / 1000);
      const db = fixtureMockD1(buildBaseStatusTables(now, null));
      const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
      const res = await handleStatus(db, true, request);
      expect(res.status).toBe(200);

      const writes = db
        .getHistory()
        .filter((entry) =>
          /INSERT INTO status_state|UPDATE status_state|INSERT INTO status_transitions/i.test(entry.sql),
        );
      expect(writes).toEqual([]);

      const body = (await res.json()) as {
        state: { currentStatus: string };
        staleness: { isStale: boolean };
      };
      expect(["healthy", "degraded", "stale"]).toContain(body.state.currentStatus);
    });
  });
});
