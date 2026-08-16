import { afterEach, describe, expect, it } from "vitest";
import {
  handleStatus,
  STATUS_RAW_SNAPSHOT_CACHE_KEY,
  makeCacheRow,
  makeCronRow,
  makeRawStatusSnapshotRow,
  cleanupStatusTest,
  fixtureMockD1,
  fixtureMakeApiRequest,
  fixtureMockFetch,
  fixtureCRON_INTERVALS,
} from "./status.test-support";

function statusLoadersD1(tables: Parameters<typeof fixtureMockD1>[0] = []) {
  return fixtureMockD1([
    ...tables,
    { match: "SELECT 1", rows: [], first: { value: 1 } },
    { match: "pharos:status-derived:mint-burn-24h", rows: [] },
    { match: "pharos:status-derived:mint-burn-first-hour-seek", rows: [] },
    { match: "FROM reserve_sync_state", rows: [] },
    { match: "SELECT key, LENGTH(value) as bytes FROM cache", rows: [] },
    { match: "blacklist-gap-metrics-cache-read", rows: [], first: null },
    { match: "blacklist-gap-aggregate", rows: [], first: null },
    { match: "FROM cache WHERE key = ?", rows: [], first: null },
  ]);
}

describe("handleStatus", () => {
  afterEach(cleanupStatusTest);
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
          frozen: true,
          pegType: "peggedUSD",
          pegMechanism: "fiat-backed",
          price: 0.9,
          priceSource: "defillama",
          priceConfidence: "single-source",
          circulating: { peggedUSD: 100_000_000 },
          chainCirculating: {},
          chains: [],
        },
        {
          id: "buck-buck-assets",
          name: "Buck",
          symbol: "BUCK",
          geckoId: "buck-2",
          frozen: true,
          price: 1,
          priceSource: "coinmarketcap",
          priceConfidence: "fallback",
          circulating: { peggedUSD: 4_600 },
          chainCirculating: {},
          chains: [],
        },
      ],
    });

    fixtureMockFetch([
      {
        match: "/simple/price",
        body: {
          tether: { usd: 1, last_updated_at: now - 60 },
          "paypal-usd": { usd: 1, last_updated_at: now - 60 },
          "buck-2": { usd: 0.09 },
        },
      },
    ]);

    const db = statusLoadersD1([
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
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request, coingeckoApiKey: "cg-test-key" });
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
    expect(body.coingeckoPriceDiff?.rows.map((row) => row.stablecoinId)).not.toContain("buck-buck-assets");
  });

  it("only compares CoinGecko quotes with valid current upstream timestamps", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [
        {
          id: "usdt-tether",
          name: "Tether",
          symbol: "USDT",
          geckoId: "tether",
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
          price: 0.9,
          priceSource: "defillama",
          priceConfidence: "single-source",
          circulating: { peggedUSD: 100_000_000 },
          chainCirculating: {},
          chains: [],
        },
        {
          id: "usdc-circle",
          name: "USD Coin",
          symbol: "USDC",
          geckoId: "usd-coin",
          price: 0.9,
          priceSource: "defillama",
          priceConfidence: "single-source",
          circulating: { peggedUSD: 100_000_000 },
          chainCirculating: {},
          chains: [],
        },
        {
          id: "usds-sky",
          name: "USDS",
          symbol: "USDS",
          geckoId: "usds",
          price: 0.9,
          priceSource: "defillama",
          priceConfidence: "single-source",
          circulating: { peggedUSD: 100_000_000 },
          chainCirculating: {},
          chains: [],
        },
      ],
    });

    fixtureMockFetch([
      {
        match: "include_last_updated_at=true",
        body: {
          tether: { usd: 1, last_updated_at: now - 60 },
          "paypal-usd": { usd: 1, last_updated_at: now - 24 * 60 * 60 },
          "usd-coin": { usd: 1 },
          usds: { usd: 1, last_updated_at: now + 11 * 60 },
        },
      },
    ]);

    const db = statusLoadersD1([
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
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request, coingeckoApiKey: "cg-test-key" });
    const body = (await res.json()) as {
      coingeckoPriceDiff: {
        trackedWithGeckoId: number;
        comparedCoins: number;
        mismatchedCount: number;
        rows: Array<{ stablecoinId: string }>;
      } | null;
    };

    expect(res.status).toBe(200);
    expect(body.coingeckoPriceDiff).toMatchObject({
      trackedWithGeckoId: 4,
      comparedCoins: 1,
      mismatchedCount: 0,
      rows: [],
    });
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

    fixtureMockFetch([
      {
        match: "/simple/price",
        body: { error: "cg down" },
        status: 503,
      },
    ]);

    const db = statusLoadersD1([
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
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request, coingeckoApiKey: "cg-test-key" });
    const body = (await res.json()) as {
      coingeckoPriceDiff: unknown;
      sectionErrors: Record<string, { code: string; message: string } | undefined>;
    };

    expect(res.status).toBe(200);
    expect(body.coingeckoPriceDiff).toBeNull();
    expect(body.sectionErrors.coingeckoPriceDiff).toEqual({
      code: "coingecko_price_diff_query_failed",
      message: "CoinGecko price diff unavailable.",
    });
  });

  it("surfaces admin D1 usage metrics when Cloudflare bindings are configured", async () => {
    const now = Math.floor(Date.now() / 1000);

    fixtureMockFetch([
      {
        match: "/d1/database/db-123",
        body: {
          success: true,
          result: {
            uuid: "db-123",
            name: "stablecoin-db",
            file_size: 1_589_248_000,
            num_tables: 56,
            region: "EEUR",
            read_replication: {
              mode: "disabled",
            },
          },
        },
      },
      {
        match: "/graphql",
        body: {
          data: {
            viewer: {
              accounts: [
                {
                  d1AnalyticsAdaptiveGroups: [
                    {
                      sum: {
                        readQueries: 942_012,
                        writeQueries: 709_241,
                        rowsRead: 1_633_139_670,
                        rowsWritten: 1_555_568,
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    ]);

    const db = statusLoadersD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
      { match: "cache", rows: [], first: { value: JSON.stringify({ peggedAssets: [] }), updated_at: now - 60 } },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({
      db,
      trustedAdmin: true,
      request,
      cloudflareD1StatusBindings: {
        CLOUDFLARE_ACCOUNT_ID: "acct-123",
        CLOUDFLARE_D1_STATUS_API_TOKEN: "cf-token",
        CLOUDFLARE_D1_DATABASE_ID: "db-123",
      },
    });
    const body = (await res.json()) as {
      d1Usage: {
        databaseId: string;
        databaseName: string | null;
        databaseSizeBytes: number | null;
        numTables: number | null;
        region: string | null;
        readReplicationMode: string | null;
        readQueries24h: number | null;
        writeQueries24h: number | null;
        rowsRead24h: number | null;
        rowsWritten24h: number | null;
        capacity?: {
          utilizationPercent: number;
          thresholdState: string;
          forecastBasis: string;
        } | null;
      } | null;
    };

    expect(res.status).toBe(200);
    expect(body.d1Usage).toMatchObject({
      databaseId: "db-123",
      databaseName: "stablecoin-db",
      databaseSizeBytes: 1_589_248_000,
      numTables: 56,
      region: "EEUR",
      readReplicationMode: "disabled",
      readQueries24h: 942_012,
      writeQueries24h: 709_241,
      rowsRead24h: 1_633_139_670,
      rowsWritten24h: 1_555_568,
      capacity: {
        utilizationPercent: 15.89,
        thresholdState: "normal",
        forecastBasis: "insufficient-history",
      },
    });
  });

  it("surfaces partial admin D1 status config through sectionErrors", async () => {
    const now = Math.floor(Date.now() / 1000);

    const db = statusLoadersD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
      { match: "cache", rows: [], first: { value: JSON.stringify({ peggedAssets: [] }), updated_at: now - 60 } },
      { match: "blacklist_events", rows: [], first: { total: 0, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({
      db,
      trustedAdmin: true,
      request,
      cloudflareD1StatusBindings: {
        CLOUDFLARE_ACCOUNT_ID: "acct-123",
        CLOUDFLARE_D1_STATUS_API_TOKEN: undefined,
        CLOUDFLARE_D1_DATABASE_ID: "db-123",
      },
    });
    const body = (await res.json()) as {
      d1Usage: unknown;
      sectionErrors: Record<string, { code: string; message: string } | undefined>;
    };

    expect(res.status).toBe(200);
    expect(body.d1Usage).toBeNull();
    expect(body.sectionErrors.d1Usage).toEqual({
      code: "cloudflare_d1_status_config_incomplete",
      message:
        "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_STATUS_API_TOKEN, and CLOUDFLARE_D1_DATABASE_ID must be configured together for admin D1 metrics.",
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

    fixtureMockFetch([
      {
        match: "/simple/price",
        body: {
          tether: { usd: 1, last_updated_at: now - 60 },
          "the-standard-usd": { usd: 0.700692, last_updated_at: now - 60 },
          "paypal-usd": { usd: 1, last_updated_at: now - 60 },
        },
      },
    ]);

    const db = statusLoadersD1([
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
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request, coingeckoApiKey: "cg-test-key" });
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
    const db = statusLoadersD1([
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
              sourceUpdatedAtByPeg: { peggedEUR: now - 8 * 3600 },
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
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });
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
    const db = statusLoadersD1([
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

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      sectionErrors: Record<string, { code: string; message: string } | undefined>;
    };
    expect(body.sectionErrors.statusState?.code).toBe("status_persistence_degraded");
    expect(body.sectionErrors.statusState?.message).toBe("Status persistence degraded.");
  });

  it("uses writer timestamps for event-backed freshness rows", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const blacklistWriterAt = now - 15 * 60;
    const mintBurnWriterAt = now - 8 * 60;
    const depegWriterAt = now - 12 * 60;

    const db = statusLoadersD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
      { match: "dex_liquidity", rows: [], first: { age: 300 } },
      { match: "yield_data", rows: [], first: { age: 300 } },
      { match: "stress_signals", rows: [], first: { age: 300 } },
      {
        match: "UNION ALL",
        rows: [
          makeCronRow("sync-stablecoins", "ok", 12 * 60),
          makeCronRow("sync-blacklist", "ok", 15 * 60),
          makeCronRow("sync-mint-burn", "ok", 8 * 60),
          makeCronRow("sync-mint-burn-extended", "ok", 18 * 60),
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
        match: "cache",
        rows: [],
        first: { value: stablecoinsCache, updated_at: now - 60 },
      },
      { match: "blacklist_events", rows: [], first: { total: 10_000, missing: 0, missing_recent: 0 } },
      { match: "depeg_events", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
      { match: "onchain_supply WHERE updated_at >", rows: [] },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });
    const body = (await res.json()) as {
      datasetFreshness: {
        blacklist: number | null;
        mintBurn: number | null;
        depegs: number | null;
      };
    };

    expect(body.datasetFreshness.blacklist).toBe(blacklistWriterAt);
    expect(body.datasetFreshness.mintBurn).toBe(mintBurnWriterAt);
    expect(body.datasetFreshness.depegs).toBe(depegWriterAt);
  });

  it("keeps status available when the shared stablecoins cache preload throws", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = statusLoadersD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: [STATUS_RAW_SNAPSHOT_CACHE_KEY],
        rows: [makeRawStatusSnapshotRow(now, 60)],
      },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        throwError: new Error("simulated stablecoins cache read failure"),
      },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request, coingeckoApiKey: "coingecko-key" });
    const body = (await res.json()) as {
      sectionErrors: { coingeckoPriceDiff?: { code: string; message: string } };
      coingeckoPriceDiff: unknown;
      mintBurnReconciliation: unknown;
    };

    expect(res.status).toBe(200);
    expect(body.coingeckoPriceDiff).toBeNull();
    expect(body.mintBurnReconciliation).toBeNull();
    expect(body.sectionErrors.coingeckoPriceDiff?.code).toBe("coingecko_price_diff_query_failed");
  });

  it("marks data quality stale when the stablecoins cache is malformed", async () => {
    const db = statusLoadersD1([
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

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });
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

  it("keeps data quality healthy when the blacklist-gap query fails but core data remains usable", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const db = statusLoadersD1([
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

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });
    const body = (await res.json()) as {
      dataQualityStatus: string;
      dataQuality: {
        blacklistGapStatus: string;
        sourceFailures: Array<{ source: string; message: string }>;
      };
      causes: { dataQuality: Array<{ code: string; severity: string }> };
      summary: { diagnosticIssueCount: number };
    };

    expect(body.dataQualityStatus).toBe("healthy");
    expect(body.dataQuality.blacklistGapStatus).toBe("failed");
    expect(body.dataQuality.sourceFailures).toContainEqual({
      source: "blacklist-gaps",
      message: "Blacklist gap metrics unavailable.",
    });
    expect(
      body.causes.dataQuality.some((cause) => cause.code === "blacklist_gap_query_failed" && cause.severity === "info"),
    ).toBe(true);
    expect(body.summary.diagnosticIssueCount).toBeGreaterThanOrEqual(1);
  });

  it("keeps data quality healthy when reserve overview diagnostics fail", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1.0, circulating: { peggedUSD: 100_000_000 } }],
    });
    const cronRows = Object.keys(fixtureCRON_INTERVALS).map((job) => makeCronRow(job, "ok", 30));
    const db = statusLoadersD1([
      { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins")] },
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
      { match: "MAX(updated_at) as latest", rows: [], first: { latest: now - 60, tracked: 12 } },
      { match: "FROM reserve_sync_state", rows: [], throwError: "reserve sync unavailable" },
    ]);

    const request = fixtureMakeApiRequest("/api/status", { adminKey: "secret-key" });
    const res = await handleStatus({ db, trustedAdmin: true, request });
    const body = (await res.json()) as {
      dataQualityStatus: string;
      reserveComposition: { status: string };
      summary: { diagnosticIssueCount: number };
      causes: { dataQuality: Array<{ code: string; severity: string }> };
      sectionErrors: Record<string, unknown>;
    };

    expect(body.dataQualityStatus).toBe("healthy");
    expect(body.reserveComposition.status).toBe("healthy");
    expect(body.summary.diagnosticIssueCount).toBeGreaterThanOrEqual(1);
    expect(
      body.causes.dataQuality.some((cause) => cause.code === "reserve_sync_query_failed" && cause.severity === "info"),
    ).toBe(true);
    expect(body.sectionErrors).toHaveProperty("reserveComposition");
  });
});
