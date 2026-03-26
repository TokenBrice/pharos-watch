import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

const fetchWithRetryMock = vi.fn();

interface MockRoute {
  match: string;
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
}

function mockFetch(routes: MockRoute[] = []): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (url: string) => {
    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) {
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }
    const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return new Response(body, {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json", ...route.headers },
    });
  });
  fetchWithRetryMock.mockImplementation((url: string) => spy(url));
  return spy;
}

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

  const stablecoins = [
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
    {
      id: "dgld-gold-token-sa",
      name: "DGLD Tokenized Gold",
      symbol: "DGLD",
      geckoId: "gold-token-sa-dgld-tokenized-gold",
      detailProvider: "commodity",
      commodityOunces: 1,
      flags: { pegCurrency: "GOLD", backing: "rwa-backed", yieldBearing: false, navToken: false, governance: "centralized" },
    },
    {
      id: "pgold-pleasing",
      name: "Pleasing Gold",
      symbol: "PGOLD",
      geckoId: "pleasing-gold",
      protocolSlug: "pleasing-gold",
      detailProvider: "commodity",
      commodityOunces: 1,
      flags: { pegCurrency: "GOLD", backing: "rwa-backed", yieldBearing: false, navToken: false, governance: "centralized" },
    },
      ...fallbackTrackedTokens,
    ];
    return {
    TRACKED_STABLECOINS: stablecoins,
    ACTIVE_STABLECOINS: stablecoins,
    TRACKED_META_BY_ID: new Map([
      ["usdt-tether", { geckoId: "tether", cmcSlug: undefined }],
      ["usdc-circle", { geckoId: "usd-coin", cmcSlug: undefined }],
      ["dgld-gold-token-sa", {
        geckoId: "gold-token-sa-dgld-tokenized-gold",
        cmcSlug: undefined,
        commodityOunces: 1,
        flags: { navToken: false },
      }],
      ["pgold-pleasing", {
        geckoId: "pleasing-gold",
        cmcSlug: undefined,
        commodityOunces: 1,
        flags: { navToken: false },
      }],
      ["ggbr-goldfish-gold", {
        geckoId: "goldfish-gold",
        cmcSlug: undefined,
        commodityOunces: 0.001,
        flags: { navToken: false },
      }],
    ]),
  };
});

// Stub enrich-prices to avoid complex 5-pass pipeline
vi.mock("../enrich-prices", () => ({
  enrichMissingPrices: vi.fn(async () => ({
    totalMissing: 0, pass1: 0, pass1b: 0, passCmc: 0, passJupiter: 0, passDex: 0, finalMissing: 0, failedPasses: [],
  })),
  hasMissingPrice: vi.fn((a: { price?: number | null }) => a.price == null || typeof a.price !== "number" || a.price === 0),
  fetchPrimaryPrices: vi.fn(async () => ({
    results: new Map(),
    stats: { attempted: 0, high: 0, singleSource: 0, cgOnly: 0, low: 0 },
    cgPrices: new Map(),
  })),
  runGtProbePass: vi.fn(async () => ({
    updatedCount: 0,
    stats: {
      probed: 0,
      pricesObtained: 0,
      divergences500bps: 0,
      skippedLowTvl: 0,
      lookupMisses: 0,
      upstreamErrors: 0,
      publicFallbacks: 0,
      transports: {
        coingeckoOnchain: { attempted: 0, priced: 0, lookupMisses: 0, upstreamErrors: 0 },
        geckoTerminalPublic: { attempted: 0, priced: 0, lookupMisses: 0, upstreamErrors: 0 },
      },
    },
  })),
}));

// Stub detect-depegs and confirm-pending-depegs
vi.mock("../detect-depegs", () => ({
  detectDepegEvents: vi.fn(async () => {}),
}));

vi.mock("../confirm-pending-depegs", () => ({
  confirmPendingDepegs: vi.fn(async () => {}),
}));

vi.mock("../../lib/authoritative-price-sources", () => ({
  fetchAuthoritativeLivePriceOverrides: vi.fn(async () => new Map()),
}));

// Stub resolve-market-cap
vi.mock("../../lib/resolve-market-cap", () => ({
  resolveMarketCap: vi.fn((...args: unknown[]) => args[0] ?? 0),
}));

// Stub fetch-retry to delegate to global fetch
vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
}));

