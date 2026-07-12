import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";
import { mockRegistry, mockCircuitBreaker, mockCircuitOutcomeRecord } from "../../test-helpers/cron";

const fetchWithRetryMock = vi.fn();
const fetchJsonWithRetryMock = vi.fn(async (...args: unknown[]) => {
  const response = await fetchWithRetryMock(...args);
  if (!response) return null;
  return { response, body: await response.json() };
});
const fetchTextWithRetryMock = vi.fn(async (...args: unknown[]) => {
  const response = await fetchWithRetryMock(...args);
  if (!response) return null;
  return { response, body: await response.text() };
});

function mockFetchWithRetry(routes: Parameters<typeof mockFetch>[0]): ReturnType<typeof mockFetch> {
  const spy = mockFetch(routes, { requireMatch: true, stubGlobal: false });
  fetchWithRetryMock.mockImplementation((url: string) => spy(url));
  return spy;
}

// --- Module-level mocks ---

// Stub the stablecoins list to avoid importing the full registry
vi.mock("@shared/lib/stablecoins/registry", () => {
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
      id: "eurcv-societe-generale-forge",
      name: "EUR CoinVertible",
      symbol: "EURCV",
      geckoId: "societe-generale-forge-eurcv",
      detailProvider: "defillama",
      contracts: [
        { chain: "ethereum", address: "0x5f7827fdeb7c20b443265fc2f40845b715385ff2", decimals: 18 },
        { chain: "xrpl", address: "EURCV.XRPL", decimals: 0 },
        { chain: "stellar", address: "EURCV.STELLAR", decimals: 7 },
        { chain: "solana", address: "EURCV.SOL", decimals: 2 },
      ],
      flags: { pegCurrency: "EUR", backing: "fiat-backed", yieldBearing: false, navToken: false, governance: "centralized" },
    },
    {
      id: "tryb-bilira",
      name: "BiLira",
      symbol: "TRYB",
      geckoId: "bilira",
      llamaId: "300",
      detailProvider: "defillama",
      contracts: [
        { chain: "ethereum", address: "0x2c537e5624e4af88a7ae4060c022609376c8d0eb", decimals: 6 },
        { chain: "bsc", address: "0xc1fdbed7dac39cae2ccc0748f7a80dc446f6a594", decimals: 6 },
      ],
      flags: { pegCurrency: "TRY", backing: "fiat-backed", yieldBearing: false, navToken: false, governance: "centralized" },
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
    {
      id: "chfau-allunity",
      name: "AllUnity CHF",
      symbol: "CHFAU",
      geckoId: "allunity-chf",
      detailProvider: "coingecko",
      contracts: [{ chain: "ethereum", address: "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78", decimals: 6 }],
      flags: { pegCurrency: "CHF", backing: "rwa-backed", yieldBearing: false, navToken: false, governance: "centralized" },
    },
    {
      id: "cadd-cad-digital",
      name: "CAD Digital",
      symbol: "CADD",
      geckoId: "cad-digital",
      llamaId: "387",
      detailProvider: "defillama",
      contracts: [
        { chain: "ethereum", address: "0x16f93ebc5320c89efc8701577efe49d14a276a06", decimals: 18 },
        { chain: "base", address: "0x16f93ebc5320c89efc8701577efe49d14a276a06", decimals: 18 },
      ],
      flags: { pegCurrency: "CAD", backing: "rwa-backed", yieldBearing: false, navToken: false, governance: "centralized" },
    },
    {
      id: "jpym-mento",
      name: "Mento Japanese Yen",
      symbol: "JPYm",
      geckoId: "celo-japanese-yen",
      llamaId: "363",
      detailProvider: "defillama",
      contracts: [{ chain: "celo", address: "0xc45ecf20f3cd864b32d9794d6f76814ae8892e20", decimals: 18 }],
      flags: { pegCurrency: "JPY", backing: "crypto-backed", yieldBearing: false, navToken: false, governance: "centralized-dependent" },
    },
    {
      id: "zarm-mento",
      name: "Mento South African Rand",
      symbol: "ZARm",
      geckoId: "celo-south-african-rand",
      llamaId: "368",
      detailProvider: "defillama",
      contracts: [{ chain: "celo", address: "0x4c35853a3b4e647fd266f4de678dcc8fec410bf6", decimals: 18 }],
      flags: { pegCurrency: "ZAR", backing: "crypto-backed", yieldBearing: false, navToken: false, governance: "centralized-dependent" },
    },
    {
      id: "xofm-mento",
      name: "Mento West African CFA Franc",
      symbol: "XOFm",
      geckoId: "celo-west-african-cfa-franc",
      llamaId: "371",
      detailProvider: "defillama",
      contracts: [{ chain: "celo", address: "0x73f93dcc49cb8a239e2032663e9475dd5ef29a08", decimals: 18 }],
      flags: { pegCurrency: "XOF", backing: "crypto-backed", yieldBearing: false, navToken: false, governance: "centralized-dependent" },
    },
    {
      id: "usdk-kast",
      name: "KAST Dollar",
      symbol: "USDK",
      detailProvider: "coingecko",
      contracts: [{ chain: "solana", address: "usdkbee86pkLyRmxfFCdkyySpxRb5ndCxVsK2BkRXwX", decimals: 6 }],
      flags: { pegCurrency: "USD", backing: "rwa-backed", yieldBearing: false, navToken: false, governance: "centralized" },
    },
    {
      id: "xo-exodus",
      name: "XO Cash",
      symbol: "XO",
      geckoId: "xo-cash",
      detailProvider: "coingecko",
      contracts: [{ chain: "solana", address: "xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y", decimals: 6 }],
      flags: { pegCurrency: "USD", backing: "rwa-backed", yieldBearing: false, navToken: false, governance: "centralized" },
    },
    ...fallbackTrackedTokens,
  ];
  const trackedMetaById = new Map<string, unknown>([
    ["usdt-tether", { geckoId: "tether", cmcSlug: undefined }],
    ["usdc-circle", { geckoId: "usd-coin", cmcSlug: undefined }],
    ["eurcv-societe-generale-forge", {
      geckoId: "societe-generale-forge-eurcv",
      cmcSlug: undefined,
      contracts: [
        { chain: "ethereum", address: "0x5f7827fdeb7c20b443265fc2f40845b715385ff2", decimals: 18 },
        { chain: "xrpl", address: "EURCV.XRPL", decimals: 0 },
        { chain: "stellar", address: "EURCV.STELLAR", decimals: 7 },
        { chain: "solana", address: "EURCV.SOL", decimals: 2 },
      ],
      detailProvider: "defillama",
      flags: { navToken: false, pegCurrency: "EUR", backing: "fiat-backed", yieldBearing: false, governance: "centralized" },
    }],
    ["tryb-bilira", {
      geckoId: "bilira",
      cmcSlug: undefined,
      llamaId: "300",
      contracts: [
        { chain: "ethereum", address: "0x2c537e5624e4af88a7ae4060c022609376c8d0eb", decimals: 6 },
        { chain: "bsc", address: "0xc1fdbed7dac39cae2ccc0748f7a80dc446f6a594", decimals: 6 },
      ],
      detailProvider: "defillama",
      flags: { navToken: false, pegCurrency: "TRY", backing: "fiat-backed", yieldBearing: false, governance: "centralized" },
    }],
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
    ["chfau-allunity", {
      geckoId: "allunity-chf",
      cmcSlug: undefined,
      flags: { navToken: false },
    }],
    ["cadd-cad-digital", {
      geckoId: "cad-digital",
      cmcSlug: undefined,
      llamaId: "387",
      detailProvider: "defillama",
      contracts: [
        { chain: "ethereum", address: "0x16f93ebc5320c89efc8701577efe49d14a276a06", decimals: 18 },
        { chain: "base", address: "0x16f93ebc5320c89efc8701577efe49d14a276a06", decimals: 18 },
      ],
      flags: { navToken: false, pegCurrency: "CAD", backing: "rwa-backed", yieldBearing: false, governance: "centralized" },
    }],
    ["jpym-mento", {
      geckoId: "celo-japanese-yen",
      cmcSlug: undefined,
      llamaId: "363",
      detailProvider: "defillama",
      contracts: [{ chain: "celo", address: "0xc45ecf20f3cd864b32d9794d6f76814ae8892e20", decimals: 18 }],
      flags: { navToken: false, pegCurrency: "JPY", backing: "crypto-backed", yieldBearing: false, governance: "centralized-dependent" },
    }],
    ["zarm-mento", {
      geckoId: "celo-south-african-rand",
      cmcSlug: undefined,
      llamaId: "368",
      detailProvider: "defillama",
      contracts: [{ chain: "celo", address: "0x4c35853a3b4e647fd266f4de678dcc8fec410bf6", decimals: 18 }],
      flags: { navToken: false, pegCurrency: "ZAR", backing: "crypto-backed", yieldBearing: false, governance: "centralized-dependent" },
    }],
    ["xofm-mento", {
      geckoId: "celo-west-african-cfa-franc",
      cmcSlug: undefined,
      llamaId: "371",
      detailProvider: "defillama",
      contracts: [{ chain: "celo", address: "0x73f93dcc49cb8a239e2032663e9475dd5ef29a08", decimals: 18 }],
      flags: { navToken: false, pegCurrency: "XOF", backing: "crypto-backed", yieldBearing: false, governance: "centralized-dependent" },
    }],
    ["usdk-kast", {
      geckoId: undefined,
      cmcSlug: undefined,
      detailProvider: "coingecko",
      contracts: [{ chain: "solana", address: "usdkbee86pkLyRmxfFCdkyySpxRb5ndCxVsK2BkRXwX", decimals: 6 }],
      flags: { navToken: false, pegCurrency: "USD", backing: "rwa-backed", yieldBearing: false, governance: "centralized" },
    }],
    ["xo-exodus", {
      geckoId: "xo-cash",
      cmcSlug: undefined,
      detailProvider: "coingecko",
      contracts: [{ chain: "solana", address: "xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y", decimals: 6 }],
      flags: { navToken: false, pegCurrency: "USD", backing: "rwa-backed", yieldBearing: false, governance: "centralized" },
    }],
    ["ggbr-goldfish-gold", {
      geckoId: "goldfish-gold",
      cmcSlug: undefined,
      commodityOunces: 0.001,
      flags: { navToken: false },
    }],
  ]);
  return mockRegistry({ stablecoins, trackedMetaById });
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

// Stub fetch-retry to delegate to global fetch
vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
  fetchJsonWithRetry: (...args: unknown[]) => fetchJsonWithRetryMock(...args),
  fetchTextWithRetry: (...args: unknown[]) => fetchTextWithRetryMock(...args),
}));

