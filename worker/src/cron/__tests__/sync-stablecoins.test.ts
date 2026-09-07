import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockFetch, type MockRoute } from "@shared/test-utils/mock-fetch";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";
import type { StablecoinMeta } from "@shared/types";
import { mockCircuitBreaker, mockCircuitOutcomeRecord, mockFetchRetry, mockRegistry } from "../../test-helpers/cron";
import {
  defaultSyncRoutes,
  makeDlResponse,
  makeSyncDb,
  trackCacheWrites,
} from "./sync-stablecoins.test-support";
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
import type { CronProgressReporter, CronProgressUpdate } from "../../lib/cron-logger";

const fetchWithRetryMock = vi.hoisted(() => vi.fn());

function mockFetchWithRetry(routes: Parameters<typeof mockFetch>[0]): ReturnType<typeof mockFetch> {
  const spy = mockFetch(routes, { requireMatch: true, stubGlobal: false });
  fetchWithRetryMock.mockImplementation((url: string) => spy(url));
  return spy;
}

vi.mock("@shared/lib/stablecoins/registry", () => {
  const fiat: StablecoinMeta["flags"] = { pegCurrency: "USD", backing: "rwa-backed", yieldBearing: false, rwa: false, navToken: false, governance: "centralized" };
  const fallback: StablecoinMeta[] = Array.from({ length: 50 }, (_, i) => (
    makeStablecoinMeta({ id: `fb-${i}`, name: `Fallback Coin ${i}`, symbol: `FC${i}`, geckoId: `fallback-coin-${i}`, detailProvider: "coingecko", flags: fiat })
  ));
  const stablecoins: StablecoinMeta[] = [
    makeStablecoinMeta({ id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether", llamaId: "1", detailProvider: "defillama", flags: fiat }),
    makeStablecoinMeta({ id: "usdc-circle", name: "USD Coin", symbol: "USDC", geckoId: "usd-coin", llamaId: "2", detailProvider: "defillama", flags: fiat }),
    makeStablecoinMeta({ id: "eurcv-societe-generale-forge", name: "EUR CoinVertible", symbol: "EURCV", geckoId: "societe-generale-forge-eurcv", detailProvider: "defillama", flags: { ...fiat, pegCurrency: "EUR" } }),
    makeStablecoinMeta({ id: "tryb-bilira", name: "BiLira", symbol: "TRYB", geckoId: "bilira", llamaId: "300", detailProvider: "defillama", flags: { ...fiat, pegCurrency: "TRY" } }),
    ...fallback,
  ];
  const trackedMetaById = new Map<string, StablecoinMeta>(stablecoins.map((coin) => [coin.id, { ...coin, cmcSlug: undefined }]));
  trackedMetaById.set("ggbr-goldfish-gold", makeStablecoinMeta({ id: "ggbr-goldfish-gold", name: "Goldfish Gold", symbol: "GGBR", geckoId: "goldfish-gold", commodityOunces: 0.001, flags: { ...fiat, navToken: false } }));
  return mockRegistry({ stablecoins: stablecoins.map((coin) => ({ ...coin })), trackedMetaById });
});

vi.mock("@shared/lib/stablecoins/frozen-snapshots", () => ({ FROZEN_SNAPSHOTS: [], FROZEN_SNAPSHOTS_BY_ID: new Map() }));
vi.mock("../sync-stablecoins/enrich-prices", () => ({
  enrichMissingPrices: vi.fn(async () => ({ totalMissing: 0, pass1: 0, pass1b: 0, passCmc: 0, passJupiter: 0, passDex: 0, passCgLowVolume: 0, finalMissing: 0, failedPasses: [] })),
  hasMissingPrice: vi.fn((asset: { price?: number | null }) => asset.price == null || typeof asset.price !== "number" || asset.price === 0),
  fetchPrimaryPrices: vi.fn(async () => ({ results: new Map(), stats: { attempted: 0, high: 0, singleSource: 0, cgOnly: 0, low: 0 }, cgPrices: new Map() })),
}));
vi.mock("../detect-depegs", () => ({ detectDepegEvents: vi.fn(async () => {}) }));
vi.mock("../confirm-pending-depegs", () => ({ confirmPendingDepegs: vi.fn(async () => ({ providerDiagnostics: [] })) }));
vi.mock("../../lib/authoritative-price-sources", () => ({
  createAuthoritativeLivePriceOverrideStats: vi.fn((budgetMs = 30_000) => ({ budgetMs, candidateCount: 0, attemptedCount: 0, successCount: 0, failedCount: 0, emptyCount: 0, skippedCircuitOpen: 0, skippedBudget: 0, timedOut: false })),
  fetchAuthoritativeLivePriceOverrides: vi.fn(async () => new Map()),
}));
vi.mock("../../lib/resolve-market-cap", () => ({ resolveMarketCap: vi.fn((...args: unknown[]) => args[0] ?? 0) }));
vi.mock("../../lib/fetch-retry", () => mockFetchRetry({ fetchWithRetry: fetchWithRetryMock }));
vi.mock("../../lib/circuit-breaker", () => mockCircuitBreaker());
vi.mock("../../lib/coingecko", () => ({
  cgUrl: vi.fn((path: string) => `https://api.coingecko.com${path}`),
  cgSimplePricePath: vi.fn((query: string) => `/simple/price?${query}&precision=full`),
  cgHeaders: vi.fn((extra: Record<string, string>) => extra),
}));
vi.mock("../../lib/stablecoin-publication-coverage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/stablecoin-publication-coverage")>();
  return {
    ...actual,
    loadPreviousStablecoinActivePriceCoverage: vi.fn(async () => null),
    evaluateStablecoinPublicationCoverage: (ids: Iterable<string>) => {
      const published = [...new Set(ids)];
      return { complete: true, expectedActiveCount: published.length, presentActiveCount: published.length, waivedActiveCount: 0, missingActiveIds: [], waivedActiveIds: [], expiredWaiverIds: [], invalidWaiverIds: [] };
    },
    evaluateStablecoinActivePriceCoverage: (assets: Iterable<{ id: string }>) => {
      const ids = [...new Set([...assets].map((asset) => String(asset.id)))];
      return { complete: true, expectedActiveCount: ids.length, presentActiveCount: ids.length, pricedActiveCount: ids.length, missingPriceCount: 0, pricedActiveIds: ids, missingActiveIds: [], affectedMarketCapUsd: 0, missingActiveAssets: [], alertEligibleCount: 0, alertEligibleIds: [], maxConsecutiveMissingGenerations: 0 };
    },
  };
});