// Stub circuit-breaker
vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcome: vi.fn(async () => {}),
  recordOutcomeSafe: vi.fn(async () => {}),
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
import { stampPriceMetadata } from "../sync-stablecoins/shared";
import { enrichMissingPrices, fetchPrimaryPrices, runGtProbePass, type PrimaryPriceResult } from "../enrich-prices";
import type { PeggedAsset } from "../enrich-prices";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { detectDepegEvents } from "../detect-depegs";
import { confirmPendingDepegs } from "../confirm-pending-depegs";
import { fetchAuthoritativeLivePriceOverrides } from "../../lib/authoritative-price-sources";
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
    fetchWithRetryMock.mockReset();
    vi.mocked(enrichMissingPrices).mockReset().mockResolvedValue({
      totalMissing: 0, pass1: 0, pass1b: 0, passCmc: 0, passJupiter: 0, passDex: 0, finalMissing: 0, failedPasses: [],
    });
    vi.mocked(fetchPrimaryPrices).mockReset().mockResolvedValue({
      results: new Map(),
      stats: { attempted: 0, high: 0, singleSource: 0, cgOnly: 0, low: 0 },
      cgPrices: new Map(),
    });
    vi.mocked(fetchAuthoritativeLivePriceOverrides).mockReset().mockResolvedValue(new Map());
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
      // DL coins API for primary pricing
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
    expect(fetchPrimaryPrices).toHaveBeenCalledWith(expect.any(Array), db, undefined, undefined, undefined, undefined, expect.any(Map));
    expect(enrichMissingPrices).toHaveBeenCalledWith(expect.any(Array), undefined, db, undefined);
    expect(detectDepegEvents).toHaveBeenCalledWith(db, expect.any(Array), undefined, undefined);
    expect(confirmPendingDepegs).toHaveBeenCalledWith(db, expect.any(Array), undefined, undefined, undefined);
    const primaryPriceAssets = vi.mocked(fetchPrimaryPrices).mock.calls[0]?.[0] as Array<{ id: string }>;
    expect(primaryPriceAssets).toHaveLength(60);
    const enrichmentAssets = vi.mocked(enrichMissingPrices).mock.calls[0]?.[0] as Array<{ id: string }>;
    expect(enrichmentAssets).toHaveLength(60);
  });

  it("runs missing-price enrichment before the GT probe", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);
    const order: string[] = [];

    vi.mocked(enrichMissingPrices).mockImplementationOnce(async () => {
      order.push("enrich");
      return {
        totalMissing: 0, pass1: 0, pass1b: 0, passCmc: 0, passJupiter: 0, passDex: 0, finalMissing: 0, failedPasses: [],
      };
    });
    vi.mocked(runGtProbePass).mockImplementationOnce(async () => {
      order.push("gt");
      return {
        updatedCount: 0,
        stats: {
          probed: 0,
          pricesObtained: 0,
          divergences500bps: 0,
          skippedLowTvl: 0,
          lookupMisses: 0,
          upstreamErrors: 0,
          publicFallbacks: 0,
          budgetExhausted: false,
          budgetSkipped: 0,
          transports: {
            coingeckoOnchain: { attempted: 0, priced: 0, lookupMisses: 0, upstreamErrors: 0 },
            geckoTerminalPublic: { attempted: 0, priced: 0, lookupMisses: 0, upstreamErrors: 0 },
          },
        },
      };
    });

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    await syncStablecoins(db);

    expect(order).toEqual(["enrich", "gt"]);
  });

  it("persists GT probe stats into sync metadata", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);

    vi.mocked(runGtProbePass).mockResolvedValueOnce({
      updatedCount: 1,
      stats: {
        probed: 2,
        pricesObtained: 1,
        divergences500bps: 1,
        skippedLowTvl: 0,
        lookupMisses: 0,
        upstreamErrors: 0,
        publicFallbacks: 1,
        budgetExhausted: false,
        budgetSkipped: 0,
        transports: {
          coingeckoOnchain: { attempted: 1, priced: 0, lookupMisses: 1, upstreamErrors: 0 },
          geckoTerminalPublic: { attempted: 1, priced: 1, lookupMisses: 0, upstreamErrors: 0 },
        },
      },
    });

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    const gtProbe = metadata.gtProbe as Record<string, unknown>;
    const transports = gtProbe.transports as Record<string, unknown>;

    expect(gtProbe.updatedCount).toBe(1);
    expect(gtProbe.publicFallbacks).toBe(1);
    expect((transports.coingeckoOnchain as Record<string, unknown>).lookupMisses).toBe(1);
    expect((transports.geckoTerminalPublic as Record<string, unknown>).priced).toBe(1);
  });

  it("keeps default GT probe metadata when the non-fatal GT pass throws", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(runGtProbePass).mockRejectedValueOnce(new Error("gt transient failure"));

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    const gtProbe = metadata.gtProbe as Record<string, unknown>;

    expect(result.status).toBe("ok");
    expect(gtProbe.updatedCount).toBe(0);
    expect(gtProbe.upstreamErrors).toBe(0);
    expect(gtProbe.publicFallbacks).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      "[sync-stablecoins] GT probe failed (non-fatal):",
      expect.any(Error),
    );
  });

  it("applies protocol-backed price overrides before caching", async () => {
    const db = makeDb();
    const writes = trackCacheWrites(db);
    const dlData = makeDlResponse(60);
    dlData.peggedAssets[0] = {
      ...dlData.peggedAssets[0],
      id: "cusd-cap",
      name: "Cap cUSD",
      symbol: "CUSD",
      price: 0.9866,
      priceSource: "defillama",
      priceConfidence: "single-source",
      circulating: { peggedUSD: 114_000_000 },
    };

    vi.mocked(fetchAuthoritativeLivePriceOverrides).mockResolvedValue(new Map([
      [
        "cusd-cap",
        { price: 0.99999266, source: "protocol-redeem", confidence: "high" },
      ],
    ]));

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("ok");
    const stablecoinsWrite = writes.find((entry) => entry.key === "stablecoins");
    expect(stablecoinsWrite).toBeDefined();

    const cached = JSON.parse(stablecoinsWrite!.value) as {
      peggedAssets: Array<{
        id: string;
        price: number;
        priceSource: string;
        priceConfidence: string | null;
      }>;
    };
    const cusd = cached.peggedAssets.find((asset) => asset.id === "cusd-cap");
    expect(cusd).toMatchObject({
      id: "cusd-cap",
      priceSource: "protocol-redeem",
      priceConfidence: "high",
    });
    expect(cusd?.price).toBeCloseTo(0.99999266, 8);
  });

  it("keeps protocol-backed overrides as the final price even when the GT probe finds a later market quote", async () => {
    const db = makeDb();
    const writes = trackCacheWrites(db);
    const dlData = makeDlResponse(60);
    dlData.peggedAssets[0] = {
      ...dlData.peggedAssets[0],
      id: "cusd-cap",
      name: "Cap cUSD",
      symbol: "CUSD",
      price: 0.9866,
      priceSource: "defillama",
      priceConfidence: "single-source",
      circulating: { peggedUSD: 114_000_000 },
    };

    vi.mocked(fetchAuthoritativeLivePriceOverrides).mockResolvedValue(new Map([
      [
        "cusd-cap",
        { price: 0.99999266, source: "protocol-redeem", confidence: "high" },
      ],
    ]));

    vi.mocked(runGtProbePass).mockImplementationOnce(async (
      _assets,
      primaryPriceResults: Map<string, PrimaryPriceResult>,
    ) => {
      primaryPriceResults.set("cusd-cap", {
        price: 0.991,
        source: "geckoterminal",
        confidence: "high",
        dlPrice: null,
        cgPrice: null,
        candidateSources: ["geckoterminal"],
        agreeSources: ["geckoterminal"],
      });
      return {
        updatedCount: 1,
        stats: {
          probed: 1,
          pricesObtained: 1,
          divergences500bps: 0,
          skippedLowTvl: 0,
          lookupMisses: 0,
          upstreamErrors: 0,
          publicFallbacks: 0,
          budgetExhausted: false,
          budgetSkipped: 0,
          transports: {
            coingeckoOnchain: { attempted: 0, priced: 0, lookupMisses: 0, upstreamErrors: 0 },
            geckoTerminalPublic: { attempted: 1, priced: 1, lookupMisses: 0, upstreamErrors: 0 },
          },
        },
      };
    });

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("ok");
    const stablecoinsWrite = writes.find((entry) => entry.key === "stablecoins");
    expect(stablecoinsWrite).toBeDefined();

    const cached = JSON.parse(stablecoinsWrite!.value) as {
      peggedAssets: Array<{
        id: string;
        price: number;
        priceSource: string;
        priceConfidence: string | null;
      }>;
    };
    const cusd = cached.peggedAssets.find((asset) => asset.id === "cusd-cap");
    expect(cusd).toMatchObject({
      id: "cusd-cap",
      priceSource: "protocol-redeem",
      priceConfidence: "high",
    });
    expect(cusd?.price).toBeCloseTo(0.99999266, 8);
  });

  it("rejects severe downside single-source primary prices without replacing a sane DL list price", async () => {
    const db = makeDb();
    const writes = trackCacheWrites(db);
    const dlData = makeDlResponse(60);
    dlData.peggedAssets[0] = {
      ...dlData.peggedAssets[0],
      id: "usdt-tether",
      name: "Tether",
      symbol: "USDT",
      price: 1.0,
      priceSource: "defillama",
      priceConfidence: "single-source",
      circulating: { peggedUSD: 100_000_000 },
    } as unknown as (typeof dlData.peggedAssets)[0];

    vi.mocked(fetchPrimaryPrices).mockResolvedValueOnce({
      results: new Map([
        [
          "usdt-tether",
          {
            price: 0.15,
            source: "coingecko",
            confidence: "single-source",
            dlPrice: 1.0,
            cgPrice: 0.15,
            candidateSources: ["coingecko"],
            agreeSources: ["coingecko"],
          },
        ],
      ]),
      stats: { attempted: 1, high: 0, singleSource: 1, cgOnly: 1, low: 0 },
      cgPrices: new Map([["tether", 0.15]]),
    });

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("ok");
    const stablecoinsWrite = writes.find((entry) => entry.key === "stablecoins");
    const cached = JSON.parse(stablecoinsWrite!.value) as {
      peggedAssets: Array<{
        id: string;
        price: number | null;
        priceSource: string;
        priceConfidence: string | null;
      }>;
    };
    const usdt = cached.peggedAssets.find((asset) => asset.id === "usdt-tether");
    expect(usdt).toMatchObject({
      id: "usdt-tether",
      price: 1.0,
      priceSource: "defillama",
      priceConfidence: "single-source",
    });
  });

  it("quarantines weak large temporal jumps against the previous trusted price", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const previousStablecoinsPayload = {
      peggedAssets: [
        {
          id: "usdt-tether",
          name: "Tether",
          symbol: "USDT",
          geckoId: "tether",
          pegType: "peggedUSD",
          pegMechanism: "fiat-backed",
          price: 0.5,
          priceSource: "pyth",
          priceConfidence: "single-source",
          priceUpdatedAt: nowSec - 120,
          priceObservedAt: nowSec - 120,
          priceSyncedAt: nowSec - 90,
          consensusSources: ["pyth"],
          agreeSources: ["pyth"],
          supplySource: "defillama",
          circulating: { peggedUSD: 100_000_000 },
          circulatingPrevDay: {},
          circulatingPrevWeek: {},
          circulatingPrevMonth: {},
          chainCirculating: {},
          chains: ["Ethereum"],
        },
      ],
    };

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: { value: JSON.stringify(previousStablecoinsPayload), updated_at: nowSec - 90 },
      },
      { match: "cache", rows: [] },
      { match: "supply_history", rows: [] },
      { match: "price_cache", rows: [] },
      { match: "circuit", rows: [] },
    ]);
    const writes = trackCacheWrites(db);

    const dlData = makeDlResponse(60);
    dlData.peggedAssets[0] = {
      ...dlData.peggedAssets[0],
      id: "usdt-tether",
      name: "Tether",
      symbol: "USDT",
      geckoId: "tether",
      price: 0.5,
      priceSource: "defillama",
      priceConfidence: "single-source",
      circulating: { peggedUSD: 100_000_000 },
    } as unknown as (typeof dlData.peggedAssets)[0];

    vi.mocked(fetchPrimaryPrices).mockResolvedValueOnce({
      results: new Map([
        [
          "usdt-tether",
          {
            price: 1.05,
            source: "coingecko",
            confidence: "single-source",
            dlPrice: 0.5,
            cgPrice: 1.05,
            candidateSources: ["coingecko"],
            agreeSources: ["coingecko"],
          },
        ],
      ]),
      stats: { attempted: 1, high: 0, singleSource: 1, cgOnly: 1, low: 0 },
      cgPrices: new Map([["tether", 1.05]]),
    });

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("ok");
    const stablecoinsWrite = writes.find((entry) => entry.key === "stablecoins");
    const cached = JSON.parse(stablecoinsWrite!.value) as {
      peggedAssets: Array<{
        id: string;
        price: number | null;
        priceSource: string;
        priceConfidence: string | null;
      }>;
    };
    const usdt = cached.peggedAssets.find((asset) => asset.id === "usdt-tether");
    expect(usdt).toMatchObject({
      id: "usdt-tether",
      price: 0.5,
      priceSource: "defillama",
      priceConfidence: "single-source",
    });
  });

  it("rehydrates a replay-safe cached price when a same-run rejection leaves the asset missing", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT asset_id, price, updated_at FROM price_cache",
        rows: [
          {
            asset_id: "usdt-tether",
            price: 0.25580214,
            updated_at: nowSec - 3600,
          },
        ],
      },
      {
        match: "SELECT asset_id, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json FROM price_cache",
        rows: [
          {
            asset_id: "usdt-tether",
            source: "defillama-list+pyth",
            confidence: "high",
            observed_at: nowSec - 3600,
            synced_at: nowSec - 3615,
            agree_sources_json: JSON.stringify(["defillama-list", "pyth"]),
            consensus_sources_json: JSON.stringify(["coingecko", "defillama-list", "pyth"]),
          },
        ],
      },
      { match: "cache", rows: [] },
      { match: "supply_history", rows: [] },
      { match: "circuit", rows: [] },
    ]);
    const writes = trackCacheWrites(db);

    const dlData = makeDlResponse(60);
    dlData.peggedAssets[0] = {
      ...dlData.peggedAssets[0],
      id: "usdt-tether",
      name: "Tether",
      symbol: "USDT",
      geckoId: "tether",
      price: 0.24,
      priceSource: "defillama",
      priceConfidence: "single-source",
      circulating: { peggedUSD: 100_000_000 },
    } as unknown as (typeof dlData.peggedAssets)[0];

    vi.mocked(enrichMissingPrices).mockImplementationOnce(async (assets) => {
      const target = assets.find((asset) => asset.id === "usdt-tether");
      if (target) {
        target.price = 0.24;
        target.priceSource = "coinmarketcap";
        target.priceConfidence = "fallback";
        target.priceUpdatedAt = nowSec;
        target.priceObservedAt = nowSec;
        target.priceSyncedAt = nowSec;
        target.consensusSources = ["coinmarketcap"];
        target.agreeSources = ["coinmarketcap"];
      }

      return {
        totalMissing: 1,
        pass1: 0,
        pass1b: 0,
        passCmc: 1,
        passJupiter: 0,
        passDex: 0,
        finalMissing: 0,
        failedPasses: [],
      };
    });

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("ok");
    const stablecoinsWrite = writes.find((entry) => entry.key === "stablecoins");
    const cached = JSON.parse(stablecoinsWrite!.value) as {
      peggedAssets: Array<{
        id: string;
        price: number | null;
        priceSource?: string;
        priceConfidence: string | null;
        priceObservedAt: number | null;
        priceSyncedAt: number | null;
      }>;
    };
    const usdt = cached.peggedAssets.find((asset) => asset.id === "usdt-tether");
    expect(usdt).toMatchObject({
      id: "usdt-tether",
      priceSource: "cached",
      priceConfidence: "fallback",
      priceObservedAt: nowSec - 3600,
      priceSyncedAt: nowSec - 3615,
    });
    expect(usdt?.price).toBeCloseTo(0.25580214, 8);
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
      null,
      "Stablecoins schema validation warning",
      expect.stringContaining("forced-test-validation-failure"),
    );
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      "defillama-stablecoins",
      true,
    );
    const cacheKeys = cacheWrites.map((write) => write.key);
    expect(cacheKeys).toContain("stablecoins:invalid-last");
    expect(cacheKeys).not.toContain("stablecoins");
  });

  it("serializes missing-price assets with a sentinel price source so cache writes stay valid", async () => {
    const db = makeDb();
    const cacheWrites = trackCacheWrites(db);
    const dlData = makeDlResponse(60);

    const missingPriceAsset = dlData.peggedAssets[12] as unknown as PeggedAsset;
    missingPriceAsset.price = null;
    missingPriceAsset.priceSource = undefined;
    missingPriceAsset.priceConfidence = null;

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("ok");
    const stablecoinsWrite = cacheWrites.find((entry) => entry.key === "stablecoins");
    expect(stablecoinsWrite).toBeDefined();

    const cached = JSON.parse(stablecoinsWrite!.value) as {
      peggedAssets: Array<{ id: string; price: number | null; priceSource: string }>;
    };
    expect(cached.peggedAssets[12]).toMatchObject({
      id: "13",
      price: null,
      priceSource: "missing",
    });
  });

  it("emits stage progress updates during the main sync path", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);
    const reportProgress = vi.fn(async () => undefined);

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    await syncStablecoins(db, undefined, undefined, null, null, undefined, reportProgress);

    const stages = reportProgress.mock.calls.map((call) => {
      const [update] = call as unknown as Array<{ stage?: string } | undefined>;
      return update?.stage;
    });
    expect(stages).toContain("intake");
    expect(stages).toContain("price-enrichment");
    expect(stages).toContain("price-validation");
    expect(stages).toContain("cache-validation");
    expect(stages).toContain("cache-write");
    expect(stages).toContain("depeg-pipeline");
    expect(stages).toContain("complete");
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
      null,
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
    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.stalenessWarning).toBe(true);
    expect(metadata.staleWriteBlocked).toBe(true);
  });

  it("preserves the stablecoins cache when severe price staleness is detected", async () => {
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
    const cacheWrites = trackCacheWrites(db);

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("degraded");
    expect(cacheWrites.map((write) => write.key)).not.toContain("stablecoins");
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
    expect(normalized?.priceSource).toBe("cached");
    expect(normalized?.priceConfidence).toBe("fallback");
    expect(normalized?.priceUpdatedAt).toBe(nowSec - 60);
    expect(normalized?.priceObservedAt).toBe(nowSec - 60);
    expect(normalized?.priceSyncedAt).toBe(nowSec - 60);
  });

  it("keeps severe downside replay continuity from price_cache when the previous stablecoins snapshot is no longer authoritative", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const previousStablecoinsPayload = {
      peggedAssets: [
        {
          id: "usdt-tether",
          name: "Tether",
          symbol: "USDT",
          geckoId: "tether",
          pegType: "peggedUSD",
          pegMechanism: "fiat-backed",
          price: 0.3,
          priceSource: "pyth",
          priceConfidence: "low",
          priceUpdatedAt: nowSec - 240,
          priceObservedAt: nowSec - 240,
          priceSyncedAt: nowSec - 240,
          circulating: { peggedUSD: 100_000_000 },
          circulatingPrevDay: {},
          circulatingPrevWeek: {},
          circulatingPrevMonth: {},
          chainCirculating: {},
          chains: ["Ethereum"],
        },
      ],
    };

    const dlData = makeDlResponse(60);
    dlData.peggedAssets[0] = {
      ...dlData.peggedAssets[0],
      id: "usdt-tether",
      name: "Tether",
      symbol: "USDT",
      geckoId: "tether",
      price: 0,
      priceSource: "defillama",
      priceConfidence: null,
      circulating: { peggedUSD: 100_000_000 },
    } as unknown as (typeof dlData.peggedAssets)[0];

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: { value: JSON.stringify(previousStablecoinsPayload), updated_at: nowSec - 240 },
      },
      {
        match: "SELECT asset_id, price, updated_at FROM price_cache",
        rows: [{ asset_id: "usdt-tether", price: 0.3, updated_at: nowSec - 120 }],
      },
      {
        match: "SELECT asset_id, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json FROM price_cache",
        rows: [{
          asset_id: "usdt-tether",
          source: "coingecko+pyth",
          confidence: "high",
          observed_at: nowSec - 120,
          synced_at: nowSec - 120,
          agree_sources_json: "[\"coingecko\",\"pyth\"]",
          consensus_sources_json: "[\"coingecko\",\"pyth\"]",
        }],
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
      (call) => call[2] === "sync-stablecoins:stablecoins",
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<Record<string, unknown>> } | undefined;
    const normalized = payload?.peggedAssets.find((a) => a.id === "usdt-tether");
    expect(normalized?.price).toBe(0.3);
    expect(normalized?.priceSource).toBe("cached");
    expect(normalized?.priceConfidence).toBe("fallback");
    expect(normalized?.priceUpdatedAt).toBe(nowSec - 120);
    expect(normalized?.priceObservedAt).toBe(nowSec - 120);
    expect(normalized?.priceSyncedAt).toBe(nowSec - 120);
  });

  it("does not replay price_cache entries older than the 6-hour replay TTL", async () => {
    const dlData = makeDlResponse(60);
    dlData.peggedAssets[0] = {
      ...dlData.peggedAssets[0],
      id: "usdt-tether",
      name: "Tether",
      symbol: "USDT",
      geckoId: "tether",
      price: 0,
      priceConfidence: null,
      circulating: { peggedUSD: 100_000_000 },
    } as unknown as (typeof dlData.peggedAssets)[0];

    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT asset_id, price, updated_at FROM price_cache",
        rows: [{ asset_id: "usdt-tether", price: 0.999, updated_at: nowSec - (7 * 3600) }],
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
      (call) => call[2] === "sync-stablecoins:stablecoins",
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<Record<string, unknown>> } | undefined;
    const normalized = payload?.peggedAssets.find((a) => a.id === "usdt-tether");
    expect(normalized?.priceSource).not.toBe("cached");
    expect(normalized?.price).not.toBe(0.999);
  });

  it("allows deep downside prices in sync-time primary validation when FX cache is stale", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedJPY: 0.0067 }),
          updated_at: nowSec - (8 * 3600),
        },
      },
      { match: "supply_history", rows: [] },
      { match: "price_cache", rows: [] },
      { match: "circuit", rows: [] },
      { match: "cache", rows: [] },
    ]);

    const dlData = makeDlResponse(60);
    const target = dlData.peggedAssets[0] as Record<string, unknown>;
    target.id = "jpyc-jpyc";
    target.name = "JPYC";
    target.symbol = "JPYC";
    target.price = 0.0005;
    target.pegType = "peggedJPY";

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
    const normalized = payload?.peggedAssets.find((a) => a.id === "jpyc-jpyc");
    expect(normalized?.price).toBe(0.0005);
  });

  it("adds tracked gold supplemental assets when DefiLlama price data is empty but CoinGecko still has price and market cap", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);
    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");

    mockFetch([
      {
        match: "api.coingecko.com",
        body: {
          "gold-token-sa-dgld-tokenized-gold": {
            usd: 10_591.46,
            usd_market_cap: 16_985_391.664749127,
          },
        },
      },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.itemCount).toBe(61);
    const finalValidationCall = validateSpy.mock.calls.find(
      (call) => call[2] === "sync-stablecoins:stablecoins"
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<Record<string, unknown>> } | undefined;
    const dgld = payload?.peggedAssets.find((asset) => asset.id === "dgld-gold-token-sa");

    expect(dgld).toBeDefined();
    expect(dgld?.price).toBe(10_591.46);
    expect(dgld?.priceSource).toBe("coingecko");
    expect(dgld?.circulating).toEqual({ peggedGOLD: 16_985_391.664749127 });
  });

  it("falls back to CoinGecko market cap for protocol-backed gold assets when DefiLlama protocol mcap is missing", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);
    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");

    mockFetch([
      {
        match: "api.coingecko.com",
        body: {
          "pleasing-gold": {
            usd: 5_122.31,
            usd_market_cap: 99_913_387.23420689,
          },
        },
      },
      { match: "stablecoins.llama.fi", body: dlData },
      {
        match: "coins.llama.fi/prices",
        body: {
          coins: {
            "coingecko:pleasing-gold": {
              price: 5_119.117514760049,
              symbol: "PGOLD",
              timestamp: 1_773_122_336,
              confidence: 0.99,
            },
          },
        },
      },
      {
        match: "api.llama.fi/protocol/pleasing-gold",
        body: {
          name: "Pleasing Gold",
          mcap: null,
          tvl: [{ date: 1_773_125_272, totalLiquidityUSD: 100_095_849 }],
        },
      },
    ]);

    const result = await syncStablecoins(db);

    expect(result.itemCount).toBe(61);
    const finalValidationCall = validateSpy.mock.calls.find(
      (call) => call[2] === "sync-stablecoins:stablecoins"
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<Record<string, unknown>> } | undefined;
    const pgold = payload?.peggedAssets.find((asset) => asset.id === "pgold-pleasing");

    expect(pgold).toBeDefined();
    expect(pgold?.price).toBe(5_119.117514760049);
    expect(pgold?.priceSource).toBe("coingecko-mirror");
    expect(pgold?.circulating).toEqual({ peggedGOLD: 99_913_387.23420689 });
  });

  it("keeps protocol-backed gold assets in the stablecoins cache when DefiLlama spot pricing disappears", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);
    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");

    const fetchSpy = mockFetch([
      {
        match: "api.coingecko.com",
        body: {
          "pleasing-gold": {
            usd: 4_327.46,
            usd_market_cap: 84_407_122.82446626,
          },
        },
      },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
      {
        match: "api.llama.fi/protocol/pleasing-gold",
        body: {
          name: "Pleasing Gold",
          mcap: null,
          tvl: [{ date: 1_774_183_907, totalLiquidityUSD: 84_407_122 }],
        },
      },
    ]);

    const result = await syncStablecoins(db);

    expect(result.itemCount).toBe(61);
    const finalValidationCall = validateSpy.mock.calls.find(
      (call) => call[2] === "sync-stablecoins:stablecoins",
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<Record<string, unknown>> } | undefined;
    const pgold = payload?.peggedAssets.find((asset) => asset.id === "pgold-pleasing");

    expect(
      fetchSpy.mock.calls.some(
        ([url]) => String(url).includes("api.coingecko.com") && String(url).includes("pleasing-gold"),
      ),
    ).toBe(true);
    expect(pgold).toBeDefined();
    expect(pgold?.price).toBe(4_327.46);
    expect(pgold?.priceSource).toBe("coingecko");
    expect(pgold?.supplySource).toBe("coingecko-fallback");
    expect(pgold?.circulating).toEqual({ peggedGOLD: 84_407_122.82446626 });
  });

  it("reuses fresh cached prices during CG supply fallback when CoinGecko spot values fail validation", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: { value: JSON.stringify({ peggedUSD: 1 }), updated_at: nowSec - 60 },
      },
      {
        match: "SELECT asset_id, price, updated_at FROM price_cache",
        rows: [{ asset_id: "fb-0", price: 1.01, updated_at: nowSec - 120 }],
      },
      { match: "INSERT OR REPLACE INTO price_cache", rows: [], runMeta: { changes: 1 } },
      { match: "INSERT INTO cache", rows: [], runMeta: { changes: 1 } },
      { match: "supply_history", rows: [] },
      { match: "price_cache", rows: [] },
    ]);
    const writes = trackCacheWrites(db);

    const cgBody = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [
        `fallback-coin-${i}`,
        { usd: i === 0 ? 2.5 : 1, usd_market_cap: 1_000_000 + i },
      ]),
    );

    mockFetch([
      { match: "api.coingecko.com/simple/price", body: cgBody },
      { match: "stablecoins.llama.fi", body: { error: "upstream" }, status: 500 },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
      { match: "api.llama.fi/protocol/pleasing-gold", body: { mcap: null, tvl: [] } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(60);
    expect(confirmPendingDepegs).toHaveBeenCalledWith(db, expect.any(Array), { peggedUSD: 1 }, undefined, undefined);

    const stablecoinsWrite = writes.find((entry) => entry.key === "stablecoins");
    expect(stablecoinsWrite).toBeDefined();

    const cached = JSON.parse(stablecoinsWrite!.value) as {
      peggedAssets: Array<{
        id: string;
        price: number | null;
        priceSource: string;
        priceConfidence: string | null;
      }>;
    };
    const fb0 = cached.peggedAssets.find((asset) => asset.id === "fb-0");
    expect(fb0).toMatchObject({
      id: "fb-0",
      price: 1.01,
      priceSource: "cached",
      priceConfidence: "fallback",
    });

    const savePriceCacheWrites = (db as ReturnType<typeof mockD1>).getHistory().filter(
      (entry) => entry.sql.includes("INSERT OR REPLACE INTO price_cache"),
    );
    expect(savePriceCacheWrites.length).toBeGreaterThan(0);
  });

  it("does not write low-confidence prices into price_cache replay storage", async () => {
    const dlData = makeDlResponse(60);
    dlData.peggedAssets[0] = {
      ...dlData.peggedAssets[0],
      id: "usdt-tether",
      name: "Tether",
      symbol: "USDT",
      price: 1.0,
      priceSource: "defillama",
      priceConfidence: "single-source",
      circulating: { peggedUSD: 100_000_000 },
    } as unknown as (typeof dlData.peggedAssets)[0];
    const db = makeDb();

    vi.mocked(fetchPrimaryPrices).mockResolvedValueOnce({
      results: new Map([
        [
          "usdt-tether",
          {
            price: 0.97,
            source: "coingecko",
            confidence: "low",
            dlPrice: 1.0,
            cgPrice: 0.97,
            candidateSources: ["coingecko", "defillama-list"],
            agreeSources: ["coingecko"],
          },
        ],
      ]),
      stats: { attempted: 1, high: 0, singleSource: 0, cgOnly: 0, low: 1 },
      cgPrices: new Map([["tether", 0.97]]),
    });

    mockFetch([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    await syncStablecoins(db);

    const priceCacheIds = (db as ReturnType<typeof mockD1>)
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO price_cache"))
      .map((entry) => String(entry.binds[0]));

    expect(priceCacheIds).not.toContain("usdt-tether");
  });

  it("restores last-known-good supplemental supply when CoinGecko market-cap fetch is unavailable", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const previousStablecoinsPayload = {
      peggedAssets: [
        {
          id: "dgld-gold-token-sa",
          name: "DGLD Tokenized Gold",
          symbol: "DGLD",
          geckoId: "gold-token-sa-dgld-tokenized-gold",
          pegType: "peggedGOLD",
          pegMechanism: "rwa-backed",
          price: 10_500,
          priceSource: "coingecko",
          priceConfidence: "single-source",
          priceUpdatedAt: nowSec - 900,
          supplySource: "coingecko-fallback",
          circulating: { peggedGOLD: 16_985_391.664749127 },
          circulatingPrevDay: {},
          circulatingPrevWeek: {},
          circulatingPrevMonth: {},
          chainCirculating: {},
          chains: ["Ethereum"],
        },
      ],
    };

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: { value: JSON.stringify(previousStablecoinsPayload), updated_at: nowSec - 300 },
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: null,
      },
      { match: "INSERT INTO cache", rows: [], runMeta: { changes: 1 } },
      { match: "price_cache", rows: [] },
      { match: "supply_history", rows: [] },
    ]);
    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");

    const dlData = makeDlResponse(60);
    mockFetch([
      { match: "api.coingecko.com/simple/price", body: { error: "cg down" }, status: 500 },
      { match: "stablecoins.llama.fi", body: dlData },
      {
        match: "coins.llama.fi/prices",
        body: {
          coins: {
            "coingecko:gold-token-sa-dgld-tokenized-gold": {
              price: 10_700,
              symbol: "DGLD",
              timestamp: 1_773_122_336,
              confidence: 0.99,
            },
          },
        },
      },
      { match: "api.llama.fi/protocol/pleasing-gold", body: { mcap: null, tvl: [] } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(61);
    const finalValidationCall = validateSpy.mock.calls.find(
      (call) => call[2] === "sync-stablecoins:stablecoins",
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<Record<string, unknown>> } | undefined;
    const dgld = payload?.peggedAssets.find((asset) => asset.id === "dgld-gold-token-sa");

    expect(dgld).toBeDefined();
    expect(dgld?.price).toBe(10_700);
    expect(dgld?.priceSource).toBe("coingecko-mirror");
    expect(dgld?.supplySource).toBe("coingecko-fallback");
    expect(dgld?.circulating).toEqual({ peggedGOLD: 16_985_391.664749127 });
  });

  it("dedupes duplicate canonical IDs after DefiLlama remap", async () => {
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

    expect(result.itemCount).toBe(59);
    const finalValidationCall = validateSpy.mock.calls.find(
      (call) => call[2] === "sync-stablecoins:stablecoins"
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<{ id: string }> } | undefined;
    expect(payload).toBeDefined();
    const usdtCopies = payload?.peggedAssets.filter((asset) => asset.id === "usdt-tether").length ?? 0;
    expect(usdtCopies).toBe(1);
    expect(detectDepegEvents).toHaveBeenCalledWith(db, expect.any(Array), undefined, undefined);
  });
});

