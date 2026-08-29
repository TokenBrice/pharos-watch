import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 as createMockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { mockCircuitBreaker, mockCircuitOutcomeRecord, mockFetchRetry, mockRegistry } from "../../test-helpers/cron";
import { defaultSyncRoutes } from "./sync-stablecoins.test-support";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { makePeggedAsset } from "../sync-stablecoins/__tests__/_fixtures";

const fetchWithRetryMock = vi.hoisted(() => vi.fn());

function mockFetchWithRetry(routes: Parameters<typeof mockFetch>[0]): ReturnType<typeof mockFetch> {
  const spy = mockFetch(routes, { requireMatch: true, stubGlobal: false });
  fetchWithRetryMock.mockImplementation((url: string) => spy(url));
  return spy;
}

// --- Module-level mocks ---

// Use the shared stablecoin builder for registry metadata and the shared
// pegged-asset builder for upstream payloads below. Only registry filler rows
// are synthetic; they keep the minimum-count boundary explicit.
vi.mock("@shared/lib/stablecoins/registry", () => {
  type RegistryFixture = Record<string, unknown> & {
    id: string;
    flags?: Record<string, unknown>;
  };
  const fiatFlags = {
    pegCurrency: "USD",
    backing: "fiat-backed",
    yieldBearing: false,
    navToken: false,
    governance: "centralized",
  };
  const rwaFlags = {
    pegCurrency: "USD",
    backing: "rwa-backed",
    yieldBearing: false,
    navToken: false,
    governance: "centralized",
  };
  const dependentCryptoFlags = {
    pegCurrency: "USD",
    backing: "crypto-backed",
    yieldBearing: false,
    navToken: false,
    governance: "centralized-dependent",
  };
  const makeRegistryAsset = (overrides: RegistryFixture): RegistryFixture => ({
    ...makeStablecoin(overrides as Parameters<typeof makeStablecoin>[0]),
    ...overrides,
  });
  const fallbackTrackedTokens = Array.from({ length: 50 }, (_, i) =>
    makeRegistryAsset({
      id: `fb-${i}`,
      name: `Fallback Coin ${i}`,
      symbol: `FC${i}`,
      geckoId: `fallback-coin-${i}`,
      detailProvider: "coingecko",
      flags: fiatFlags,
    }),
  );
  const chfauContracts = [
    { chain: "ethereum", address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78", decimals: 6 },
    { chain: "polygon", address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78", decimals: 6 },
    { chain: "base", address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78", decimals: 6 },
    { chain: "tempo", address: "0x20c00000000000000000000042109aef2f8b28e1", decimals: 6 },
  ];
  const stablecoins: RegistryFixture[] = [
    makeRegistryAsset({ id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether", llamaId: "1", detailProvider: "defillama", flags: fiatFlags }),
    makeRegistryAsset({ id: "usdc-circle", name: "USD Coin", symbol: "USDC", geckoId: "usd-coin", llamaId: "2", detailProvider: "defillama", flags: fiatFlags }),
    makeRegistryAsset({
      id: "eurcv-societe-generale-forge", name: "EUR CoinVertible", symbol: "EURCV",
      geckoId: "societe-generale-forge-eurcv", detailProvider: "defillama",
      contracts: [
        { chain: "ethereum", address: "0x5f7827fdeb7c20b443265fc2f40845b715385ff2", decimals: 18 },
        { chain: "xrpl", address: "EURCV.XRPL", decimals: 0 },
        { chain: "stellar", address: "EURCV.STELLAR", decimals: 7 },
        { chain: "solana", address: "EURCV.SOL", decimals: 2 },
      ],
      flags: { ...fiatFlags, pegCurrency: "EUR" },
    }),
    makeRegistryAsset({
      id: "tryb-bilira", name: "BiLira", symbol: "TRYB", geckoId: "bilira", llamaId: "300",
      detailProvider: "defillama",
      contracts: [
        { chain: "ethereum", address: "0x2c537e5624e4af88a7ae4060c022609376c8d0eb", decimals: 6 },
        { chain: "bsc", address: "0xc1fdbed7dac39cae2ccc0748f7a80dc446f6a594", decimals: 6 },
      ],
      flags: { ...fiatFlags, pegCurrency: "TRY" },
    }),
    makeRegistryAsset({
      id: "dgld-gold-token-sa", name: "DGLD Tokenized Gold", symbol: "DGLD",
      geckoId: "gold-token-sa-dgld-tokenized-gold", detailProvider: "commodity", commodityOunces: 1,
      flags: { ...rwaFlags, pegCurrency: "GOLD" },
    }),
    makeRegistryAsset({
      id: "pgold-pleasing", name: "Pleasing Gold", symbol: "PGOLD", geckoId: "pleasing-gold",
      protocolSlug: "pleasing-gold", detailProvider: "commodity", commodityOunces: 1,
      flags: { ...rwaFlags, pegCurrency: "GOLD" },
    }),
    makeRegistryAsset({
      id: "chfau-allunity", name: "AllUnity CHF", symbol: "CHFAU", geckoId: "allunity-chf",
      detailProvider: "coingecko", contracts: chfauContracts, flags: { ...rwaFlags, pegCurrency: "CHF" },
    }),
    makeRegistryAsset({
      id: "cadd-cad-digital", name: "CAD Digital", symbol: "CADD", geckoId: "cad-digital", llamaId: "387",
      detailProvider: "defillama",
      contracts: [
        { chain: "ethereum", address: "0x16f93ebc5320c89efc8701577efe49d14a276a06", decimals: 18 },
        { chain: "base", address: "0x16f93ebc5320c89efc8701577efe49d14a276a06", decimals: 18 },
      ],
      flags: { ...rwaFlags, pegCurrency: "CAD" },
    }),
    makeRegistryAsset({
      id: "jpym-mento", name: "Mento Japanese Yen", symbol: "JPYm", geckoId: "celo-japanese-yen", llamaId: "363",
      detailProvider: "defillama", contracts: [{ chain: "celo", address: "0xc45ecf20f3cd864b32d9794d6f76814ae8892e20", decimals: 18 }],
      flags: { ...dependentCryptoFlags, pegCurrency: "JPY" },
    }),
    makeRegistryAsset({
      id: "zarm-mento", name: "Mento South African Rand", symbol: "ZARm", geckoId: "celo-south-african-rand", llamaId: "368",
      detailProvider: "defillama", contracts: [{ chain: "celo", address: "0x4c35853a3b4e647fd266f4de678dcc8fec410bf6", decimals: 18 }],
      flags: { ...dependentCryptoFlags, pegCurrency: "ZAR" },
    }),
    makeRegistryAsset({
      id: "xofm-mento", name: "Mento West African CFA Franc", symbol: "XOFm", geckoId: "celo-west-african-cfa-franc", llamaId: "371",
      detailProvider: "defillama", contracts: [{ chain: "celo", address: "0x73f93dcc49cb8a239e2032663e9475dd5ef29a08", decimals: 18 }],
      flags: { ...dependentCryptoFlags, pegCurrency: "XOF" },
    }),
    makeRegistryAsset({
      id: "usdk-kast", name: "KAST Dollar", symbol: "USDK", detailProvider: "coingecko",
      contracts: [{ chain: "solana", address: "usdkbee86pkLyRmxfFCdkyySpxRb5ndCxVsK2BkRXwX", decimals: 6 }],
      flags: { ...rwaFlags, pegCurrency: "USD" },
    }),
    makeRegistryAsset({
      id: "xo-exodus", name: "XO Cash", symbol: "XO", geckoId: "xo-cash", detailProvider: "coingecko",
      contracts: [{ chain: "solana", address: "xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y", decimals: 6 }],
      flags: { ...rwaFlags, pegCurrency: "USD" },
    }),
    ...fallbackTrackedTokens,
  ];
  const trackedMetaById = new Map<string, unknown>();
  for (const coin of stablecoins.filter((candidate) => !candidate.id.startsWith("fb-"))) {
    trackedMetaById.set(coin.id, {
      ...coin,
      cmcSlug: undefined,
      flags: { ...coin.flags, navToken: false },
    });
  }
  trackedMetaById.set("ggbr-goldfish-gold", {
    geckoId: "goldfish-gold",
    cmcSlug: undefined,
    commodityOunces: 0.001,
    flags: { navToken: false },
  });
  return mockRegistry({
    stablecoins: stablecoins as Parameters<typeof mockRegistry>[0]["stablecoins"],
    trackedMetaById,
  });
});

vi.mock("@shared/lib/stablecoins/frozen-snapshots", () => ({
  FROZEN_SNAPSHOTS: [],
  FROZEN_SNAPSHOTS_BY_ID: new Map(),
}));

// Stub enrich-prices to avoid complex 5-pass pipeline
vi.mock("../sync-stablecoins/enrich-prices", () => ({
  enrichMissingPrices: vi.fn(async () => ({
    totalMissing: 0, pass1: 0, pass1b: 0, passCmc: 0, passJupiter: 0, passDex: 0, passCgLowVolume: 0, finalMissing: 0, failedPasses: [],
  })),
  hasMissingPrice: vi.fn((a: { price?: number | null }) => a.price == null || typeof a.price !== "number" || a.price === 0),
  fetchPrimaryPrices: vi.fn(async () => ({
    results: new Map(),
    stats: { attempted: 0, high: 0, singleSource: 0, cgOnly: 0, low: 0 },
    cgPrices: new Map(),
  })),
}));

// Stub detect-depegs and confirm-pending-depegs
vi.mock("../detect-depegs", () => ({
  detectDepegEvents: vi.fn(async () => {}),
}));

vi.mock("../confirm-pending-depegs", () => ({
  confirmPendingDepegs: vi.fn(async () => ({ providerDiagnostics: [] })),
}));

vi.mock("../../lib/authoritative-price-sources", () => ({
  createAuthoritativeLivePriceOverrideStats: vi.fn((budgetMs = 30_000) => ({
    budgetMs,
    candidateCount: 0,
    attemptedCount: 0,
    successCount: 0,
    failedCount: 0,
    emptyCount: 0,
    skippedCircuitOpen: 0,
    skippedBudget: 0,
    timedOut: false,
  })),
  fetchAuthoritativeLivePriceOverrides: vi.fn(async () => new Map()),
}));

// Stub resolve-market-cap
vi.mock("../../lib/resolve-market-cap", () => ({
  resolveMarketCap: vi.fn((...args: unknown[]) => args[0] ?? 0),
}));

// Stub fetch-retry; `mockFetchWithRetry` below points the base at global fetch
vi.mock("../../lib/fetch-retry", () => mockFetchRetry({ fetchWithRetry: fetchWithRetryMock }));

// Stub circuit-breaker
vi.mock("../../lib/circuit-breaker", () => mockCircuitBreaker());

// Stub coingecko helpers
vi.mock("../../lib/coingecko", () => ({
  cgUrl: vi.fn((path: string) => `https://api.coingecko.com${path}`),
  cgSimplePricePath: vi.fn((query: string) => `/simple/price?${query}&precision=full`),
  cgHeaders: vi.fn((extra: Record<string, string>) => extra),
}));

// Coverage completeness is exercised in stablecoin-publication-coverage.test.ts.
// This suite isolates pricing/publication mechanics with intentionally partial fixtures.
vi.mock("../../lib/stablecoin-publication-coverage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/stablecoin-publication-coverage")>();
  return {
    ...actual,
    loadPreviousStablecoinActivePriceCoverage: vi.fn(async () => null),
    evaluateStablecoinPublicationCoverage: (ids: Iterable<string>) => {
      const published = [...new Set(ids)];
      return {
        complete: true,
        expectedActiveCount: published.length,
        presentActiveCount: published.length,
        waivedActiveCount: 0,
        missingActiveIds: [],
        waivedActiveIds: [],
        expiredWaiverIds: [],
        invalidWaiverIds: [],
      };
    },
    evaluateStablecoinActivePriceCoverage: (assets: Iterable<{ id: string }>) => {
      const pricedActiveIds = [...new Set([...assets].map((asset) => String(asset.id)))];
      return {
        complete: true,
        expectedActiveCount: pricedActiveIds.length,
        presentActiveCount: pricedActiveIds.length,
        pricedActiveCount: pricedActiveIds.length,
        missingPriceCount: 0,
        pricedActiveIds,
        missingActiveIds: [],
        affectedMarketCapUsd: 0,
        missingActiveAssets: [],
        alertEligibleCount: 0,
        alertEligibleIds: [],
        maxConsecutiveMissingGenerations: 0,
      };
    },
  };
});

import { syncStablecoins } from "../sync-stablecoins";
import { stampPriceMetadata } from "../sync-stablecoins/shared";
import { enrichMissingPrices, fetchPrimaryPrices } from "../sync-stablecoins/enrich-prices";
import type { PeggedAsset } from "../sync-stablecoins/enrich-prices";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { detectDepegEvents } from "../detect-depegs";
import { confirmPendingDepegs } from "../confirm-pending-depegs";
import { fetchAuthoritativeLivePriceOverrides } from "../../lib/authoritative-price-sources";
import * as apiUtils from "../../lib/api-schema";

const DEFAULT_STABLECOINS_D1_TABLES: MockTableConfig[] = [
  { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
];

function mockD1(tables: MockTableConfig[] = []) {
  return createMockD1([...tables, ...DEFAULT_STABLECOINS_D1_TABLES]);
}

// --- Helpers ---

function makeDlResponse(assetCount: number) {
  const peggedAssets = Array.from({ length: assetCount }, (_, i) =>
    makePeggedAsset({
      id: String(i + 1),
      name: `Stablecoin ${i + 1}`,
      symbol: `SC${i + 1}`,
      geckoId: undefined,
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
    }),
  );
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
    vi.mocked(recordOutcome).mockReset().mockResolvedValue(mockCircuitOutcomeRecord());
    fetchWithRetryMock.mockReset();
    vi.mocked(enrichMissingPrices).mockReset().mockResolvedValue({
      totalMissing: 0, pass1: 0, pass1b: 0, passCmc: 0, passJupiter: 0, passDex: 0, passCgLowVolume: 0, finalMissing: 0, failedPasses: [],
    });
    vi.mocked(fetchPrimaryPrices).mockReset().mockResolvedValue({
      results: new Map(),
      stats: { attempted: 0, high: 0, singleSource: 0, cgOnly: 0, low: 0 },
      cgPrices: new Map(),
    });
    vi.mocked(fetchAuthoritativeLivePriceOverrides).mockReset().mockResolvedValue(new Map());
    vi.mocked(detectDepegEvents).mockReset().mockResolvedValue(undefined);
    vi.mocked(confirmPendingDepegs).mockReset().mockResolvedValue({ providerDiagnostics: [] });
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

    mockFetchWithRetry(defaultSyncRoutes(dlData));

    const result = await syncStablecoins(db);

    expect(result.itemCount).toBe(60);
    expect(result.productivity).toEqual({
      productive: true,
      reason: "stablecoins-cache-published",
      publications: [{
        surface: "stablecoins",
        generationId: `stablecoins:${Math.floor(Date.now() / 1000)}`,
        publishedAt: Math.floor(Date.now() / 1000),
        candidateRows: 60,
        publishedRows: 60,
        expectedRows: 60,
        artifactCacheKey: "stablecoins",
      }],
    });
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.cacheWriteMode).toBe("published");
    expect(metadata.casSkipped).toBe(false);
    expect(metadata.downstreamSafe).toBe(true);
    // Should have written to cache
    const cacheWrites = prepareSpy.mock.calls.filter(
      (args) => (args[0] as string).includes("INSERT INTO cache")
    );
    expect(cacheWrites.length).toBeGreaterThanOrEqual(1);
    expect(shouldAttemptFetch).toHaveBeenCalledWith(db, "defillama-stablecoins");
    expect(fetchPrimaryPrices).toHaveBeenCalledWith(
      expect.any(Array),
      db,
      undefined,
      undefined,
      undefined,
      undefined,
      expect.any(Map),
      undefined,
      expect.objectContaining({
        previousAssetsById: expect.any(Map),
        addressProvider: undefined,
      }),
    );
    expect(enrichMissingPrices).toHaveBeenCalledWith(
      expect.any(Array),
      undefined,
      db,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
      expect.any(Map),
    );
    expect(detectDepegEvents).toHaveBeenCalledWith(db, expect.any(Array), undefined, undefined, undefined, expect.any(Object));
    expect(confirmPendingDepegs).toHaveBeenCalledWith(
      db,
      expect.any(Array),
      undefined,
      undefined,
      undefined,
      expect.any(Object),
      expect.any(Object),
    );
    const primaryPriceAssets = vi.mocked(fetchPrimaryPrices).mock.calls[0]?.[0] as Array<{ id: string }>;
    expect(primaryPriceAssets).toHaveLength(60);
    const enrichmentAssets = vi.mocked(enrichMissingPrices).mock.calls[0]?.[0] as Array<{ id: string }>;
    expect(enrichmentAssets).toHaveLength(60);
  });

  it("does not claim publication or run downstream depeg stages when stablecoins CAS skips", async () => {
    const db = mockD1([
      { match: "INSERT INTO cache", rows: [], runMeta: { changes: 0 } },
      { match: "cache", rows: [] },
      { match: "supply_history", rows: [] },
      { match: "price_cache", rows: [] },
      { match: "circuit", rows: [] },
    ]);
    const dlData = makeDlResponse(60);

    mockFetchWithRetry(defaultSyncRoutes(dlData));

    const result = await syncStablecoins(db);

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(0);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.rowsWritten).toBe(0);
    expect(metadata.cacheWriteMode).toBe("skipped-newer");
    expect(metadata.casSkipped).toBe(true);
    expect(metadata.cacheWriteSucceeded).toBe(false);
    expect(metadata.cacheKey).toBe("stablecoins");
    expect(metadata.syncStartSec).toBe(Math.floor(Date.now() / 1000));
    expect(detectDepegEvents).not.toHaveBeenCalled();
    expect(confirmPendingDepegs).not.toHaveBeenCalled();
  });

  it("keeps the optional live GT probe out of the critical publication path", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);
    const order: string[] = [];

    vi.mocked(enrichMissingPrices).mockImplementationOnce(async () => {
      order.push("enrich");
      return {
        totalMissing: 0, pass1: 0, pass1b: 0, passCmc: 0, passJupiter: 0, passDex: 0, passCgLowVolume: 0, finalMissing: 0, failedPasses: [],
      };
    });
    mockFetchWithRetry(defaultSyncRoutes(dlData));

    await syncStablecoins(db);

    expect(order).toEqual(["enrich"]);
  });

  it("persists the inline GT isolation decision into sync metadata", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);

    mockFetchWithRetry(defaultSyncRoutes(dlData));

    const result = await syncStablecoins(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    const gtProbe = metadata.gtProbe as Record<string, unknown>;
    const transports = gtProbe.transports as Record<string, unknown>;

    expect(gtProbe.inlineDisabled).toBe(true);
    expect(gtProbe.isolationReason).toBe("worker-memory-boundary");
    expect((transports.coingeckoOnchain as Record<string, unknown>).attempted).toBe(0);
    expect((transports.geckoTerminalPublic as Record<string, unknown>).attempted).toBe(0);
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

    mockFetchWithRetry(defaultSyncRoutes(dlData));

    const result = await syncStablecoins(db);

    expect(result.status).toBe("ok");
    const stablecoinsWrite = writes.find((entry) => entry.key === "stablecoins");
    const cached = JSON.parse(stablecoinsWrite!.value) as {
      peggedAssets: Array<{
        id: string;
        price: number | null;
        priceSource: string;
        priceConfidence: string | null;
        consensusSources: string[];
        agreeSources: string[];
      }>;
    };
    const usdt = cached.peggedAssets.find((asset) => asset.id === "usdt-tether");
    expect(usdt).toMatchObject({
      id: "usdt-tether",
      price: 1.0,
      priceSource: "defillama",
      priceConfidence: "single-source",
      consensusSources: ["defillama"],
      agreeSources: ["defillama"],
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

    mockFetchWithRetry(defaultSyncRoutes(dlData));

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
        match: "SELECT asset_id, price, updated_at, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json FROM price_cache",
        rows: [
          {
            asset_id: "usdt-tether",
            price: 0.25580214,
            updated_at: nowSec - 120,
            source: "defillama-list+pyth",
            confidence: "high",
            observed_at: nowSec - 120,
            observed_at_mode: null,
            synced_at: nowSec - 135,
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
        target.price = null;
        target.priceSource = undefined;
        target.priceConfidence = null;
        target.priceUpdatedAt = null;
        target.priceObservedAt = null;
        target.priceSyncedAt = null;
        target.consensusSources = [];
        target.agreeSources = [];
      }

      return {
        totalMissing: 1,
        pass1: 0,
        pass1b: 0,
        passCmc: 0,
        passJupiter: 0,
        passDex: 0,
        passCgLowVolume: 0,
        finalMissing: 1,
        failedPasses: [],
      };
    });

    mockFetchWithRetry(defaultSyncRoutes(dlData));

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
      priceObservedAt: nowSec - 120,
      priceSyncedAt: nowSec - 135,
    });
    expect(usdt?.price).toBeCloseTo(0.25580214, 8);
  });

  it("fails the run when DL returns 500 and fallback is insufficient", async () => {
    const db = makeDb();

    mockFetchWithRetry([
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

    mockFetchWithRetry([
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

    const attemptedSources = vi.mocked(shouldAttemptFetch).mock.calls.map((call) => call[1]);
    expect(attemptedSources).not.toContain("defillama-coins");
    expect(attemptedSources).not.toContain("defillama-protocols");
  });

  it("fails the run when DL payload is structurally invalid and fallback is insufficient", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(10);

    mockFetchWithRetry(defaultSyncRoutes(dlData));

    await expect(syncStablecoins(db)).rejects.toThrow(
      "DefiLlama payload was structurally invalid",
    );
  });

  it("runs depeg detection after successful DL sync", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);

    mockFetchWithRetry(defaultSyncRoutes(dlData));

    await syncStablecoins(db);

    expect(detectDepegEvents).toHaveBeenCalled();
    expect(confirmPendingDepegs).toHaveBeenCalled();
    const detectArgs = vi.mocked(detectDepegEvents).mock.calls[0];
    expect(detectArgs?.[0]).toBe(db);
    expect((detectArgs?.[1] as unknown[]).length).toBe(60);
    expect(detectArgs?.[2]).toBeUndefined();
    expect(detectArgs?.[3]).toBeUndefined();
    expect(detectArgs?.[4]).toBeUndefined();

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

    mockFetchWithRetry(defaultSyncRoutes(dlData));

    const result = await syncStablecoins(db);

    // Should still return a valid result
    expect(result.itemCount).toBe(60);
    expect(result.status).toBe("degraded");
    // Metadata should contain depeg error info
    const metadata = JSON.parse(result.metadata!);
    expect(metadata.depegPipelineSucceeded).toBe(false);
    expect(metadata.depegErrorCount).toBe(1);
    expect(metadata.depegErrors).toBeDefined();
    expect(metadata.depegErrors.length).toBeGreaterThan(0);
  });

  it("writes guarded fallback payload when final stablecoins payload fails schema validation", async () => {
    const db = makeDb();
    const cacheWrites = trackCacheWrites(db);

    const dlData = makeDlResponse(60);
    vi.spyOn(apiUtils, "validatePayloadWithSchema").mockReturnValueOnce({
      ok: false,
      issues: "forced-test-validation-failure",
    });

    mockFetchWithRetry(defaultSyncRoutes(dlData));

    const result = await syncStablecoins(db);

    expect(result.itemCount).toBe(60);
    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.validationFailures).toBe(1);
    expect(metadata.cacheWriteMode).toBe("blocked-invalid-payload");
    expect(metadata.casSkipped).toBe(false);
    expect(metadata.downstreamSafe).toBe(false);
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

    mockFetchWithRetry(defaultSyncRoutes(dlData));

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

    mockFetchWithRetry(defaultSyncRoutes(dlData));

    await syncStablecoins(db, undefined, { reportProgress });

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
    const cgObservedAt = Math.floor(Date.now() / 1000);
    const cgData: Record<string, { usd: number; usd_market_cap: number; last_updated_at: number }> = {};
    for (let i = 0; i < 60; i++) {
      cgData[`fallback-coin-${i}`] = { usd: 1, usd_market_cap: 1_000_000 + i, last_updated_at: cgObservedAt };
    }

    vi.spyOn(apiUtils, "validatePayloadWithSchema").mockReturnValueOnce({
      ok: false,
      issues: "forced-fallback-validation-failure",
    });

    mockFetchWithRetry([
      { match: "api.coingecko.com", body: cgData },
      { match: "stablecoins.llama.fi", body: { error: "down" }, status: 500 },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.validationFailures).toBe(1);
    expect(metadata.validationContext).toBe("fallback");
    const cacheKeys = cacheWrites.map((write) => write.key);
    expect(cacheKeys).toContain("stablecoins:invalid-last");
    expect(cacheKeys).not.toContain("stablecoins");
  });

  it("records DL success outcome when fetch succeeds", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);

    mockFetchWithRetry(defaultSyncRoutes(dlData));

    await syncStablecoins(db);

    expect(recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      "defillama-stablecoins",
      true,
    );
  });

  it("normalizes gecko_id aliases and nullable buckets before final schema validation", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);
    const target = dlData.peggedAssets[2] as unknown as Record<string, unknown>;
    delete target.geckoId;
    target.gecko_id = "coin-three";
    delete target.priceConfidence;
    target.circulatingPrevDay = null;
    target.circulatingPrevWeek = null;
    target.circulatingPrevMonth = null;

    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");

    mockFetchWithRetry(defaultSyncRoutes(dlData));

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

  it("preserves the stablecoins cache when severe price staleness is detected", async () => {
    const dlData = makeDlResponse(60);
    const nowSec = Math.floor(Date.now() / 1000);
    const previousPayload = JSON.stringify({
      peggedAssets: dlData.peggedAssets.map((asset) => ({
        id: asset.id,
        price: asset.price,
        priceSource: asset.priceSource,
        priceConfidence: "single-source",
        priceUpdatedAt: nowSec,
        priceObservedAt: nowSec,
        priceSyncedAt: nowSec,
      })),
    });
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [{ value: previousPayload, updated_at: nowSec - (8 * 3600) }],
        first: { value: previousPayload, updated_at: nowSec - (8 * 3600) },
      },
      { match: "supply_history", rows: [] },
      { match: "price_cache", rows: [] },
      { match: "circuit", rows: [] },
      { match: "cache", rows: [] },
    ]);
    const cacheWrites = trackCacheWrites(db);

    mockFetchWithRetry(defaultSyncRoutes(dlData));

    const result = await syncStablecoins(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      stalenessWarning: true,
      staleWriteBlocked: true,
      cacheWriteMode: "no-write",
      downstreamSafe: false,
    });
    expect(cacheWrites.map((write) => write.key)).not.toContain("stablecoins");
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.DL_STABLECOINS,
      false,
    );
  });

  it("does not record a DefiLlama circuit failure when aborted during the staleness check", async () => {
    const dlData = makeDlResponse(60);
    const controller = new AbortController();
    const reportProgress = vi.fn(async (update: { stage?: string | null }) => {
      if (update.stage === "staleness-check") {
        controller.abort("test abort during staleness check");
      }
    });
    const db = makeDb();

    mockFetchWithRetry(defaultSyncRoutes(dlData));

    const result = await syncStablecoins(db, controller.signal, { reportProgress });

    expect(result.aborted).toBe(true);
    expect(vi.mocked(recordOutcome).mock.calls.some((call) => (
      call[1] === CIRCUIT_SOURCE.DL_STABLECOINS && call[2] === false
    ))).toBe(false);
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

    mockFetchWithRetry(defaultSyncRoutes(dlData));

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
        match: "SELECT asset_id, price, updated_at, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json FROM price_cache",
        rows: [{
          asset_id: "usdt-tether",
          price: 0.3,
          updated_at: nowSec - 120,
          source: "coingecko+pyth",
          confidence: "high",
          observed_at: nowSec - 120,
          observed_at_mode: null,
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

    mockFetchWithRetry(defaultSyncRoutes(dlData));

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
        match: "SELECT asset_id, price, updated_at, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json FROM price_cache",
        rows: [{ asset_id: "usdt-tether", price: 0.999, updated_at: nowSec - (7 * 3600), source: null, confidence: null, observed_at: null, observed_at_mode: null, synced_at: null, agree_sources_json: null, consensus_sources_json: null }],
      },
      { match: "cache", rows: [] },
      { match: "supply_history", rows: [] },
      { match: "circuit", rows: [] },
      { match: "price_cache", rows: [] },
    ]);

    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");

    mockFetchWithRetry(defaultSyncRoutes(dlData));

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

  it("drops cached-replay price when source's maxTrustedAgeSec window elapsed even if within 6h global TTL", async () => {
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
        match: "SELECT asset_id, price, updated_at, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json FROM price_cache",
        rows: [{
          asset_id: "usdt-tether",
          price: 0.999,
          updated_at: nowSec - 1_800,
          source: "coingecko",
          confidence: "high",
          observed_at: nowSec - 1_800,
          observed_at_mode: "upstream",
          synced_at: nowSec - 1_800,
          agree_sources_json: "[\"coingecko\"]",
          consensus_sources_json: "[\"coingecko\"]",
        }],
      },
      { match: "cache", rows: [] },
      { match: "supply_history", rows: [] },
      { match: "circuit", rows: [] },
      { match: "price_cache", rows: [] },
    ]);

    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");

    mockFetchWithRetry(defaultSyncRoutes(dlData));

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
    const target = dlData.peggedAssets[0] as unknown as Record<string, unknown>;
    target.id = "jpyc-jpyc";
    target.name = "JPYC";
    target.symbol = "JPYC";
    target.price = 0.0005;
    target.pegType = "peggedJPY";

    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");

    mockFetchWithRetry(defaultSyncRoutes(dlData));

    const result = await syncStablecoins(db);

    expect(result.itemCount).toBe(60);
    const finalValidationCall = validateSpy.mock.calls.find(
      (call) => call[2] === "sync-stablecoins:stablecoins"
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<Record<string, unknown>> } | undefined;
    const normalized = payload?.peggedAssets.find((a) => a.id === "jpyc-jpyc");
    expect(normalized?.price).toBe(0.0005);
  });

  it("retries DL response body parse failure before falling back", async () => {
    // The file's beforeEach enables vi.useFakeTimers(). The parse-retry path
    // uses sleepWithSignal() (real setTimeout), which would hang forever under
    // fake timers. Switch to real timers for this test only — afterEach will
    // restore fake timers for the next test.
    vi.useRealTimers();

    const db = makeDb();
    const validPayload = makeDlResponse(60);

    function makeThrowingResponse(): Response {
      const stub: Partial<Response> = {
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
        text: () => Promise.resolve("truncated{"),
        body: null,
        bodyUsed: false,
        clone: () => makeThrowingResponse(),
      };
      return stub as Response;
    }
    function makeValidResponse(): Response {
      return new Response(JSON.stringify(validPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Capture the CG route spy ONCE outside the closure — calling mockFetchWithRetry(...)
    // again inside the closure would call fetchWithRetryMock.mockImplementation()
    // and overwrite this very router mid-test.
    const cgMockFetch = mockFetchWithRetry([
      { match: "api.coingecko.com", body: {} },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]) as unknown as (url: string) => Promise<Response>;

    let dlAttempt = 0;
    fetchWithRetryMock.mockImplementation(async (url: string) => {
      if (url.includes("/stablecoins?includePrices=true")) {
        const attempt = dlAttempt++;
        return attempt === 0 ? makeThrowingResponse() : makeValidResponse();
      }
      return cgMockFetch(url);
    });

    await syncStablecoins(db);

    // The DL stablecoins circuit must NOT have been marked failed —
    // the retry recovered before the fallback path ran.
    expect(recordOutcome).not.toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.DL_STABLECOINS,
      false,
    );
    // DL was fetched exactly twice: initial attempt + 1 successful parse-retry.
    expect(dlAttempt).toBe(2);
  });

  it("falls back to CoinGecko after all DL parse retries fail", async () => {
    // Exercises the retry loop (2 sleeps) — needs real timers.
    vi.useRealTimers();

    const db = makeDb();

    function makeThrowingResponse(): Response {
      const stub: Partial<Response> = {
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
        text: () => Promise.resolve("truncated{"),
        body: null,
        bodyUsed: false,
        clone: () => makeThrowingResponse(),
      };
      return stub as Response;
    }

    const cgMockFetch = mockFetchWithRetry([
      { match: "api.coingecko.com", body: {} },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]) as unknown as (url: string) => Promise<Response>;

    let dlAttempt = 0;
    fetchWithRetryMock.mockImplementation(async (url: string) => {
      if (url.includes("/stablecoins?includePrices=true")) {
        dlAttempt++;
        return makeThrowingResponse();
      }
      return cgMockFetch(url);
    });

    // With empty CG mock data, the CG fallback produces itemCount=0,
    // which makes sync-stablecoins.ts:57 re-throw the errorMessage.
    // This matches the production "cron_runs.status='error'" behavior
    // that this fix targets — just wrapped in a rejection for the test.
    await expect(syncStablecoins(db)).rejects.toThrow(
      /DefiLlama response body parse failed/,
    );

    // DL fetched exactly DL_PARSE_MAX_ATTEMPTS (3) times — one per retry.
    expect(dlAttempt).toBe(3);

    // Circuit failure recorded, fallback path taken.
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.DL_STABLECOINS,
      false,
    );
  });

  it("skips parse retry and falls back on DL HTTP failure", async () => {
    // No real sleeps in this test path — default fake timers are fine.
    const db = makeDb();

    const cgMockFetch = mockFetchWithRetry([
      { match: "api.coingecko.com", body: {} },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]) as unknown as (url: string) => Promise<Response>;

    let dlAttempt = 0;
    fetchWithRetryMock.mockImplementation(async (url: string) => {
      if (url.includes("/stablecoins?includePrices=true")) {
        dlAttempt++;
        return new Response("", { status: 502 });
      }
      return cgMockFetch(url);
    });

    // With empty CG mock data, the CG fallback produces itemCount=0,
    // which makes sync-stablecoins.ts:57 re-throw.
    await expect(syncStablecoins(db)).rejects.toThrow(
      /DefiLlama stablecoins API failed/,
    );

    // DL fetched exactly 1 time (no parse retry on HTTP error).
    expect(dlAttempt).toBe(1);

    expect(recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.DL_STABLECOINS,
      false,
    );
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
