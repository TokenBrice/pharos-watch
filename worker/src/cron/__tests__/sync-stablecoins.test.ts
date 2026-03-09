import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";

// --- Module-level mocks ---

// Stub the stablecoins list to avoid importing the full registry
vi.mock("@shared/lib/stablecoins", () => {
  const fallbackTrackedTokens = Array.from({ length: 60 }, (_, i) => ({
    id: `fb-${i}`,
    name: `Fallback Coin ${i}`,
    symbol: `FC${i}`,
    geckoId: `fallback-coin-${i}`,
    detailProvider: "coingecko",
    flags: { pegCurrency: "USD", backing: "fiat-backed", yieldBearing: false, navToken: false, governance: "centralized" },
  }));

  return {
    TRACKED_STABLECOINS: [
    {
      id: "usdt-tether",
      name: "Tether",
      symbol: "USDT",
      geckoId: "tether",
      llamaId: "1",
      detailProvider: "defillama",
      flags: { pegCurrency: "USD", backing: "fiat-backed", yieldBearing: false, navToken: false, governance: "centralized" },
    },
    {
      id: "usdc-circle",
      name: "USD Coin",
      symbol: "USDC",
      geckoId: "usd-coin",
      llamaId: "2",
      detailProvider: "defillama",
      flags: { pegCurrency: "USD", backing: "fiat-backed", yieldBearing: false, navToken: false, governance: "centralized" },
    },
      ...fallbackTrackedTokens,
    ],
    TRACKED_META_BY_ID: new Map([
      ["usdt-tether", { geckoId: "tether", cmcSlug: undefined }],
      ["usdc-circle", { geckoId: "usd-coin", cmcSlug: undefined }],
      ["ggbr-goldfish-gold", {
        geckoId: "goldfish-gold",
        cmcSlug: undefined,
        commodityOunces: 0.001,
        flags: { navToken: false },
      }],
    ]),
  };
});

// Stub enrich-prices to avoid complex 4-pass pipeline
vi.mock("../enrich-prices", () => ({
  buildPriceReasonablenessOptions: vi.fn((input?: { navToken?: unknown; commodityOunces?: unknown }) => ({
    navToken: !!input?.navToken,
    commodityOunces:
      typeof input?.commodityOunces === "number" && Number.isFinite(input.commodityOunces) && input.commodityOunces > 0
        ? input.commodityOunces
        : undefined,
  })),
  enrichMissingPrices: vi.fn(async () => ({
    totalMissing: 0, pass1: 0, pass1b: 0, pass2: 0, pass3: 0, passCmc: 0, pass4: 0, finalMissing: 0,
  })),
  hasMissingPrice: vi.fn((a: { price?: number | null }) => a.price == null || typeof a.price !== "number" || a.price === 0),
  isReasonablePrice: vi.fn(() => true),
  fetchDualPrimaryPrices: vi.fn(async () => ({
    results: new Map(),
    stats: { attempted: 0, high: 0, singleSource: 0, low: 0, divergences: [] },
  })),
}));

// Stub detect-depegs and confirm-pending-depegs
vi.mock("../detect-depegs", () => ({
  detectDepegEvents: vi.fn(async () => {}),
}));

vi.mock("../confirm-pending-depegs", () => ({
  confirmPendingDepegs: vi.fn(async () => {}),
}));

// Stub resolve-market-cap
vi.mock("../../lib/resolve-market-cap", () => ({
  resolveMarketCap: vi.fn((...args: unknown[]) => args[0] ?? 0),
}));

// Stub fetch-retry to delegate to global fetch
vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async (url: string, init?: RequestInit) => fetch(url, init)),
}));

// Stub circuit-breaker
vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcome: vi.fn(async () => {}),
}));

// Stub coingecko helpers
vi.mock("../../lib/coingecko", () => ({
  cgUrl: vi.fn((path: string) => `https://api.coingecko.com${path}`),
  cgHeaders: vi.fn((extra: Record<string, string>) => extra),
}));

// Stub alerts
vi.mock("../../lib/alerts", () => ({
  sendAlert: vi.fn(async () => true),
}));

import { syncStablecoins } from "../sync-stablecoins";
import { enrichMissingPrices, fetchDualPrimaryPrices, isReasonablePrice } from "../enrich-prices";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { detectDepegEvents } from "../detect-depegs";
import { confirmPendingDepegs } from "../confirm-pending-depegs";
import { sendAlert } from "../../lib/alerts";
import * as apiUtils from "../../lib/api-utils";