describe("stampPriceMetadata", () => {
  it("stamps consensusSources when provided", () => {
    const asset = { id: "test", name: "Test", symbol: "T", circulating: {}, chains: [] } as PeggedAsset;

    stampPriceMetadata(asset, "coingecko+defillama-list", "high", 1234, null, ["coingecko", "defillama-list"]);

    expect(asset.priceSource).toBe("coingecko+defillama-list");
    expect(asset.priceConfidence).toBe("high");
    expect(asset.priceUpdatedAt).toBe(1234);
    expect(asset.consensusSources).toEqual(["coingecko", "defillama-list"]);
  });

  it("leaves consensusSources unchanged when not provided", () => {
    const asset = {
      id: "test", name: "Test", symbol: "T", circulating: {}, chains: [],
      consensusSources: ["existing"],
    } as PeggedAsset;

    stampPriceMetadata(asset, "cached", "fallback", 5678);

    expect(asset.consensusSources).toEqual(["existing"]);
  });

  it("stamps agreeSources when provided", () => {
    const asset = { id: "test", name: "Test", symbol: "T", circulating: {}, chains: [] } as PeggedAsset;
    stampPriceMetadata(asset, "coingecko+defillama-list", "high", 100, null, ["coingecko", "defillama-list"], ["coingecko", "defillama-list"]);
    expect(asset.agreeSources).toEqual(["coingecko", "defillama-list"]);
  });

  it("leaves agreeSources unchanged when not provided", () => {
    const asset = {
      id: "test", name: "Test", symbol: "T", circulating: {}, chains: [],
      agreeSources: ["existing"],
    } as PeggedAsset;
    stampPriceMetadata(asset, "x", "high", 100);
    expect(asset.agreeSources).toEqual(["existing"]);
  });
});
