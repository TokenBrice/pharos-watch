import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";

// --- Module-level mocks ---

// Stub the stablecoins list to avoid importing the full registry
vi.mock("../../../../src/lib/stablecoins", () => ({
  TRACKED_STABLECOINS: [
    {
      id: "1",
      name: "Tether",
      symbol: "USDT",
      geckoId: "tether",
      flags: { pegCurrency: "USD", backing: "fiat-backed", yieldBearing: false, navToken: false, governance: "centralized" },
    },
    {
      id: "2",
      name: "USD Coin",
      symbol: "USDC",
      geckoId: "usd-coin",
      flags: { pegCurrency: "USD", backing: "fiat-backed", yieldBearing: false, navToken: false, governance: "centralized" },
    },
  ],
  TRACKED_META_BY_ID: new Map([
    ["1", { geckoId: "tether", cmcSlug: undefined }],
    ["2", { geckoId: "usd-coin", cmcSlug: undefined }],
  ]),
}));

// Stub enrich-prices to avoid complex 4-pass pipeline
vi.mock("../enrich-prices", () => ({
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
  sendAlert: vi.fn(async () => {}),
}));

import { syncStablecoins } from "../sync-stablecoins";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { detectDepegEvents } from "../detect-depegs";
import { confirmPendingDepegs } from "../confirm-pending-depegs";
import { sendAlert } from "../../lib/alerts";
import * as apiUtils from "../../lib/api-utils";

// --- Helpers ---

function makeDlResponse(assetCount: number) {
  const peggedAssets = Array.from({ length: assetCount }, (_, i) => ({
    id: String(i + 1),
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

describe("syncStablecoins", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    // Reset circuit-breaker mocks to factory defaults — vi.restoreAllMocks()
    // does NOT restore vi.fn() factories, only vi.spyOn() spies.
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
    vi.mocked(recordOutcome).mockResolvedValue(undefined);
    vi.mocked(detectDepegEvents).mockResolvedValue(undefined);
    vi.mocked(confirmPendingDepegs).mockResolvedValue(undefined);
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
    // Should have written to cache
    const cacheWrites = prepareSpy.mock.calls.filter(
      (args) => (args[0] as string).includes("INSERT INTO cache")
    );
    expect(cacheWrites.length).toBeGreaterThanOrEqual(1);
  });

  it("validates asset count and skips cache write when too few assets", async () => {
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

    const result = await syncStablecoins(db);

    // Should return empty result (no cache write)
    expect(result.itemCount).toBeUndefined();
  });

  it("falls back to CoinGecko supply when DL returns 500", async () => {
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

    const result = await syncStablecoins(db);

    // With only 2 tracked stablecoins in our mock, CG fallback gets 2 assets,
    // which is below MIN_VALID_ASSET_COUNT (50), so no cache write
    expect(result.itemCount).toBeUndefined();
    // recordOutcome should have been called with failure for DL
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      "defillama-stablecoins",
      false,
    );
  });

  it("skips DL fetch when circuit breaker is open", async () => {
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

    const result = await syncStablecoins(db);

    // CG fallback path — too few assets for cache write with only 2 tracked
    expect(result.itemCount).toBeUndefined();
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
    const prepareSpy = vi.fn();
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      prepareSpy(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

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
    expect(result.metadata).toContain("schema-validation-fallback");
    expect(sendAlert).toHaveBeenCalledWith(
      "Stablecoins schema validation warning",
      expect.stringContaining("forced-test-validation-failure"),
    );
    const cacheWrites = prepareSpy.mock.calls.filter(
      (args) => (args[0] as string).includes("INSERT INTO cache")
    );
    expect(cacheWrites.length).toBeGreaterThanOrEqual(1);
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
});