// Stub circuit-breaker
vi.mock("../../lib/circuit-breaker", () => mockCircuitBreaker());

// Stub coingecko helpers
vi.mock("../../lib/coingecko", () => ({
  cgUrl: vi.fn((path: string) => `https://api.coingecko.com${path}`),
  cgHeaders: vi.fn((extra: Record<string, string>) => extra),
}));

// Stub alerts
vi.mock("../../lib/alerts", () => ({
  sendAlert: vi.fn(async () => true),
}));

// Coverage completeness is exercised in stablecoin-publication-coverage.test.ts.
// This suite isolates pricing/publication mechanics with intentionally partial fixtures.
vi.mock("../../lib/stablecoin-publication-coverage", () => ({
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
}));

import { syncStablecoins } from "../sync-stablecoins";
import { stampPriceMetadata } from "../sync-stablecoins/shared";
import { enrichMissingPrices, fetchPrimaryPrices, runGtProbePass, type PrimaryPriceResult } from "../sync-stablecoins/enrich-prices";
import type { PeggedAsset } from "../sync-stablecoins/enrich-prices";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { detectDepegEvents } from "../detect-depegs";
import { confirmPendingDepegs } from "../confirm-pending-depegs";
import { fetchAuthoritativeLivePriceOverrides } from "../../lib/authoritative-price-sources";
import { sendAlert } from "../../lib/alerts";
import * as apiUtils from "../../lib/api-utils";
import * as evmRpcModule from "../../lib/evm-rpc";

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
    vi.mocked(recordOutcome).mockReset().mockResolvedValue(mockCircuitOutcomeRecord());
    fetchWithRetryMock.mockReset();
    fetchJsonWithRetryMock.mockClear();
    fetchTextWithRetryMock.mockClear();
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

    mockFetchWithRetry([
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
    );
    expect(detectDepegEvents).toHaveBeenCalledWith(db, expect.any(Array), undefined, undefined, undefined);
    expect(confirmPendingDepegs).toHaveBeenCalledWith(
      db,
      expect.any(Array),
      undefined,
      undefined,
      undefined,
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

    mockFetchWithRetry([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

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

  it("runs missing-price enrichment before the GT probe", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);
    const order: string[] = [];

    vi.mocked(enrichMissingPrices).mockImplementationOnce(async () => {
      order.push("enrich");
      return {
        totalMissing: 0, pass1: 0, pass1b: 0, passCmc: 0, passJupiter: 0, passDex: 0, passCgLowVolume: 0, finalMissing: 0, failedPasses: [],
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

    mockFetchWithRetry([
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

    mockFetchWithRetry([
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

    mockFetchWithRetry([
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

    mockFetchWithRetry([
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
        consensusSources: string[];
        agreeSources: string[];
      }>;
    };
    const cusd = cached.peggedAssets.find((asset) => asset.id === "cusd-cap");
    expect(cusd).toMatchObject({
      id: "cusd-cap",
      priceSource: "protocol-redeem",
      priceConfidence: "high",
      consensusSources: ["protocol-redeem"],
      agreeSources: ["protocol-redeem"],
    });
    expect(cusd?.price).toBeCloseTo(0.99999266, 8);
  });

  it("applies protocol-backed overrides before missing-price fallback enrichment", async () => {
    const db = makeDb();
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
    vi.mocked(enrichMissingPrices).mockImplementationOnce(async (assets) => {
      const cusd = assets.find((asset) => asset.id === "cusd-cap");
      expect(cusd).toMatchObject({
        price: 0.99999266,
        priceSource: "protocol-redeem",
        priceConfidence: "high",
      });
      return {
        totalMissing: 0,
        pass1: 0,
        pass1b: 0,
        passCmc: 0,
        passJupiter: 0,
        passDex: 0,
        passCgLowVolume: 0,
        finalMissing: 0,
        failedPasses: [],
      };
    });

    mockFetchWithRetry([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("ok");
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

    mockFetchWithRetry([
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

    mockFetchWithRetry([
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

  it("keeps severe downside primary prices when multiple candidate sources corroborate downside", async () => {
    const db = makeDb();
    const writes = trackCacheWrites(db);
    const dlData = makeDlResponse(60);
    dlData.peggedAssets[0] = {
      ...dlData.peggedAssets[0],
      id: "usdt-tether",
      name: "Tether",
      symbol: "USDT",
      price: 0.154,
      priceSource: "defillama",
      priceConfidence: "single-source",
      circulating: { peggedUSD: 100_000_000 },
    } as unknown as (typeof dlData.peggedAssets)[0];

    vi.mocked(fetchPrimaryPrices).mockResolvedValueOnce({
      results: new Map([
        [
          "usdt-tether",
          {
            price: 0.151,
            source: "pyth",
            confidence: "low",
            dlPrice: 0.154,
            cgPrice: 0.153,
            candidateSources: ["coingecko", "defillama-list", "pyth"],
            agreeSources: ["pyth"],
            disagreeSources: ["coingecko", "defillama-list"],
            allPrices: {
              coingecko: 0.153,
              "defillama-list": 0.154,
              pyth: 0.151,
            },
            observedAt: 1_750_000_000,
            observedAtMode: "upstream",
            observedAtBySource: {
              coingecko: 1_750_000_000,
              "defillama-list": null,
              pyth: 1_750_000_000,
            },
            observedAtModeBySource: {
              coingecko: "upstream",
              "defillama-list": "unknown",
              pyth: "upstream",
            },
          },
        ],
      ]),
      stats: { attempted: 1, high: 0, singleSource: 0, cgOnly: 0, low: 1 },
      cgPrices: new Map([["tether", 0.153]]),
    });

    mockFetchWithRetry([
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
        consensusSources: string[];
        agreeSources: string[];
      }>;
    };
    const usdt = cached.peggedAssets.find((asset) => asset.id === "usdt-tether");
    expect(usdt).toMatchObject({
      id: "usdt-tether",
      price: 0.151,
      priceSource: "pyth",
      priceConfidence: "low",
      consensusSources: ["coingecko", "defillama-list", "pyth"],
      agreeSources: ["pyth"],
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

    mockFetchWithRetry([
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

    mockFetchWithRetry([
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
      priceObservedAt: nowSec - 120,
      priceSyncedAt: nowSec - 135,
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

    mockFetchWithRetry([
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

  it("runs depeg detection after successful DL sync", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);

    mockFetchWithRetry([
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

    mockFetchWithRetry([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

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

  it("drops malformed assets missing required fields", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(55);
    // Add some malformed assets
    dlData.peggedAssets.push(
      { id: null, name: "bad1", symbol: "BAD1", price: 1, pegType: "peggedUSD", circulating: { peggedUSD: 100 }, chainCirculating: {}, chains: [] } as unknown as (typeof dlData.peggedAssets)[0],
      { id: "999", name: null, symbol: "BAD2", price: 1, pegType: "peggedUSD", circulating: { peggedUSD: 100 }, chainCirculating: {}, chains: [] } as unknown as (typeof dlData.peggedAssets)[0],
    );

    mockFetchWithRetry([
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

    mockFetchWithRetry([
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
    expect(metadata.casSkipped).toBe(false);
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
      undefined,
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

    mockFetchWithRetry([
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

    mockFetchWithRetry([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

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
    const cgData: Record<string, { usd: number; usd_market_cap: number }> = {};
    for (let i = 0; i < 60; i++) {
      cgData[`fallback-coin-${i}`] = { usd: 1, usd_market_cap: 1_000_000 + i };
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

    mockFetchWithRetry([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    await syncStablecoins(db);

    expect(recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      "defillama-stablecoins",
      true,
      undefined,
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

    mockFetchWithRetry([
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

    mockFetchWithRetry([
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
    const nowSec = Math.floor(Date.now() / 1000);
    const previousPayload = JSON.stringify({
      peggedAssets: dlData.peggedAssets.map((a) => ({
        id: a.id,
        price: a.price,
        priceSource: a.priceSource,
        priceConfidence: "single-source",
        priceUpdatedAt: nowSec,
        priceObservedAt: nowSec,
        priceSyncedAt: nowSec,
      })),
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

    mockFetchWithRetry([
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
    const nowSec = Math.floor(Date.now() / 1000);
    const previousPayload = JSON.stringify({
      peggedAssets: dlData.peggedAssets.map((a) => ({
        id: a.id,
        price: a.price,
        priceSource: a.priceSource,
        priceConfidence: "single-source",
        priceUpdatedAt: nowSec,
        priceObservedAt: nowSec,
        priceSyncedAt: nowSec,
      })),
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

    mockFetchWithRetry([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("degraded");
    expect(cacheWrites.map((write) => write.key)).not.toContain("stablecoins");
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.DL_STABLECOINS,
      false,
      undefined,
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

    mockFetchWithRetry([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db, controller.signal, { reportProgress });

    expect(result.aborted).toBe(true);
    expect(vi.mocked(recordOutcome).mock.calls.some((call) => (
      call[1] === CIRCUIT_SOURCE.DL_STABLECOINS && call[2] === false
    ))).toBe(false);
  });

  it("degrades cleanly when the previous stablecoins cache is malformed", async () => {
    const dlData = makeDlResponse(60);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [{ value: "{not-json", updated_at: Math.floor(Date.now() / 1000) - (8 * 3600) }],
        first: { value: "{not-json", updated_at: Math.floor(Date.now() / 1000) - (8 * 3600) },
      },
      { match: "supply_history", rows: [] },
      { match: "price_cache", rows: [] },
      { match: "circuit", rows: [] },
      { match: "cache", rows: [] },
    ]);
    const cacheWrites = trackCacheWrites(db);

    mockFetchWithRetry([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.itemCount).toBe(60);
    expect(result.status).toBe("degraded");
    expect(cacheWrites.map((write) => write.key)).toContain("stablecoins");
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata).toMatchObject({
      stalenessCheckFailed: true,
      stalenessCheckFailureReason: "malformed-previous-cache",
      cacheWriteSucceeded: true,
      downstreamSafe: true,
      capabilities: {
        stablecoinsCache: true,
      },
    });
  });

  it("degrades and publishes when the staleness cache read fails", async () => {
    const dlData = makeDlResponse(60);
    const db = mockD1([
      { match: "supply_history", rows: [] },
      { match: "price_cache", rows: [] },
      { match: "circuit", rows: [] },
      { match: "cache", rows: [] },
    ]);
    let stablecoinsCacheReads = 0;
    const originalPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      const statement = originalPrepare(sql);
      if (!sql.includes("SELECT value, updated_at FROM cache WHERE key = ?")) {
        return statement;
      }
      return {
        ...statement,
        bind: (...args: unknown[]) => {
          const bound = statement.bind(...args);
          if (args[0] !== "stablecoins") return bound;
          return {
            ...bound,
            first: async <T>() => {
              stablecoinsCacheReads++;
              if (stablecoinsCacheReads >= 2) {
                throw new Error("cache read failed");
              }
              return bound.first<T>();
            },
          };
        },
      } as typeof statement;
    }) as typeof db.prepare;
    const cacheWrites = trackCacheWrites(db);

    mockFetchWithRetry([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(60);
    expect(cacheWrites.map((write) => write.key)).toContain("stablecoins");
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata).toMatchObject({
      stalenessCheckFailed: true,
      stalenessCheckFailureReason: "cache read failed",
      cacheWriteSucceeded: true,
      downstreamSafe: true,
      capabilities: {
        stablecoinsCache: true,
      },
    });
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

    mockFetchWithRetry([
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
        match: "SELECT asset_id, price, updated_at, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json FROM price_cache",
        rows: [{ asset_id: "usdt-tether", price: 0.999, updated_at: nowSec - 60, source: null, confidence: null, observed_at: null, observed_at_mode: null, synced_at: null, agree_sources_json: null, consensus_sources_json: null }],
      },
      { match: "cache", rows: [] },
      { match: "supply_history", rows: [] },
      { match: "circuit", rows: [] },
      { match: "price_cache", rows: [] },
    ]);

    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");

    mockFetchWithRetry([
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

    mockFetchWithRetry([
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
        match: "SELECT asset_id, price, updated_at, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json FROM price_cache",
        rows: [{ asset_id: "usdt-tether", price: 0.999, updated_at: nowSec - (7 * 3600), source: null, confidence: null, observed_at: null, observed_at_mode: null, synced_at: null, agree_sources_json: null, consensus_sources_json: null }],
      },
      { match: "cache", rows: [] },
      { match: "supply_history", rows: [] },
      { match: "circuit", rows: [] },
      { match: "price_cache", rows: [] },
    ]);

    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");

    mockFetchWithRetry([
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

    mockFetchWithRetry([
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

    mockFetchWithRetry([
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

  it("reconciles tracked DefiLlama supply gaps from CoinGecko history when tracked deployments are missing", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);
    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");

    dlData.peggedAssets[0] = {
      id: "eurcv-societe-generale-forge",
      name: "EUR CoinVertible",
      symbol: "EURCV",
      geckoId: "societe-generale-forge-eurcv",
      price: 1.146,
      priceSource: "defillama",
      priceConfidence: "single-source",
      supplySource: "defillama",
      pegType: "peggedEUR",
      pegMechanism: "fiat-backed",
      circulating: { peggedEUR: 76_959_279.2855894 },
      circulatingPrevDay: { peggedEUR: 76_452_843.42798373 },
      circulatingPrevWeek: { peggedEUR: 77_730_394.74632101 },
      circulatingPrevMonth: { peggedEUR: 64_940_946.17329877 },
      chainCirculating: {
        Ethereum: {
          current: { peggedEUR: 65_558_870.064894676 },
          circulatingPrevDay: { peggedEUR: 65_052_434.20728901 },
          circulatingPrevWeek: { peggedEUR: 66_329_985.525626294 },
          circulatingPrevMonth: { peggedEUR: 53_540_536.95260405 },
        },
        Solana: {
          current: { peggedEUR: 11_400_409.220694723 },
          circulatingPrevDay: { peggedEUR: 11_400_409.220694723 },
          circulatingPrevWeek: { peggedEUR: 11_400_409.220694723 },
          circulatingPrevMonth: { peggedEUR: 11_400_409.220694723 },
        },
      },
      chains: ["Ethereum", "Solana"],
    } as unknown as (typeof dlData.peggedAssets)[0];

    const nowMs = Date.now();
    mockFetchWithRetry([
      {
        match: "simple/price?ids=societe-generale-forge-eurcv",
        body: {
          "societe-generale-forge-eurcv": {
            usd: 1.14,
            usd_market_cap: 106_720_303.28574413,
          },
        },
      },
      {
        match: "coins/societe-generale-forge-eurcv/market_chart",
        body: {
          market_caps: [
            [nowMs - (30 * 24 * 60 * 60 * 1000), 101_100_000],
            [nowMs - (7 * 24 * 60 * 60 * 1000), 105_500_000],
            [nowMs - (24 * 60 * 60 * 1000), 106_300_000],
            [nowMs, 106_720_303.28574413],
          ],
        },
      },
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("ok");

    const finalValidationCall = validateSpy.mock.calls.find(
      (call) => call[2] === "sync-stablecoins:stablecoins",
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<Record<string, unknown>> } | undefined;
    const eurcv = payload?.peggedAssets.find((asset) => asset.id === "eurcv-societe-generale-forge");

    expect(eurcv).toBeDefined();
    expect(eurcv?.supplySource).toBe("coingecko-gap-fill");
    expect(eurcv?.circulating).toEqual({ peggedEUR: 106_720_303.28574413 });
    expect(eurcv?.circulatingPrevDay).toEqual({ peggedEUR: 106_300_000 });
    expect(eurcv?.circulatingPrevWeek).toEqual({ peggedEUR: 105_500_000 });
    expect(eurcv?.circulatingPrevMonth).toEqual({ peggedEUR: 101_100_000 });
    expect(eurcv?.chains).toEqual(["Ethereum", "Solana", "XRP Ledger", "Stellar"]);
    expect(Object.keys((eurcv?.chainCirculating as Record<string, unknown>) ?? {})).toEqual(["Ethereum", "Solana"]);
  });

  it("reconciles tracked zero-supply collapses from DefiLlama chart history", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);
    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");
    const nowMs = Date.now();

    dlData.peggedAssets[0] = {
      id: "tryb-bilira",
      name: "Bilira",
      symbol: "TRYB",
      geckoId: "bilira",
      price: 0.0224,
      priceSource: "defillama",
      priceConfidence: "single-source",
      supplySource: "defillama",
      pegType: "peggedTRY",
      pegMechanism: "fiat-backed",
      circulating: { peggedTRY: 0 },
      circulatingPrevDay: { peggedTRY: 0 },
      circulatingPrevWeek: { peggedTRY: 0 },
      circulatingPrevMonth: { peggedTRY: 0 },
      chainCirculating: {
        BSC: {
          current: { peggedTRY: 0 },
          circulatingPrevDay: { peggedTRY: 0 },
          circulatingPrevWeek: { peggedTRY: 0 },
          circulatingPrevMonth: { peggedTRY: 0 },
        },
        Ethereum: {
          current: { peggedTRY: 0 },
          circulatingPrevDay: { peggedTRY: 0 },
          circulatingPrevWeek: { peggedTRY: 0 },
          circulatingPrevMonth: { peggedTRY: 0 },
        },
      },
      chains: ["BSC", "Ethereum"],
    } as unknown as (typeof dlData.peggedAssets)[0];

    mockFetchWithRetry([
      {
        match: "simple/price?ids=bilira",
        body: {
          bilira: {
            usd: 0.02243281,
            usd_market_cap: 5_125_478,
          },
        },
      },
      {
        match: "stablecoincharts/all?stablecoin=300",
        body: [
          { date: Math.floor((nowMs - (30 * 24 * 60 * 60 * 1000)) / 1000), totalCirculatingUSD: { peggedTRY: 14_800_000 } },
          { date: Math.floor((nowMs - (7 * 24 * 60 * 60 * 1000)) / 1000), totalCirculatingUSD: { peggedTRY: 15_100_000 } },
          { date: Math.floor((nowMs - (24 * 60 * 60 * 1000)) / 1000), totalCirculatingUSD: { peggedTRY: 15_220_000 } },
          { date: Math.floor(nowMs / 1000), totalCirculatingUSD: { peggedTRY: 15_260_000 } },
        ],
      },
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("ok");

    const finalValidationCall = validateSpy.mock.calls.find(
      (call) => call[2] === "sync-stablecoins:stablecoins",
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<Record<string, unknown>> } | undefined;
    const tryb = payload?.peggedAssets.find((asset) => asset.id === "tryb-bilira");

    expect(tryb).toBeDefined();
    expect(tryb?.supplySource).toBe("defillama-history-gap-fill");
    expect(tryb?.circulating).toEqual({ peggedTRY: 15_260_000 });
    expect(tryb?.circulatingPrevDay).toEqual({ peggedTRY: 15_220_000 });
    expect(tryb?.circulatingPrevWeek).toEqual({ peggedTRY: 15_100_000 });
    expect(tryb?.circulatingPrevMonth).toEqual({ peggedTRY: 14_800_000 });
  });

  it("repairs curated zero-supply DefiLlama rows from on-chain supply and FX references", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({
            peggedCAD: 0.73,
            peggedCHF: 1.20,
            peggedJPY: 0.00628,
            peggedZAR: 0.0608,
            peggedXOF: 0.00172,
          }),
          updated_at: nowSec - 60,
        },
      },
      { match: "cache", rows: [] },
      { match: "supply_history", rows: [] },
      { match: "price_cache", rows: [] },
      { match: "circuit", rows: [] },
    ]);
    const dlData = makeDlResponse(60);
    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");
    const evmSupplyByAddress = new Map<string, bigint>([
      ["0x16f93ebc5320c89efc8701577efe49d14a276a06", 270_650_000_000_000_000_000_000n],
      ["base:0x16f93ebc5320c89efc8701577efe49d14a276a06", 260_100_000_000_000_000_000_000n],
      ["0xc45ecf20f3cd864b32d9794d6f76814ae8892e20", 16_501_134_892_552_301_307_041_485n],
      ["0x4c35853a3b4e647fd266f4de678dcc8fec410bf6", 141_426_024_661_407_895_821_776n],
      ["0x73f93dcc49cb8a239e2032663e9475dd5ef29a08", 19_186_522_679_089_184_899_615_544n],
    ]);
    const evmSupplySpy = vi.spyOn(evmRpcModule, "fetchEvmUint256AtBlock")
      .mockImplementation(async (chain, to) => {
        const address = String(to).toLowerCase();
        return evmSupplyByAddress.get(`${chain}:${address}`) ?? evmSupplyByAddress.get(address) ?? null;
      });

    const zeroRows = [
      {
        id: "387",
        canonicalId: "cadd-cad-digital",
        name: "CAD Digital",
        symbol: "CADD",
        geckoId: "cad-digital",
        pegType: "peggedCAD",
        pegMechanism: "rwa-backed",
        chains: ["Ethereum", "Base"],
        chainCirculating: {
          Ethereum: { current: { peggedCAD: 0 }, circulatingPrevDay: { peggedCAD: 0 }, circulatingPrevWeek: { peggedCAD: 0 }, circulatingPrevMonth: { peggedCAD: 0 } },
          Base: { current: { peggedCAD: 0 }, circulatingPrevDay: { peggedCAD: 0 }, circulatingPrevWeek: { peggedCAD: 0 }, circulatingPrevMonth: { peggedCAD: 0 } },
        },
      },
      {
        id: "363",
        canonicalId: "jpym-mento",
        name: "Mento Japanese Yen",
        symbol: "JPYm",
        geckoId: "celo-japanese-yen",
        pegType: "peggedCHF",
        pegMechanism: "crypto-backed",
        chains: ["Celo"],
        chainCirculating: {
          Celo: { current: { peggedCHF: 0 }, circulatingPrevDay: { peggedCHF: 0 }, circulatingPrevWeek: { peggedCHF: 0 }, circulatingPrevMonth: { peggedCHF: 0 } },
        },
      },
      {
        id: "368",
        canonicalId: "zarm-mento",
        name: "Mento South African Rand",
        symbol: "ZARm",
        geckoId: "celo-south-african-rand",
        pegType: "peggedZAR",
        pegMechanism: "crypto-backed",
        chains: ["Celo"],
        chainCirculating: {
          Celo: { current: { peggedZAR: 0 }, circulatingPrevDay: { peggedZAR: 0 }, circulatingPrevWeek: { peggedZAR: 0 }, circulatingPrevMonth: { peggedZAR: 0 } },
        },
      },
      {
        id: "371",
        canonicalId: "xofm-mento",
        name: "Mento West African CFA Franc",
        symbol: "XOFm",
        geckoId: "celo-west-african-cfa-franc",
        pegType: "peggedXOF",
        pegMechanism: "crypto-backed",
        chains: ["Celo"],
        chainCirculating: {
          Celo: { current: { peggedXOF: 0 }, circulatingPrevDay: { peggedXOF: 0 }, circulatingPrevWeek: { peggedXOF: 0 }, circulatingPrevMonth: { peggedXOF: 0 } },
        },
      },
    ];
    zeroRows.forEach((row, index) => {
      dlData.peggedAssets[index] = {
        id: row.id,
        name: row.name,
        symbol: row.symbol,
        geckoId: row.geckoId,
        price: null,
        priceSource: "defillama",
        priceConfidence: null,
        supplySource: "defillama",
        pegType: row.pegType,
        pegMechanism: row.pegMechanism,
        circulating: { [row.pegType]: 0 },
        circulatingPrevDay: { [row.pegType]: 0 },
        circulatingPrevWeek: { [row.pegType]: 0 },
        circulatingPrevMonth: { [row.pegType]: 0 },
        chainCirculating: row.chainCirculating,
        chains: row.chains,
      } as unknown as (typeof dlData.peggedAssets)[0];
    });
    vi.mocked(fetchAuthoritativeLivePriceOverrides).mockResolvedValue(new Map([
      ["cadd-cad-digital", { price: 0.73, source: "protocol-redeem", confidence: "high", observedAt: nowSec - 60, observedAtMode: "upstream" }],
      ["jpym-mento", { price: 0.00628, source: "protocol-redeem", confidence: "high", observedAt: nowSec - 60, observedAtMode: "upstream" }],
      ["zarm-mento", { price: 0.0608, source: "protocol-redeem", confidence: "high", observedAt: nowSec - 60, observedAtMode: "upstream" }],
      ["xofm-mento", { price: 0.00172, source: "protocol-redeem", confidence: "high", observedAt: nowSec - 60, observedAtMode: "upstream" }],
    ]));

    mockFetchWithRetry([
      { match: "api.coingecko.com", body: {} },
      { match: "stablecoincharts/all", body: [] },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("ok");
    expect(evmSupplySpy).toHaveBeenCalledWith(
      "ethereum",
      "0x16f93ebc5320c89efc8701577efe49d14a276a06",
      "0x18160ddd",
      "latest",
      expect.any(Object),
    );
    expect(evmSupplySpy).toHaveBeenCalledWith(
      "base",
      "0x16f93ebc5320c89efc8701577efe49d14a276a06",
      "0x18160ddd",
      "latest",
      expect.any(Object),
    );

    const finalValidationCall = validateSpy.mock.calls.find(
      (call) => call[2] === "sync-stablecoins:stablecoins",
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<Record<string, unknown>> } | undefined;
    const byId = new Map(payload?.peggedAssets.map((asset) => [asset.id, asset]) ?? []);
    const cadd = byId.get("cadd-cad-digital");
    const jpym = byId.get("jpym-mento");
    const zarm = byId.get("zarm-mento");
    const xofm = byId.get("xofm-mento");

    expect(cadd).toMatchObject({ supplySource: "onchain-total-supply", priceSource: "protocol-redeem", priceConfidence: "high", price: 0.73 });
    expect((cadd?.circulating as Record<string, number> | undefined)?.peggedCAD).toBeCloseTo(387_447.5, 6);
    expect((cadd?.chainCirculating as Record<string, { current: number }> | undefined)?.Ethereum.current).toBeCloseTo(197_574.5, 6);
    expect((cadd?.chainCirculating as Record<string, { current: number }> | undefined)?.Base.current).toBeCloseTo(189_873, 6);
    expect(jpym).toMatchObject({ supplySource: "onchain-total-supply", priceSource: "protocol-redeem", priceConfidence: "high", price: 0.00628 });
    expect((jpym?.circulating as Record<string, number> | undefined)?.peggedJPY).toBeCloseTo(103_627.12712522845, 6);
    expect((jpym?.circulating as Record<string, number> | undefined)?.peggedCHF).toBeUndefined();
    expect(zarm).toMatchObject({ supplySource: "onchain-total-supply", priceSource: "protocol-redeem", priceConfidence: "high", price: 0.0608 });
    expect((zarm?.circulating as Record<string, number> | undefined)?.peggedZAR).toBeCloseTo(8_598.7022994136, 6);
    expect(xofm).toMatchObject({ supplySource: "onchain-total-supply", priceSource: "protocol-redeem", priceConfidence: "high", price: 0.00172 });
    expect((xofm?.circulating as Record<string, number> | undefined)?.peggedXOF).toBeCloseTo(33_000.819008033395, 6);
    expect((xofm?.chainCirculating as Record<string, { current: number }> | undefined)?.Celo.current).toBeCloseTo(33_000.819008033395, 6);
  });

  it("adds tracked gold supplemental assets when DefiLlama price data is empty but CoinGecko still has price and market cap", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);
    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");

    mockFetchWithRetry([
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

    mockFetchWithRetry([
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
              timestamp: Math.floor(Date.now() / 1000) - 60,
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

    const fetchSpy = mockFetchWithRetry([
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

  it("keeps preview-only fiat CoinGecko assets in coverage via on-chain supply and FX normalization", async () => {
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
        first: { value: JSON.stringify({ peggedCHF: 1.14 }), updated_at: nowSec - 60 },
      },
      { match: "INSERT INTO cache", rows: [], runMeta: { changes: 1 } },
      { match: "supply_history", rows: [] },
      { match: "price_cache", rows: [] },
      { match: "circuit", rows: [] },
    ]);
    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");
    const evmSupplySpy = vi.spyOn(evmRpcModule, "fetchEvmUint256AtBlock")
      .mockResolvedValueOnce(1_500_000_000_000n);

    const dlData = makeDlResponse(60);
    mockFetchWithRetry([
      { match: "api.coingecko.com", body: { "allunity-chf": {} } },
      { match: "stablecoins.llama.fi", body: dlData },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(61);
    expect(evmSupplySpy).toHaveBeenCalledWith(
      "ethereum",
      "0xbd4dfc058eb95b8de5ceaf39966a1a70f5556f78",
      "0x18160ddd",
      "latest",
      expect.any(Object),
    );

    const finalValidationCall = validateSpy.mock.calls.find(
      (call) => call[2] === "sync-stablecoins:stablecoins",
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<Record<string, unknown>> } | undefined;
    const chfau = payload?.peggedAssets.find((asset) => asset.id === "chfau-allunity");

    expect(chfau).toBeDefined();
    expect(chfau?.price).toBeNull();
    expect(chfau?.priceSource).toBe("missing");
    expect(chfau?.priceConfidence).toBeNull();
    expect(chfau?.supplySource).toBe("onchain-total-supply");
    expect((chfau?.circulating as Record<string, number> | undefined)?.peggedCHF).toBeCloseTo(1_710_000, 6);
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
        match: "SELECT asset_id, price, updated_at, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json FROM price_cache",
        rows: [{ asset_id: "fb-0", price: 1.01, updated_at: nowSec - 120, source: null, confidence: null, observed_at: null, observed_at_mode: null, synced_at: null, agree_sources_json: null, consensus_sources_json: null }],
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

    mockFetchWithRetry([
      { match: "api.coingecko.com/simple/price", body: cgBody },
      { match: "stablecoins.llama.fi", body: { error: "upstream" }, status: 500 },
      { match: "coins.llama.fi/prices", body: { coins: {} } },
      { match: "api.llama.fi/protocol/pleasing-gold", body: { mcap: null, tvl: [] } },
    ]);

    const result = await syncStablecoins(db);

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(60);
    expect(confirmPendingDepegs).toHaveBeenCalledWith(
      db,
      expect.any(Array),
      { peggedUSD: 1 },
      undefined,
      undefined,
      undefined,
    );

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
      (entry) => entry.sql.includes("INSERT INTO price_cache"),
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

    mockFetchWithRetry([
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
    mockFetchWithRetry([
      { match: "api.coingecko.com/simple/price", body: { error: "cg down" }, status: 500 },
      { match: "stablecoins.llama.fi", body: dlData },
      {
        match: "coins.llama.fi/prices",
        body: {
          coins: {
            "coingecko:gold-token-sa-dgld-tokenized-gold": {
              price: 10_700,
              symbol: "DGLD",
              timestamp: nowSec - 60,
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
    expect(dgld?.supplyObservedAt).toBe(nowSec - 300);
    expect(dgld?.supplyRestored).toBe(true);
    expect(dgld?.circulating).toEqual({ peggedGOLD: 16_985_391.664749127 });
  });

  it("admits Solana-only supplemental fiat assets after falling through to the third Solana RPC endpoint", async () => {
    const db = makeDb();
    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");
    const dlData = makeDlResponse(60);

    fetchWithRetryMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes("api.coingecko.com")) {
        return new Response(JSON.stringify({ "xo-cash": {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("stablecoins.llama.fi")) {
        return new Response(JSON.stringify(dlData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("coins.llama.fi/prices")) {
        return new Response(JSON.stringify({ coins: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("api.mainnet-beta.solana.com") || url.includes("api.mainnet.solana.com")) {
        return new Response(JSON.stringify({ error: "upstream unavailable" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("solana-rpc.publicnode.com")) {
        const body = JSON.parse(String(options?.body ?? "{}")) as { params?: unknown[] };
        const mint = String(body.params?.[0] ?? "");
        const amount =
          mint === "usdkbee86pkLyRmxfFCdkyySpxRb5ndCxVsK2BkRXwX"
            ? "24038912803829"
            : mint === "xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y"
              ? "1609836374719"
              : null;

        if (!amount) {
          return new Response(JSON.stringify({ error: "unknown mint" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { value: { amount } },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await syncStablecoins(db);

    expect(result.status).toBe("ok");
    const finalValidationCall = validateSpy.mock.calls.find(
      (call) => call[2] === "sync-stablecoins:stablecoins",
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<Record<string, unknown>> } | undefined;
    const usdk = payload?.peggedAssets.find((asset) => asset.id === "usdk-kast");
    const xo = payload?.peggedAssets.find((asset) => asset.id === "xo-exodus");

    expect(fetchWithRetryMock.mock.calls.some(
      ([url]) => String(url).includes("solana-rpc.publicnode.com"),
    )).toBe(true);
    expect(usdk).toMatchObject({
      supplySource: "onchain-total-supply",
      price: null,
      priceSource: "missing",
      chains: ["Solana"],
    });
    expect((usdk?.circulating as Record<string, number> | undefined)?.peggedUSD).toBeCloseTo(24_038_912.803829, 6);
    expect(xo).toMatchObject({
      supplySource: "onchain-total-supply",
      price: null,
      priceSource: "missing",
      chains: ["Solana"],
    });
    expect((xo?.circulating as Record<string, number> | undefined)?.peggedUSD).toBeCloseTo(1_609_836.374719, 6);
  });

  it("restores last-known-good supplemental supply for coingecko detail-provider assets without a geckoId", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const previousStablecoinsPayload = {
      peggedAssets: [
        {
          id: "usdk-kast",
          name: "KAST Dollar",
          symbol: "USDK",
          geckoId: null,
          pegType: "peggedUSD",
          pegMechanism: "rwa-backed",
          price: null,
          priceSource: "missing",
          priceConfidence: null,
          priceUpdatedAt: null,
          supplySource: "onchain-total-supply",
          supplyObservedAt: nowSec - 600,
          circulating: { peggedUSD: 24_038_912.803829 },
          circulatingPrevDay: {},
          circulatingPrevWeek: {},
          circulatingPrevMonth: {},
          chainCirculating: {},
          chains: ["Solana"],
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
      { match: "circuit", rows: [] },
    ]);
    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");
    const dlData = makeDlResponse(60);

    fetchWithRetryMock.mockImplementation(async (url: string) => {
      if (url.includes("api.coingecko.com")) {
        return new Response(JSON.stringify({ "xo-cash": {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("stablecoins.llama.fi")) {
        return new Response(JSON.stringify(dlData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("coins.llama.fi/prices")) {
        return new Response(JSON.stringify({ coins: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        url.includes("api.mainnet-beta.solana.com") ||
        url.includes("api.mainnet.solana.com") ||
        url.includes("solana-rpc.publicnode.com")
      ) {
        return new Response(JSON.stringify({ error: "upstream unavailable" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await syncStablecoins(db);

    expect(result.status).toBe("ok");
    const finalValidationCall = validateSpy.mock.calls.find(
      (call) => call[2] === "sync-stablecoins:stablecoins",
    );
    const payload = finalValidationCall?.[1] as { peggedAssets: Array<Record<string, unknown>> } | undefined;
    const usdk = payload?.peggedAssets.find((asset) => asset.id === "usdk-kast");

    expect(usdk).toMatchObject({
      supplySource: "onchain-total-supply",
      supplyObservedAt: nowSec - 600,
      supplyRestored: true,
      price: null,
      priceSource: "missing",
      chains: ["Solana"],
    });
    expect((usdk?.circulating as Record<string, number> | undefined)?.peggedUSD).toBeCloseTo(24_038_912.803829, 6);
  });

  it("dedupes duplicate canonical IDs after DefiLlama remap", async () => {
    const db = makeDb();
    const dlData = makeDlResponse(60);
    dlData.peggedAssets[1].id = "1"; // duplicate DefiLlama ID, maps to usdt-tether

    const validateSpy = vi.spyOn(apiUtils, "validatePayloadWithSchema");

    mockFetchWithRetry([
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
    expect(detectDepegEvents).toHaveBeenCalledWith(db, expect.any(Array), undefined, undefined, undefined);
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