// --- Helpers ---

function makeDlResponse(assetCount: number) {
  const peggedAssets = Array.from({ length: assetCount }, (_, i) => ({
    "id": String(i + 1),
    name: `Stablecoin ${i + 1}`,
    symbol: `SC${i + 1}`,
    geckoId: null,
    price: 1.0,
    priceSource: "defillama",
    priceConfidence: "high",
    supplySource: "defillama",
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    circulating: { peggedUSD: 1_000_000 },
    circulatingPrevDay: { peggedUSD: 1_000_000 },
    circulatingPrevWeek: { peggedUSD: 1_000_000 },
    circulatingPrevMonth: { peggedUSD: 1_000_000 },
    chainCirculating: {},
    chains: ["Ethereum"],
  }));
  return { peggedAssets };
}

function makeDb() {
  return mockD1([
    { match: "cache", rows: [] },
    { match: "supply_history", rows: [] },
    { match: "price_cache", rows: [] },
    { match: "circuit", rows: [] },
  ]);
}

function trackCacheWrites(db: D1Database): Array<{ key: string; value: string }> {
  const writes: Array<{ key: string; value: string }> = [];
  const origPrepare = db.prepare.bind(db);
  db.prepare = vi.fn((sql: string) => {
    const stmt = origPrepare(sql);
    if (!sql.includes("INSERT INTO cache")) return stmt;
    return {
      ...stmt,
      bind: (...args: unknown[]) => {
        writes.push({
          key: String(args[0] ?? ""),
          value: String(args[1] ?? ""),
        });
        return stmt.bind(...args);
      },
    };
  }) as typeof db.prepare;
  return writes;
}