function finalValidationPayload(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  const call = spy.mock.calls.find((args: unknown[]) => args[2] === "sync-stablecoins:stablecoins");
  const payload: unknown = call?.[1];
  if (typeof payload !== "object" || payload === null || !("peggedAssets" in payload)) return [];
  const assets = payload.peggedAssets;
  if (!Array.isArray(assets)) return [];
  return assets.filter((asset): asset is Record<string, unknown> => typeof asset === "object" && asset !== null);
}

function fallbackCoinGeckoData(): Record<string, { usd: number; usd_market_cap: number; last_updated_at: number }> {
  const observedAt = Math.floor(Date.now() / 1000);
  return Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`fallback-coin-${i}`, { usd: 1, usd_market_cap: 1_000_000 + i, last_updated_at: observedAt }]));
}

function throwingDlResponse(): Response {
  const response: Partial<Response> = {
    ok: true,
    status: 200,
    headers: new Headers({ "Content-Type": "application/json" }),
    json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
    text: () => Promise.resolve("truncated{"),
    body: null,
    bodyUsed: false,
    clone: () => throwingDlResponse(),
  };
  return response as Response;
}

describe("syncStablecoins", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
    vi.mocked(recordOutcome).mockReset().mockResolvedValue(mockCircuitOutcomeRecord());
    fetchWithRetryMock.mockReset();
    vi.mocked(enrichMissingPrices).mockReset().mockResolvedValue({ totalMissing: 0, pass1: 0, pass1b: 0, passCmc: 0, passJupiter: 0, passDex: 0, passCgLowVolume: 0, finalMissing: 0, failedPasses: [] });
    vi.mocked(fetchPrimaryPrices).mockReset().mockResolvedValue({ results: new Map(), stats: { attempted: 0, high: 0, singleSource: 0, cgOnly: 0, low: 0 }, cgPrices: new Map() });
    vi.mocked(fetchAuthoritativeLivePriceOverrides).mockReset().mockResolvedValue(new Map());
    vi.mocked(detectDepegEvents).mockReset().mockResolvedValue(undefined);
    vi.mocked(confirmPendingDepegs).mockReset().mockResolvedValue({ providerDiagnostics: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("publishes the DefiLlama snapshot and runs the downstream depeg workflow", async () => {
    const db = makeSyncDb();
    const prepare = vi.fn();
    const originalPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => { prepare(sql); return originalPrepare(sql); }) as typeof db.prepare;
    mockFetchWithRetry(defaultSyncRoutes(makeDlResponse(60)));
    const result = await syncStablecoins(db);
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(result).toMatchObject({ itemCount: 60, productivity: { productive: true, reason: "stablecoins-cache-published" } });
    expect(metadata).toMatchObject({ cacheWriteMode: "published", casSkipped: false, downstreamSafe: true, upstreamFetchOk: true });
    expect(prepare.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO cache")).length).toBeGreaterThan(0);
    const primaryCall = vi.mocked(fetchPrimaryPrices).mock.calls[0];
    expect(primaryCall?.[0]).toHaveLength(60);
    expect(primaryCall?.[1]).toBe(db);
    expect(primaryCall?.[8]).toMatchObject({ previousAssetsById: expect.any(Map) });
    expect(enrichMissingPrices).not.toHaveBeenCalled();
    expect(detectDepegEvents).toHaveBeenCalledWith(db, expect.any(Array), undefined, undefined, undefined, expect.any(Object));
    expect(confirmPendingDepegs).toHaveBeenCalledWith(db, expect.any(Array), undefined, undefined, undefined, expect.any(Object), expect.any(Object));
    expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), "defillama-stablecoins", true);
  });

  it("returns immediately when the stablecoins CAS loses to a newer writer", async () => {
    const db = makeSyncDb([{ match: "INSERT INTO cache", rows: [], runMeta: { changes: 0 } }]);
    mockFetchWithRetry(defaultSyncRoutes(makeDlResponse(60)));
    const result = await syncStablecoins(db);
    expect(result).toMatchObject({ itemCount: 0 });
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({ rowsWritten: 0, cacheWriteMode: "skipped-newer", casSkipped: true, downstreamSafe: true });
    expect(detectDepegEvents).not.toHaveBeenCalled();
    expect(confirmPendingDepegs).not.toHaveBeenCalled();
  });

  it("returns an aborted result before creating any upstream work", async () => {
    const controller = new AbortController();
    controller.abort("already cancelled");
    await expect(syncStablecoins(makeSyncDb(), controller.signal)).resolves.toMatchObject({ aborted: true });
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
  });

  it("keeps the critical path free of fallback enrichment and records GT isolation", async () => {
    mockFetchWithRetry(defaultSyncRoutes(makeDlResponse(60)));
    const result = await syncStablecoins(makeSyncDb());
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(enrichMissingPrices).not.toHaveBeenCalled();
    expect(metadata.gtProbe).toMatchObject({ inlineDisabled: true, isolationReason: "worker-memory-boundary" });
  });

  it("keeps a sane list price when a primary source reports a severe downside", async () => {
    const data = makeDlResponse(60);
    Object.assign(data.peggedAssets[0], { id: "usdt-tether", name: "Tether", symbol: "USDT", price: 1, priceSource: "defillama", priceConfidence: "single-source", circulating: { peggedUSD: 100_000_000 } });
    vi.mocked(fetchPrimaryPrices).mockResolvedValueOnce({ results: new Map([["usdt-tether", { price: 0.15, source: "coingecko", confidence: "single-source", dlPrice: 1, cgPrice: 0.15, candidateSources: ["coingecko"], agreeSources: ["coingecko"] }]]), stats: { attempted: 1, high: 0, singleSource: 1, cgOnly: 1, low: 0 }, cgPrices: new Map([["tether", 0.15]]) });
    const db = makeSyncDb();
    const writes = trackCacheWrites(db);
    mockFetchWithRetry(defaultSyncRoutes(data));
    await syncStablecoins(db);
    const asset = (JSON.parse(writes.find((write) => write.key === "stablecoins")!.value) as { peggedAssets: PeggedAsset[] }).peggedAssets.find((candidate) => candidate.id === "usdt-tether");
    expect(asset).toMatchObject({ price: 1, priceSource: "defillama", priceConfidence: "single-source", consensusSources: ["defillama"], agreeSources: ["defillama"] });
  });

  it("preserves a trusted previous price across a weak temporal jump", async () => {
    const now = Math.floor(Date.now() / 1000);
    const previous = { peggedAssets: [{ id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether", pegType: "peggedUSD", pegMechanism: "fiat-backed", price: 0.5, priceSource: "pyth", priceConfidence: "single-source", priceUpdatedAt: now - 120, priceObservedAt: now - 120, priceSyncedAt: now - 90, consensusSources: ["pyth"], agreeSources: ["pyth"], supplySource: "defillama", circulating: { peggedUSD: 100_000_000 }, circulatingPrevDay: {}, circulatingPrevWeek: {}, circulatingPrevMonth: {}, chainCirculating: {}, chains: ["Ethereum"] }] };
    const db = makeSyncDb([{ match: "SELECT value, updated_at FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [], first: { value: JSON.stringify(previous), updated_at: now - 90 } }]);
    const data = makeDlResponse(60);
    Object.assign(data.peggedAssets[0], { id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether", price: 0.5, priceSource: "defillama", priceConfidence: "single-source", circulating: { peggedUSD: 100_000_000 } });
    vi.mocked(fetchPrimaryPrices).mockResolvedValueOnce({ results: new Map([["usdt-tether", { price: 1.05, source: "coingecko", confidence: "single-source", dlPrice: 0.5, cgPrice: 1.05, candidateSources: ["coingecko"], agreeSources: ["coingecko"] }]]), stats: { attempted: 1, high: 0, singleSource: 1, cgOnly: 1, low: 0 }, cgPrices: new Map([["tether", 1.05]]) });
    const writes = trackCacheWrites(db);
    mockFetchWithRetry(defaultSyncRoutes(data));
    await syncStablecoins(db);
    const asset = (JSON.parse(writes.find((write) => write.key === "stablecoins")!.value) as { peggedAssets: PeggedAsset[] }).peggedAssets.find((candidate) => candidate.id === "usdt-tether");
    expect(asset).toMatchObject({ price: 0.5, priceSource: "defillama", priceConfidence: "single-source" });
  });

  it("rehydrates a fresh price-cache observation when publication has no price", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeSyncDb([{ match: "SELECT asset_id, price, updated_at, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json FROM price_cache", rows: [{ asset_id: "usdt-tether", price: 0.25580214, updated_at: now - 120, source: "defillama-list+pyth", confidence: "high", observed_at: now - 120, observed_at_mode: null, synced_at: now - 135, agree_sources_json: '["defillama-list","pyth"]', consensus_sources_json: '["coingecko","defillama-list","pyth"]' }] }]);
    const data = makeDlResponse(60);
    Object.assign(data.peggedAssets[0], { id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether", price: null, priceSource: undefined, priceConfidence: null, circulating: { peggedUSD: 100_000_000 } });
    const writes = trackCacheWrites(db);
    mockFetchWithRetry(defaultSyncRoutes(data));
    await syncStablecoins(db);
    const asset = (JSON.parse(writes.find((write) => write.key === "stablecoins")!.value) as { peggedAssets: PeggedAsset[] }).peggedAssets.find((candidate) => candidate.id === "usdt-tether");
    expect(asset).toMatchObject({ price: 0.25580214, priceSource: "cached", priceConfidence: "fallback", priceObservedAt: now - 120, priceSyncedAt: now - 135 });
  });

  const failedIntakeCases: Array<{ label: string; routes: MockRoute[]; error: string }> = [
    { label: "HTTP failure", routes: [{ match: "api.coingecko.com", body: { tether: { usd: 1, usd_market_cap: 1e9 }, "usd-coin": { usd: 1, usd_market_cap: 1e9 } } }, { match: "stablecoins.llama.fi", body: { error: "down" }, status: 500 }], error: "DefiLlama stablecoins API failed" },
    { label: "circuit open", routes: [{ match: "api.coingecko.com", body: {} }], error: "DefiLlama stablecoins circuit open" },
    { label: "invalid payload", routes: defaultSyncRoutes(makeDlResponse(10)), error: "DefiLlama payload was structurally invalid" },
  ];

  it.each(failedIntakeCases)("fails closed on $label when fallback is insufficient", async ({ routes, error, label }) => {
    if (label === "circuit open") vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetchWithRetry(routes);
    await expect(syncStablecoins(makeSyncDb())).rejects.toThrow(error);
    if (label !== "circuit open") expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), "defillama-stablecoins", false);
  });

  it("continues with degraded status when depeg detection fails", async () => {
    vi.mocked(detectDepegEvents).mockRejectedValueOnce(new Error("depeg crash"));
    mockFetchWithRetry(defaultSyncRoutes(makeDlResponse(60)));
    const result = await syncStablecoins(makeSyncDb());
    expect(result).toMatchObject({ itemCount: 60, status: "degraded" });
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({ depegPipelineSucceeded: false, depegErrorCount: 1 });
  });

  it("guards an invalid final payload and writes only the diagnostic cache", async () => {
    const db = makeSyncDb();
    const writes = trackCacheWrites(db);
    vi.spyOn(apiUtils, "validatePayloadWithSchema").mockReturnValueOnce({ ok: false, issues: "forced-test-validation-failure" });
    mockFetchWithRetry(defaultSyncRoutes(makeDlResponse(60)));
    const result = await syncStablecoins(db);
    expect(result).toMatchObject({ itemCount: 60, status: "degraded" });
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({ validationFailures: 1, cacheWriteMode: "blocked-invalid-payload", downstreamSafe: false });
    expect(writes.map((write) => write.key)).toContain("stablecoins:invalid-last");
    expect(writes.map((write) => write.key)).not.toContain("stablecoins");
  });

  it("normalizes missing prices, aliases, nullable history, and reports stages", async () => {
    const data = makeDlResponse(60);
    Object.assign(data.peggedAssets[12], { price: null, priceSource: undefined, priceConfidence: null });
    const alias = data.peggedAssets[2] as unknown as Record<string, unknown>;
    delete alias.geckoId;
    alias.gecko_id = "coin-three";
    delete alias.priceConfidence;
    alias.circulatingPrevDay = null;
    alias.circulatingPrevWeek = null;
    alias.circulatingPrevMonth = null;
    const progressUpdates: CronProgressUpdate[] = [];
    const reportProgress: CronProgressReporter = async (update) => {
      progressUpdates.push(update);
    };
    const db = makeSyncDb();
    const writes = trackCacheWrites(db);
    const validate = vi.spyOn(apiUtils, "validatePayloadWithSchema");
    mockFetchWithRetry(defaultSyncRoutes(data));
    await syncStablecoins(db, undefined, { reportProgress });
    const payload = finalValidationPayload(validate);
    expect(payload.find((asset) => asset.id === "ust-terra")).toMatchObject({ geckoId: "coin-three", priceConfidence: "single-source", circulatingPrevDay: {}, circulatingPrevWeek: {}, circulatingPrevMonth: {} });
    expect((JSON.parse(writes.find((write) => write.key === "stablecoins")!.value) as { peggedAssets: PeggedAsset[] }).peggedAssets[12]).toMatchObject({ price: null, priceSource: "missing" });
    expect(progressUpdates.map((update) => update.stage)).toEqual(expect.arrayContaining(["intake", "price-enrichment", "price-validation", "cache-validation", "cache-write", "depeg-pipeline", "complete"]));
  });

  it("writes a CoinGecko fallback as diagnostic data when that fallback is also invalid", async () => {
    const db = makeSyncDb();
    const writes = trackCacheWrites(db);
    vi.spyOn(apiUtils, "validatePayloadWithSchema").mockReturnValueOnce({ ok: false, issues: "forced-fallback-validation-failure" });
    mockFetchWithRetry([{ match: "api.coingecko.com", body: fallbackCoinGeckoData() }, { match: "stablecoins.llama.fi", body: { error: "down" }, status: 500 }]);
    const result = await syncStablecoins(db);
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({ validationFailures: 1, validationContext: "fallback" });
    expect(writes.map((write) => write.key)).toContain("stablecoins:invalid-last");
  });

  it("blocks stale publication, aborts during the staleness check, and backfills supply history", async () => {
    const data = makeDlResponse(60);
    const now = Math.floor(Date.now() / 1000);
    const previous = JSON.stringify({ peggedAssets: data.peggedAssets.map((asset) => ({ id: asset.id, price: 1, priceSource: "defillama", priceConfidence: "single-source", priceUpdatedAt: now, priceObservedAt: now, priceSyncedAt: now })) });
    const staleDb = makeSyncDb([{ match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [{ value: previous, updated_at: now - 8 * 3600 }], first: { value: previous, updated_at: now - 8 * 3600 } }]);
    const staleWrites = trackCacheWrites(staleDb);
    mockFetchWithRetry(defaultSyncRoutes(data));
    const staleResult = await syncStablecoins(staleDb);
    expect(staleResult.status).toBe("degraded");
    expect(JSON.parse(staleResult.metadata ?? "{}")).toMatchObject({ stalenessWarning: true, staleWriteBlocked: true, cacheWriteMode: "no-write", downstreamSafe: false });
    expect(staleWrites.map((write) => write.key)).not.toContain("stablecoins");

    vi.mocked(recordOutcome).mockClear();
    const controller = new AbortController();
    const report = vi.fn(async (update: { stage?: string | null }) => { if (update.stage === "staleness-check") controller.abort(); });
    mockFetchWithRetry(defaultSyncRoutes(makeDlResponse(60)));
    expect(await syncStablecoins(makeSyncDb(), controller.signal, { reportProgress: report })).toMatchObject({ aborted: true });
    expect(vi.mocked(recordOutcome).mock.calls.some((call) => call[1] === CIRCUIT_SOURCE.DL_STABLECOINS && call[2] === false)).toBe(false);

    const historyData = makeDlResponse(60);
    Object.assign(historyData.peggedAssets[0], { circulatingPrevDay: null, circulatingPrevWeek: null, circulatingPrevMonth: null });
    const utcMidnight = (daysAgo: number) => { const date = new Date(); date.setUTCDate(date.getUTCDate() - daysAgo); return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000); };
    const validate = vi.spyOn(apiUtils, "validatePayloadWithSchema");
    const historyDb = makeSyncDb([{ match: "supply_history", rows: [{ stablecoin_id: "usdt-tether", snapshot_date: utcMidnight(1), circulating_usd: 900_000 }, { stablecoin_id: "usdt-tether", snapshot_date: utcMidnight(7), circulating_usd: 890_000 }, { stablecoin_id: "usdt-tether", snapshot_date: utcMidnight(30), circulating_usd: 880_000 }] }]);
    mockFetchWithRetry(defaultSyncRoutes(historyData));
    await syncStablecoins(historyDb);
    expect(finalValidationPayload(validate).find((asset) => asset.id === "usdt-tether")).toMatchObject({ circulatingPrevDay: { peggedUSD: 900_000 }, circulatingPrevWeek: { peggedUSD: 890_000 }, circulatingPrevMonth: { peggedUSD: 880_000 } });
  });

  it.each([
    { label: "expired globally", updatedAt: 7 * 3600, source: null, confidence: null },
    { label: "expired for its source", updatedAt: 1_800, source: "coingecko", confidence: "high" },
  ])("does not replay a $label price-cache row", async ({ updatedAt, source, confidence }) => {
    const now = Math.floor(Date.now() / 1000);
    const data = makeDlResponse(60);
    Object.assign(data.peggedAssets[0], { id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether", price: 0, priceConfidence: null, circulating: { peggedUSD: 100_000_000 } });
    const validate = vi.spyOn(apiUtils, "validatePayloadWithSchema");
    const db = makeSyncDb([{ match: "SELECT asset_id, price, updated_at, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json FROM price_cache", rows: [{ asset_id: "usdt-tether", price: 0.999, updated_at: now - updatedAt, source, confidence, observed_at: source ? now - updatedAt : null, observed_at_mode: source ? "upstream" : null, synced_at: source ? now - updatedAt : null, agree_sources_json: source ? '["coingecko"]' : null, consensus_sources_json: source ? '["coingecko"]' : null }] }]);
    mockFetchWithRetry(defaultSyncRoutes(data));
    await syncStablecoins(db);
    const asset = finalValidationPayload(validate).find((candidate) => candidate.id === "usdt-tether");
    expect(asset?.priceSource).not.toBe("cached");
    expect(asset?.price).not.toBe(0.999);
  });

  it("accepts a deep JPY price when the FX cache is stale", async () => {
    const now = Math.floor(Date.now() / 1000);
    const data = makeDlResponse(60);
    Object.assign(data.peggedAssets[0], { id: "jpyc-jpyc", name: "JPYC", symbol: "JPYC", price: 0.0005, pegType: "peggedJPY" });
    const validate = vi.spyOn(apiUtils, "validatePayloadWithSchema");
    const db = makeSyncDb([{ match: "SELECT value, updated_at FROM cache WHERE key = ?", matchBinds: ["fx-rates"], rows: [], first: { value: JSON.stringify({ peggedJPY: 0.0067 }), updated_at: now - 8 * 3600 } }]);
    mockFetchWithRetry(defaultSyncRoutes(data));
    await syncStablecoins(db);
    expect(finalValidationPayload(validate).find((asset) => asset.id === "jpyc-jpyc")?.price).toBe(0.0005);
  });

  it("retries parse failures, then falls back after the retry budget, without retrying HTTP errors", async () => {
    vi.useRealTimers();
    const cg = mockFetchWithRetry([{ match: "api.coingecko.com", body: {} }, { match: "coins.llama.fi/prices", body: { coins: {} } }]) as unknown as (url: string) => Promise<Response>;
    let dlAttempts = 0;
    fetchWithRetryMock.mockImplementation(async (url: string) => {
      if (url.includes("/stablecoins?includePrices=true")) return dlAttempts++ === 0 ? throwingDlResponse() : new Response(JSON.stringify(makeDlResponse(60)), { headers: { "Content-Type": "application/json" } });
      return cg(url);
    });
    await syncStablecoins(makeSyncDb());
    expect(dlAttempts).toBe(2);
    expect(recordOutcome).not.toHaveBeenCalledWith(expect.anything(), CIRCUIT_SOURCE.DL_STABLECOINS, false);

    vi.mocked(recordOutcome).mockClear();
    dlAttempts = 0;
    fetchWithRetryMock.mockImplementation(async (url: string) => { if (url.includes("/stablecoins?includePrices=true")) { dlAttempts++; return throwingDlResponse(); } return cg(url); });
    await expect(syncStablecoins(makeSyncDb())).rejects.toThrow(/DefiLlama response body parse failed/);
    expect(dlAttempts).toBe(3);
    expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), CIRCUIT_SOURCE.DL_STABLECOINS, false);

    vi.mocked(recordOutcome).mockClear();
    dlAttempts = 0;
    fetchWithRetryMock.mockImplementation(async (url: string) => { if (url.includes("/stablecoins?includePrices=true")) { dlAttempts++; return new Response("", { status: 502 }); } return cg(url); });
    await expect(syncStablecoins(makeSyncDb())).rejects.toThrow(/DefiLlama stablecoins API failed/);
    expect(dlAttempts).toBe(1);
  });
});

describe("stampPriceMetadata", () => {
  it("preserves existing provenance and applies supplied consensus/agreement metadata", () => {
    const withSources = { id: "test", name: "Test", symbol: "T", circulating: {}, chains: [] } as PeggedAsset;
    stampPriceMetadata(withSources, "coingecko+defillama-list", "high", 1234, null, ["coingecko", "defillama-list"], ["coingecko"]);
    expect(withSources).toMatchObject({ priceSource: "coingecko+defillama-list", priceConfidence: "high", priceUpdatedAt: 1234, consensusSources: ["coingecko", "defillama-list"], agreeSources: ["coingecko"] });
    const existing = { id: "test", name: "Test", symbol: "T", circulating: {}, chains: [], consensusSources: ["existing"], agreeSources: ["existing"] } as PeggedAsset;
    stampPriceMetadata(existing, "cached", "fallback", 5678);
    expect(existing).toMatchObject({ consensusSources: ["existing"], agreeSources: ["existing"] });
  });
});