describe("syncStablecoins", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    // Reset circuit-breaker mocks to factory defaults — vi.restoreAllMocks()
    // does NOT restore vi.fn() factories, only vi.spyOn() spies.
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
    vi.mocked(recordOutcome).mockReset().mockResolvedValue(undefined);
    vi.mocked(enrichMissingPrices).mockReset().mockResolvedValue({
      totalMissing: 0, pass1: 0, pass1b: 0, pass2: 0, pass3: 0, passCmc: 0, pass4: 0, finalMissing: 0,
    });
    vi.mocked(isReasonablePrice).mockReset().mockImplementation(() => true);
    vi.mocked(fetchDualPrimaryPrices).mockReset().mockResolvedValue({
      results: new Map(),
      stats: { attempted: 0, high: 0, singleSource: 0, low: 0, divergences: [] },
    });
    vi.mocked(detectDepegEvents).mockReset().mockResolvedValue(undefined);
    vi.mocked(confirmPendingDepegs).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("caches assets from DefiLlama on successful fetch", async () => {
    const db = makeDb();
    const prepareSpy = vi.fn();
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      prepareSpy(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    const dlData = makeDlResponse(60);

    mockFetch([
      // CoinGecko market data (commodity/fiat tokens — our mock has no commodities, so empty response is fine)
      { match: "api.coingecko.com", body: {} },
      // DefiLlama stablecoins API
      { match: "stablecoins.llama.fi", body: dlData },
      // DL coins API for dual-primary pricing
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.itemCount).toBe(60);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.cacheWriteMode).toBe("main-write");
    expect(metadata.downstreamSafe).toBe(true);
    // Should have written to cache
    const cacheWrites = prepareSpy.mock.calls.filter(
      (args) => (args[0] as string).includes("INSERT INTO cache")
    );
    expect(cacheWrites.length).toBeGreaterThanOrEqual(1);
    expect(shouldAttemptFetch).toHaveBeenCalledWith(db, "defillama-stablecoins");
    expect(fetchDualPrimaryPrices).toHaveBeenCalledWith(expect.any(Array), db, undefined);
    expect(enrichMissingPrices).toHaveBeenCalledWith(expect.any(Array), undefined, db, undefined);
    expect(detectDepegEvents).toHaveBeenCalledWith(db, expect.any(Array), undefined, undefined);
    expect(confirmPendingDepegs).toHaveBeenCalledWith(db, expect.any(Array), undefined, undefined);
    const dualPrimaryAssets = vi.mocked(fetchDualPrimaryPrices).mock.calls[0]?.[0] as Array<{ id: string }>;
    expect(dualPrimaryAssets).toHaveLength(60);
    const enrichmentAssets = vi.mocked(enrichMissingPrices).mock.calls[0]?.[0] as Array<{ id: string }>;
    expect(enrichmentAssets).toHaveLength(60);
  });

  it("fails the run when DL payload is structurally invalid and fallback is insufficient", async () => {
    const db = makeDb();
    const prepareSpy = vi.fn();
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      prepareSpy(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    // Only 10 assets — below MIN_VALID_ASSET_COUNT (50)
    const dlData = makeDlResponse(10);

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    await expect(syncStablecoins(db)).rejects.toThrow(
      "DefiLlama payload was structurally invalid",
    );
  });

  it("fails the run when DL returns 500 and fallback is insufficient", async () => {
    const db = makeDb();

    mockFetch([
      // CG market data — provides supply data for fallback
      {
        match: "api.coingecko.com",
        body: {
          tether: { usd: 1.0, usd_market_cap: 100_000_000_000 },
          "usd-coin": { usd: 0.999, usd_market_cap: 30_000_000_000 },
        },
      },
      // DL stablecoins API returns 500
      { match: "stablecoins.llama.fi", body: { error: "Internal Server Error" }, status: 500 },
    ]);

    await expect(syncStablecoins(db)).rejects.toThrow(
      "DefiLlama stablecoins API failed and CoinGecko fallback was insufficient",
    );
    // recordOutcome should have been called with failure for DL
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      "defillama-stablecoins",
      false,
    );
  });

  it("fails when circuit is open and fallback is insufficient", async () => {
    const db = makeDb();

    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);

    mockFetch([
      // CG market data
      {
        match: "api.coingecko.com",
        body: {
          tether: { usd: 1.0, usd_market_cap: 100_000_000_000 },
          "usd-coin": { usd: 0.999, usd_market_cap: 30_000_000_000 },
        },
      },
    ]);

    await expect(syncStablecoins(db)).rejects.toThrow(
      "DefiLlama stablecoins circuit open and CoinGecko fallback was insufficient",
    );
  });

  it("runs depeg detection after successful DL sync", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    await syncStablecoins(db);

    expect(detectDepegEvents).toHaveBeenCalled();
    expect(confirmPendingDepegs).toHaveBeenCalled();
    const detectArgs = vi.mocked(detectDepegEvents).mock.calls[0];
    expect(detectArgs?.[0]).toBe(db);
    expect((detectArgs?.[1] as unknown[]).length).toBe(60);
    expect(detectArgs?.[2]).toBeUndefined();
    expect(detectArgs?.[3]).toBeUndefined();

    const confirmArgs = vi.mocked(confirmPendingDepegs).mock.calls[0];
    expect(confirmArgs?.[0]).toBe(db);
    expect((confirmArgs?.[1] as unknown[]).length).toBe(60);
    expect(confirmArgs?.[2]).toBeUndefined();
    expect(confirmArgs?.[3]).toBeUndefined();
  });

  it("continues despite depeg detection failure", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);

    vi.mocked(detectDepegEvents).mockRejectedValueOnce(new Error("depeg crash"));

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    // Should still return a valid result
    expect(result.itemCount).toBe(60);
    // Metadata should contain depeg error info
    const metadata = JSON.parse(result.metadata!);
    expect(metadata.depegErrors).toBeDefined();
    expect(metadata.depegErrors.length).toBeGreaterThan(0);
  });

  it("drops malformed assets missing required fields", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(55);
    // Add some malformed assets
    dlData.peggedAssets.push(
      { id: null, name: "bad1", symbol: "BAD1", price: 1, pegType: "peggedUSD", circulating: { peggedUSD: 100 }, chainCirculating: {}, chains: [] } as unknown as (typeof dlData.peggedAssets)[0],
      { id: "999", name: null, symbol: "BAD2", price: 1, pegType: "peggedUSD", circulating: { peggedUSD: 100 }, chainCirculating: {}, chains: [] } as unknown as (typeof dlData.peggedAssets)[0],
    );

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    // 55 valid assets remain, malformed ones dropped
    expect(result.itemCount).toBe(55);
  });

  it("writes guarded fallback payload when final stablecoins payload fails schema validation", async () => {
    const db = makeDb();
    const cacheWrites = trackCacheWrites(db);

    const dlData = makeDlResponse(60);
    vi.spyOn(apiUtils, "validatePayloadWithSchema").mockReturnValueOnce({
      ok: false,
      issues: "forced-test-validation-failure",
    });

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.itemCount).toBe(60);
    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.validationFailures).toBe(1);
    expect(metadata.cacheWriteMode).toBe("blocked-invalid-payload");
    expect(metadata.downstreamSafe).toBe(false);
    expect(sendAlert).toHaveBeenCalledWith(
      "Stablecoins schema validation warning",
      expect.stringContaining("forced-test-validation-failure"),
    );
    const cacheKeys = cacheWrites.map((write) => write.key);
    expect(cacheKeys).toContain("stablecoins:invalid-last");
    expect(cacheKeys).not.toContain("stablecoins");
  });

  it("writes diagnostic cache and returns degraded when fallback payload fails schema validation", async () => {
    const db = makeDb();
    const cacheWrites = trackCacheWrites(db);
    const cgData: Record<string, { usd: number; usd_market_cap: number }> = {};
    for (let i = 0; i < 60; i++) {
      cgData[`fallback-coin-${i}`] = { usd: 1, usd_market_cap: 1_000_000 + i };
    }

    vi.spyOn(apiUtils, "validatePayloadWithSchema").mockReturnValueOnce({
      ok: false,
      issues: "forced-fallback-validation-failure",
    });

    mockFetch([
      { match: "api.coingecko.com", body: cgData },
      { match: "stablecoins.llama.fi", body: { error: "down" }, status: 500 },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.validationFailures).toBe(1);
    expect(metadata.validationContext).toBe("fallback");
    expect(sendAlert).toHaveBeenCalledWith(
      "Stablecoins schema validation warning",
      expect.stringContaining("context=fallback"),
    );
    const cacheKeys = cacheWrites.map((write) => write.key);
    expect(cacheKeys).toContain("stablecoins:invalid-last");
    expect(cacheKeys).not.toContain("stablecoins");
  });

  it("records DL success outcome when fetch succeeds", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    await syncStablecoins(db);

    expect(recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      "defillama-stablecoins",
      true,
    );
  });

  it("normalizes chainCirculating peg bucket objects to numbers", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);
    // Override first asset with nested peg bucket structure
    dlData.peggedAssets[0].chainCirculating = {
      Ethereum: {
        current: { peggedUSD: 50_000_000 },
        circulatingPrevDay: { peggedUSD: 49_000_000 },
        circulatingPrevWeek: { peggedUSD: 48_000_000 },
        circulatingPrevMonth: { peggedUSD: 47_000_000 },
      },
    } as unknown as Record<string, unknown>;

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    // Should succeed without errors — normalization happens internally
    expect(result.itemCount).toBe(60);
  });

  it("normalizes gecko_id aliases and nullable buckets before final schema validation", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);
    const target = dlData.peggedAssets[2] as Record<string, unknown>;
    delete target.geckoId;
    target.gecko_id = "coin-three";
    delete target.priceConfidence;
    target.circulatingPrevDay = null;
    target.circulatingPrevWeek = null;
    target.circulatingPrevMonth = null;

    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.itemCount).toBe(60);
    const finalValidationCall = validateSpy.mock.calls.find(
      (call) => call[2] === "sync-stablecoins:stablecoins"
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<Record<string, unknown>> } | undefined;
    const normalized = payload?.peggedAssets.find((a) => a.id === "ust-terra");
    expect(normalized).toBeDefined();
    expect(normalized?.geckoId).toBe("coin-three");
    expect("gecko_id" in (normalized ?? {})).toBe(false);
    expect(normalized?.priceConfidence).toBe("single-source");
    expect(normalized?.circulatingPrevDay).toEqual({});
    expect(normalized?.circulatingPrevWeek).toEqual({});
    expect(normalized?.circulatingPrevMonth).toEqual({});
  });

  it("flags staleness warning metadata when prices are nearly identical to previous cache", async () => {
    const dlData = makeDlResponse(60);
    const previousPayload = JSON.stringify({
      peggedAssets: dlData.peggedAssets.map((a) => ({ id: a.id, price: a.price })),
    });
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [{ value: previousPayload, updated_at: Math.floor(Date.now() / 1000) - (8 * 3600) }],
        first: { value: previousPayload, updated_at: Math.floor(Date.now() / 1000) - (8 * 3600) },
      },
      { match: "supply_history", rows: [] },
      { match: "price_cache", rows: [] },
      { match: "circuit", rows: [] },
      { match: "cache", rows: [] },
    ]);

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.itemCount).toBe(60);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.stalenessWarning).toBe(true);
  });

  it("fills missing circulatingPrev buckets from supply_history snapshots", async () => {
    const dlData = makeDlResponse(60);
    const target = dlData.peggedAssets[0] as unknown as Record<string, unknown>;
    target.circulatingPrevDay = null;
    target.circulatingPrevWeek = null;
    target.circulatingPrevMonth = null;
    target.circulating = { peggedUSD: 1_000_000 };

    const now = new Date();
    const utcMidnight = (daysAgo: number) => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - daysAgo);
      return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
    };
    const db = mockD1([
      {
        match: "supply_history",
        rows: [
          { stablecoin_id: "usdt-tether", snapshot_date: utcMidnight(1), circulating_usd: 900_000 },
          { stablecoin_id: "usdt-tether", snapshot_date: utcMidnight(7), circulating_usd: 890_000 },
          { stablecoin_id: "usdt-tether", snapshot_date: utcMidnight(30), circulating_usd: 880_000 },
        ],
      },
      { match: "cache", rows: [] },
      { match: "price_cache", rows: [] },
      { match: "circuit", rows: [] },
    ]);

    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.itemCount).toBe(60);
    const finalValidationCall = validateSpy.mock.calls.find(
      (call) => call[2] === "sync-stablecoins:stablecoins"
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<Record<string, unknown>> } | undefined;
    const normalized = payload?.peggedAssets.find((a) => a.id === "usdt-tether");
    expect(normalized?.circulatingPrevDay).toEqual({ peggedUSD: 900_000 });
    expect(normalized?.circulatingPrevWeek).toEqual({ peggedUSD: 890_000 });
    expect(normalized?.circulatingPrevMonth).toEqual({ peggedUSD: 880_000 });
  });

  it("applies recent price_cache fallback when asset price remains missing", async () => {
    const dlData = makeDlResponse(60);
    dlData.peggedAssets[0].price = 0;
    (dlData.peggedAssets[0] as unknown as Record<string, unknown>).priceConfidence = null;

    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT asset_id, price, updated_at FROM price_cache",
        rows: [{ asset_id: "usdt-tether", price: 0.999, updated_at: nowSec - 60 }],
      },
      { match: "cache", rows: [] },
      { match: "supply_history", rows: [] },
      { match: "circuit", rows: [] },
      { match: "price_cache", rows: [] },
    ]);

    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.itemCount).toBe(60);
    const finalValidationCall = validateSpy.mock.calls.find(
      (call) => call[2] === "sync-stablecoins:stablecoins"
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<Record<string, unknown>> } | undefined;
    const normalized = payload?.peggedAssets.find((a) => a.id === "usdt-tether");
    expect(normalized?.price).toBe(0.999);
  });

  it("passes commodityOunces into price sanity checks for fractional gold tokens", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);
    const target = dlData.peggedAssets[0] as Record<string, unknown>;
    target.id = "ggbr-goldfish-gold";
    target.name = "Goldfish Gold";
    target.symbol = "GGBR";
    target.geckoId = "goldfish-gold";
    target.price = 5.15;
    target.pegType = "peggedGOLD";
    target.circulating = { peggedGOLD: 26_000_000 };

    vi.mocked(isReasonablePrice).mockImplementation((_price, _pegType, _fxRates, opts) => opts?.commodityOunces === 0.001);

    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.itemCount).toBe(60);
    expect(vi.mocked(isReasonablePrice)).toHaveBeenCalledWith(
      5.15,
      "peggedGOLD",
      undefined,
      expect.objectContaining({ commodityOunces: 0.001 }),
    );
    const finalValidationCall = validateSpy.mock.calls.find(
      (call) => call[2] === "sync-stablecoins:stablecoins"
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<Record<string, unknown>> } | undefined;
    const normalized = payload?.peggedAssets.find((a) => a.id === "ggbr-goldfish-gold");
    expect(normalized?.price).toBe(5.15);
  });

  it("handles duplicate DefiLlama coin IDs without crashing", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);
    dlData.peggedAssets[1].id = "1"; // duplicate DefiLlama ID, maps to usdt-tether

    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.itemCount).toBe(60);
    const finalValidationCall = validateSpy.mock.calls.find(
      (call) => call[2] === "sync-stablecoins:stablecoins"
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<{ id: string }> } | undefined;
    expect(payload).toBeDefined();
    const usdtCopies = payload?.peggedAssets.filter((asset) => asset.id === "usdt-tether").length ?? 0;
    expect(usdtCopies).toBeGreaterThanOrEqual(2);
    expect(detectDepegEvents).toHaveBeenCalledWith(db, expect.any(Array), undefined, undefined);
  });
});
