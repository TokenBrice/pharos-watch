import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { FROZEN_SNAPSHOTS, FROZEN_SNAPSHOTS_BY_ID } from "@shared/lib/stablecoins/frozen-snapshots";
import {
  buildFallbackAssetsFromCoinGecko, buildInsufficientFallbackResult, overlayFallbackCuratedAggregateSupply,
  resolveFreshCoinGeckoFallbackEntry, runFallbackIntakePhase,
} from "../fallback-intake";
import { restoreFallbackCacheState } from "../fallback";
import { loadPreviousStablecoinsById, normalizeStablecoinsPayload, restoreMissingTrackedAssets } from "../shared";
import { checkStablecoinsPriceStaleness } from "../runtime";
import { runStablecoinsPostIntakePublication } from "../publication";
import { buildChainRpcs } from "../../../lib/chain-registry";
import { TOTAL_SUPPLY_SELECTOR } from "../../../lib/evm-selectors";
import type { PeggedAsset } from "../enrich-prices";
import { makePeggedAsset } from "./_fixtures";

const fallbackMocks = vi.hoisted(() => ({
  runDepegPipeline: vi.fn(async (..._args: unknown[]) => ({ depegErrorCount: 0, depegErrors: [], providerDiagnostics: [] })),
  queueTrackedAdditionsNotice: vi.fn(async (..._args: unknown[]) => undefined),
  validateAndWriteStablecoinsCache: vi.fn(async ({ syncStartSec }: { syncStartSec: number }) => ({
    written: true, skippedBecauseNewer: false, cacheKey: "stablecoins", syncStartSec, responseReadyCacheError: null, quarantinedAssets: [],
  })),
  commitReplayPriceCache: vi.fn(async (..._args: unknown[]) => null),
  fillMissingSupplyHistory: vi.fn(async (..._args: unknown[]) => 0),
}));

const onchainSupplyMocks = vi.hoisted(() => ({ fetchCuratedAggregateOnChainMcap: vi.fn(), fetchOnChainMcap: vi.fn() }));

vi.mock("../post-enrichment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../post-enrichment")>()),
  runDepegPipeline: fallbackMocks.runDepegPipeline,
}));

vi.mock("../telegram-tracked-additions", () => ({
  isFallbackBackedTrackedBaseline: () => false,
  queueTrackedAdditionsNotice: fallbackMocks.queueTrackedAdditionsNotice,
}));

vi.mock("../cache-publication", () => ({
  validateAndWriteStablecoinsCache: fallbackMocks.validateAndWriteStablecoinsCache,
  commitReplayPriceCache: fallbackMocks.commitReplayPriceCache,
}));

vi.mock("../phase-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../phase-helpers")>()),
  fillMissingSupplyHistory: fallbackMocks.fillMissingSupplyHistory,
}));

vi.mock("../supplemental-assets/onchain-supply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../supplemental-assets/onchain-supply")>()),
  fetchCuratedAggregateOnChainMcap: onchainSupplyMocks.fetchCuratedAggregateOnChainMcap,
  fetchOnChainMcap: onchainSupplyMocks.fetchOnChainMcap,
}));

const NOW_SEC = 1_700_000_000;
function makeAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return makePeggedAsset({
    id: "fixture-usd", name: "Fixture USD", symbol: "FUSD", geckoId: "fixture-usd", pegMechanism: "fiat-backed",
    price: 1, priceSource: "coingecko", priceConfidence: "single-source", priceUpdatedAt: NOW_SEC,
    circulating: { peggedUSD: 1_000_000 }, chainCirculating: {}, chains: [], ...overrides,
  });
}

async function evaluateFallbackStalenessFixture(input: {
  db: D1Database; assets: PeggedAsset[]; previousAssetsById: ReadonlyMap<string, PeggedAsset>;
  previousCacheState: Parameters<typeof checkStablecoinsPriceStaleness>[0]["previousCacheState"];
  syncStartSec?: number; signal?: AbortSignal;
}) {
  const { syncStartSec: _syncStartSec, ...stalenessInput } = input;
  const result = await checkStablecoinsPriceStaleness({
    ...stalenessInput, progressStage: "fallback-staleness-check", progressMessage: "Checking fallback price staleness",
    abortStage: "fallback-detect-price-staleness", warningLabel: "(fallback)", failureLabel: "Fallback staleness check",
    blockedResultFactory: () => ({ metadata: "{}" }),
  });
  if (result.blockedReason === "severe-staleness") {
    return runStablecoinsPostIntakePublication({
      ...stalenessInput, previousAssetsById: new Map(input.previousAssetsById), previousActivePriceCoverage: null,
      syncStartSec: input.syncStartSec ?? NOW_SEC, priceCacheEntries: [], providerDiagnostics: [],
      metadata: { path: "fallback", input: { enrichStats: {}, authoritativeOverrideCount: 0, rejectedCount: 0, cachedFallbackCount: 0 } },
    });
  }
  if (result.blockedResult) return result.blockedResult;
  return result;
}

const cacheDb = (row: Record<string, unknown>) =>
  mockD1([{ match: "SELECT value, updated_at FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [], ...row }]);
const cRows = (entries: Array<[string, string, number]>) =>
  Object.fromEntries(entries.map(([k, chainId, current]) => [k, { chainId, current }]));

describe("CoinGecko fallback phases", () => {
  beforeEach(() => { fallbackMocks.runDepegPipeline.mockClear(); fallbackMocks.queueTrackedAdditionsNotice.mockClear(); });

  it("accepts fresh CoinGecko fallback data and rejects unverifiable timestamps", () => {
    const assets = buildFallbackAssetsFromCoinGecko({
      syncStartSec: NOW_SEC,
      cgData: {
        "fixture-usd": { usd: 0.999, usd_market_cap: 12_000_000, last_updated_at: NOW_SEC - 60 },
        "fixture-zero": { usd: 1, usd_market_cap: 0, last_updated_at: NOW_SEC - 60 },
      },
      stablecoins: [
        { id: "fixture-usd", name: "Fixture USD", symbol: "FUSD", geckoId: "fixture-usd", flags: { pegCurrency: "USD", backing: "fiat-backed" } },
        { id: "fixture-zero", name: "Fixture Zero", symbol: "FZERO", geckoId: "fixture-zero", flags: { pegCurrency: "USD", backing: "fiat-backed" } },
      ],
    });
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      id: "fixture-usd", price: 0.999, priceSource: "coingecko", priceConfidence: "single-source",
      supplyObservedAt: NOW_SEC - 60, priceUpdatedAt: NOW_SEC - 60, priceObservedAt: NOW_SEC - 60,
      priceObservedAtMode: "upstream", priceSyncedAt: NOW_SEC, supplySource: "coingecko-fallback",
      circulating: { peggedUSD: 12_000_000 }, circulatingNative: 12_000_000 / 0.999,
      valuationPriceUsd: 0.999, valuationObservedAtSec: NOW_SEC - 60,
      circulatingPrevDay: null, circulatingPrevWeek: null, circulatingPrevMonth: null, chains: [], chainCirculating: {},
    });
    for (const entry of [{ usd: 1, usd_market_cap: 5_000_000, last_updated_at: NOW_SEC - 901 }, { usd: 1, usd_market_cap: 5_000_000 }]) {
      expect(resolveFreshCoinGeckoFallbackEntry(entry, NOW_SEC)).toBeNull();
    }
    // A small future skew is tolerated (SUPPLY-MCAP-08): a zero-skew gate rejected the freshest
    // CoinGecko observations, so an entry stamped marginally ahead of the sync clock is accepted.
    expect(resolveFreshCoinGeckoFallbackEntry({ usd: 1, usd_market_cap: 5_000_000, last_updated_at: NOW_SEC + 1 }, NOW_SEC))
      .toMatchObject({ price: 1, mcap: 5_000_000 });
  });

  it("uses the canonical peggedREAL type for BRL fallback assets", () => {
    const assets = buildFallbackAssetsFromCoinGecko({
      syncStartSec: NOW_SEC, cgData: { "fixture-brl": { usd: 0.18, usd_market_cap: 5_000_000, last_updated_at: NOW_SEC } },
      stablecoins: [{ id: "fixture-brl", name: "Fixture BRL", symbol: "FBRL", geckoId: "fixture-brl", flags: { pegCurrency: "BRL", backing: "fiat-backed" } }],
    });
    expect(assets[0]).toMatchObject({ pegType: "peggedREAL", circulating: { peggedREAL: 5_000_000 } });
  });

  it.each([false, true])("injects frozen supply and applies archive price freshness (expired=%s)", async (expired) => {
    const aeur = FROZEN_SNAPSHOTS_BY_ID.get("aeur-anchored-coins")!;
    const capturedAt = Math.floor(Date.parse(aeur.capturedAt) / 1000);
    const syncStartSec = capturedAt + (expired ? 86_400 : 0);
    const stablecoins = ACTIVE_STABLECOINS.filter((meta) => meta.geckoId && meta.id !== "hbd-hive");
    const cgData = Object.fromEntries(stablecoins.map((meta) => [meta.geckoId!, {
      usd: 1, usd_market_cap: 5_000_000, last_updated_at: syncStartSec,
    }]));
    const result = await runFallbackIntakePhase({ syncStartSec, cgData, stablecoins });
    expect("assets" in result).toBe(true);
    const assets = (result as { assets: PeggedAsset[] }).assets;
    const frozenIds = new Set(FROZEN_SNAPSHOTS.map((snapshot) => snapshot.id));
    expect(assets.filter((asset) => frozenIds.has(asset.id)).map((asset) => asset.id).sort())
      .toEqual([...frozenIds].sort());
    expect(assets.find((asset) => asset.id === aeur.id)).toMatchObject({
      price: expired ? null : 1.117990454919679,
      priceObservedAt: expired ? null : capturedAt,
      circulating: { peggedEUR: 1_117_775.589919203 },
    });
  });

  it.each(["bold-liquity", "yzusd-yuzu", "hbd-hive", "xaut-tether", "jltxx-jpmorgan"])("does not admit %s's CoinGecko cap during a DefiLlama outage", (id) => {
    const excluded = ACTIVE_STABLECOINS.find((meta) => meta.id === id)!;
    const assets = buildFallbackAssetsFromCoinGecko({
      syncStartSec: NOW_SEC,
      cgData: {
        [excluded.geckoId!]: { usd: 1, usd_market_cap: 39_000_000, last_updated_at: NOW_SEC },
        tether: { usd: 1, usd_market_cap: 5_000_000, last_updated_at: NOW_SEC },
      },
    });

    expect(assets.map((asset) => asset.id)).toEqual(["usdt-tether"]);
    expect(assets[0]).toMatchObject({
      supplySource: "coingecko-fallback", circulating: { peggedUSD: 5_000_000 }, supplyObservedAt: NOW_SEC,
    });
  });

  it("withholds non-native JLTXX caps and restores only a reconciled two-leg native packet", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const base = makeAsset({ id: "jltxx-jpmorgan", name: "JLTXX", symbol: "JLTXX", circulating: { peggedUSD: 1_234_567 }, supplySource: "coingecko-fallback", supplyObservedAt: nowSec - 60 });
    const native: typeof base = {
      ...base, supplySource: "onchain-total-supply", circulating: { peggedUSD: 700 }, circulatingNative: 700, valuationPriceUsd: 1,
      chainCirculating: { Ethereum: { chainId: "ethereum", current: 100 }, Solana: { chainId: "solana", current: 600 } }, chains: ["Ethereum", "Solana"],
    };
    const injected = [{ ...base }];
    await overlayFallbackCuratedAggregateSupply(injected, undefined, undefined, undefined, new Map([["jltxx-jpmorgan", { ...base, supplySource: "defillama" }]]));
    expect({ src: injected[0].supplySource, circ: injected[0].circulating }).toEqual({ src: "onchain-supply-withheld", circ: {} });
    const validCetes = makeAsset({
      id: "cetes-etherfuse", circulating: { peggedMXN: 4_000 }, supplySource: "onchain-total-supply", supplyObservedAt: undefined,
      chainCirculating: cRows([["Solana", "solana", 1_000], ["Base", "base", 500], ["Polygon", "polygon", 500], ["Monad", "monad", 500], ["Stellar", "stellar", 1_500], ["Avalanche", "avalanche", 0]]),
    });
    const loadedMap = (await loadPreviousStablecoinsById(cacheDb({ first: { value: JSON.stringify({ peggedAssets: [{ ...native, supplyObservedAt: undefined }, validCetes] }), updated_at: nowSec - 30 } }))).previousAssetsById;
    const loaded = loadedMap.get("jltxx-jpmorgan")!;
    expect([loaded.supplyObservedAt, loadedMap.get("cetes-etherfuse")?.supplyObservedAt]).toEqual([undefined, undefined]);
    const bad: Array<typeof base> = [
      { ...base, supplySource: "defillama" },
      { ...native, chainCirculating: cRows([["Ethereum", "ethereum", 700]]) },
      { ...native, chainCirculating: cRows([["Ethereum", "ethereum", 100], ["Solana", "ethereum", 600]]) },
      { ...native, circulatingNative: 1_234_567 },
      { ...native, circulatingNative: undefined, price: 2 },
      { ...native, valuationPriceUsd: undefined },
      { ...native, circulating: { peggedMXN: 700 } },
      loaded,
    ];
    for (const prev of bad) {
      const row = restoreMissingTrackedAssets([], new Map([["jltxx-jpmorgan", prev]]), nowSec).assets.find((a) => a.id === "jltxx-jpmorgan")!;
      expect({ src: row.supplySource, circ: row.circulating }).toEqual({ src: "onchain-supply-withheld", circ: {} });
    }
    const validTbill = makeAsset({
      id: "tbill-openeden", circulating: { peggedUSD: 285_000 }, supplySource: "onchain-circulating-supply", supplyObservedAt: nowSec - 60,
      chainCirculating: cRows([["Ethereum", "ethereum", 30_000], ["Arbitrum", "arbitrum", 0], ["Solana", "solana", 0], ["XRP Ledger", "xrpl", 5_000], ["BSC", "bsc", 250_000]]),
    });
    const badStrict: Array<[string, PeggedAsset]> = [
      ["tbill-openeden", { ...validTbill, supplySource: "onchain-total-supply" }],
      ["tbill-openeden", { ...validTbill, chainCirculating: cRows([["Ethereum", "ethereum", 30_000], ["Arbitrum", "ethereum", 0], ["Solana", "ethereum", 0], ["XRP Ledger", "ethereum", 5_000], ["BSC", "ethereum", 250_000]]) }],
      ["wtgxx-wisdomtree", makeAsset({ id: "wtgxx-wisdomtree", circulating: { peggedUSD: 700 }, supplySource: "onchain-total-supply", supplyObservedAt: nowSec - 60, chainCirculating: cRows([["Ethereum", "ethereum", 0], ["Arbitrum", "arbitrum", 100], ["Avalanche", "avalanche", 100], ["Base", "base", 100], ["Optimism", "optimism", 0], ["Plume", "plume", 0], ["Stellar", "stellar", 200], ["Solana", "solana", 200]]) })],
      ["cetes-etherfuse", loadedMap.get("cetes-etherfuse")!],
    ];
    for (const [id, prev] of badStrict) {
      const row = restoreMissingTrackedAssets([], new Map([[id, prev]]), nowSec).assets.find((a) => a.id === id)!;
      expect({ src: row.supplySource, circ: row.circulating }).toEqual({ src: "onchain-supply-withheld", circ: {} });
    }
    const ok = restoreMissingTrackedAssets([], new Map([["jltxx-jpmorgan", native], ["tbill-openeden", validTbill]]), nowSec).assets;
    const okJ = ok.find((a) => a.id === "jltxx-jpmorgan")!;
    const okT = ok.find((a) => a.id === "tbill-openeden")!;
    expect({ src: okJ.supplySource, restored: okJ.supplyRestored, circ: okJ.circulating, clock: okJ.supplyObservedAt })
      .toEqual({ src: "onchain-total-supply", restored: true, circ: { peggedUSD: 700 }, clock: nowSec - 60 });
    expect({ src: okT.supplySource, restored: okT.supplyRestored, circ: okT.circulating, clock: okT.supplyObservedAt })
      .toEqual({ src: "onchain-circulating-supply", restored: true, circ: { peggedUSD: 285_000 }, clock: nowSec - 60 });
  });

  it("keeps insufficient fallback metadata in no-write degraded mode", () => {
    const result = buildInsufficientFallbackResult(2);
    expect(result.itemCount).toBeUndefined();
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      rowsRead: 2, rowsWritten: 0, fallbackMode: "coingecko-supply-fallback", validationFailures: 1,
      cacheWriteMode: "no-write", downstreamSafe: false, capabilities: { stablecoinsCache: false, depegPipeline: false },
    });
  });

  it("short-circuits the intake phase to a no-write result when too few assets survive", async () => {
    const result = await runFallbackIntakePhase({
      syncStartSec: NOW_SEC,
      cgData: { "some-coin": { usd: 1, usd_market_cap: 100, last_updated_at: NOW_SEC } },
      stablecoins: [{ id: "some-coin", name: "Some Coin", symbol: "SOME", geckoId: "some-coin", flags: { pegCurrency: "USD", backing: "fiat-backed" } }],
    });
    expect("metadata" in result).toBe(true);
    expect(JSON.parse(("metadata" in result ? result.metadata : null) ?? "{}")).toMatchObject({ rowsWritten: 0, cacheWriteMode: "no-write" });
  });

  it.each([false, true])("preserves fresh aggregate clocks and nulls previous chain current (previous restored: %s)", async (restored) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const current = makeAsset({
      circulatingPrevDay: null, circulatingPrevWeek: null, circulatingPrevMonth: null, chainCirculating: {}, chains: [],
      supplySource: "coingecko-fallback", supplyObservedAt: nowSec - 10, circulating: { peggedUSD: 1_500_000 },
    });
    const previous = makeAsset({
      supplyObservedAt: nowSec - 60, supplyRestored: restored,
      supplyChainGuard: restored ? {
        reason: "supply-chain-dropout", status: "quarantined", quarantinedSince: nowSec - 60,
        chains: [{ chainId: "ethereum", chainLabel: "Ethereum", listCurrentUsd: 0, baselineUsd: 1_000_000, baselineObservedAt: nowSec - 60, baselineSource: "state", resolution: "carried-baseline" }],
      } : undefined,
      chainCirculating: { Ethereum: { current: restored ? null : 1_000_000, circulatingPrevDay: 990_000 } }, chains: ["Ethereum"],
      circulatingPrevDay: { peggedUSD: 990_000 }, circulatingPrevWeek: { peggedUSD: 980_000 }, circulatingPrevMonth: { peggedUSD: 970_000 },
    });
    const db = cacheDb({ first: { value: JSON.stringify({ peggedAssets: [previous] }), updated_at: Math.floor(Date.now() / 1000) - 60 } });
    const result = await restoreFallbackCacheState({ db, assets: [current] });
    expect(result.previousAssetsById.get("fixture-usd")).toMatchObject({ id: "fixture-usd", chains: ["Ethereum"] });
    expect({
      chainCirculating: current.chainCirculating, circulating: current.circulating, supplyObservedAt: current.supplyObservedAt,
      chains: current.chains, circulatingPrevDay: current.circulatingPrevDay,
      circulatingPrevWeek: current.circulatingPrevWeek, circulatingPrevMonth: current.circulatingPrevMonth,
    }).toEqual({
      chainCirculating: { Ethereum: { current: null, circulatingPrevDay: 990_000 } }, circulating: { peggedUSD: 1_500_000 },
      supplyObservedAt: nowSec - 10, chains: ["Ethereum"], circulatingPrevDay: { peggedUSD: 990_000 },
      circulatingPrevWeek: { peggedUSD: 980_000 }, circulatingPrevMonth: { peggedUSD: 970_000 },
    });
    expect(current.supplyRestored).not.toBe(true);
  });

  async function evaluateStaleCohort(total: number, overlap: number) {
    const assets = Array.from({ length: total }, (_, index) => makeAsset({ id: `fixture-${index}`, geckoId: `fixture-${index}`, price: 1 }));
    const previousPayload = {
      peggedAssets: assets.slice(0, overlap).map((asset) => ({
        id: asset.id, price: asset.price, priceSource: asset.priceSource, priceConfidence: asset.priceConfidence,
        priceUpdatedAt: asset.priceUpdatedAt, priceObservedAt: asset.priceObservedAt ?? asset.priceUpdatedAt, priceSyncedAt: asset.priceSyncedAt,
      })),
    };
    const db = cacheDb({ first: { value: JSON.stringify(previousPayload), updated_at: NOW_SEC - 8 * 3600 } });
    const { previousAssetsById, cacheState: previousCacheState } = await loadPreviousStablecoinsById(db);
    return evaluateFallbackStalenessFixture({ db, assets, previousAssetsById, previousCacheState, syncStartSec: NOW_SEC });
  }

  it("returns the fallback stale-blocked result before cache publication", async () => {
    const result = await evaluateStaleCohort(50, 50);
    expect("metadata" in result).toBe(true);
    const metadata = JSON.parse(("metadata" in result ? result.metadata : null) ?? "{}") as Record<string, unknown>;
    expect(result).toMatchObject({ status: "degraded", itemCount: 50 });
    expect(metadata).toMatchObject({
      rowsRead: 50, rowsWritten: 0, fallbackMode: "coingecko-supply-fallback-stale-blocked",
      stalenessWarning: true, staleWriteBlocked: true, cacheWriteMode: "no-write",
      cacheWriteSucceeded: false, depegPipelineSucceeded: false,
    });
  });

  it.each([
    { label: "blocks a collapsed payload whose identical overlap still represents it", total: 40, overlap: 30, blocked: true },
    { label: "keeps publishing when the identical overlap covers under half the payload", total: 100, overlap: 40, blocked: false },
  ])("$label", async ({ total, overlap, blocked }) => {
    const result = await evaluateStaleCohort(total, overlap);
    if (blocked) {
      expect(JSON.parse(("metadata" in result ? result.metadata : null) ?? "{}")).toMatchObject({
        fallbackMode: "coingecko-supply-fallback-stale-blocked", staleWriteBlocked: true, cacheWriteMode: "no-write",
      });
      return;
    }
    expect(result).toMatchObject({ state: "ok", stalenessSummary: { compared: overlap, identical: overlap, identicalRatio: 1 } });
  });

  it.each([
    { name: "marks malformed previous cache as check-failed in the fallback staleness gate", response: { first: { value: "{not-json", updated_at: NOW_SEC - 60 } }, reason: "malformed-previous-cache" },
    { name: "marks D1 read failures as check-failed in the fallback staleness gate", response: { throwError: new Error("cache read failed") }, reason: "cache read failed" },
  ])("$name", async ({ response, reason }) => {
    const assets = [makeAsset()];
    const db = cacheDb(response);
    const { previousAssetsById, cacheState: previousCacheState } = await loadPreviousStablecoinsById(db);
    const result = await evaluateFallbackStalenessFixture({ db, assets, previousAssetsById, previousCacheState, syncStartSec: NOW_SEC });
    expect("metadata" in result).toBe(false);
    expect(result).toMatchObject({ stalenessWarning: false, stalenessSummary: null, stalenessCheckFailed: true, stalenessCheckFailureReason: reason });
  });

  it("keeps fallback staleness abort handling unchanged", async () => {
    const controller = new AbortController();
    controller.abort("fallback abort");
    const result = await evaluateFallbackStalenessFixture({
      db: mockD1([]), assets: [makeAsset()], previousAssetsById: new Map(),
      previousCacheState: { state: "missing" }, syncStartSec: NOW_SEC, signal: controller.signal,
    });
    expect("metadata" in result).toBe(true);
    expect(result).toMatchObject({ aborted: true, status: "degraded", itemCount: 0 });
    expect(JSON.parse(("metadata" in result ? result.metadata : null) ?? "{}")).toMatchObject({
      reason: "aborted", stage: "fallback-detect-price-staleness", detail: "fallback abort",
      cacheWriteMode: "no-write", downstreamSafe: false, capabilities: { stablecoinsCache: false, depegPipeline: false },
    });
  });

  it("queues tracked-additions notice before fallback depeg follow-through", async () => {
    const db = mockD1([]);
    const assets = [makeAsset({ id: "fixture-new", geckoId: "fixture-new" })];
    const previousAssetsById = new Map<string, PeggedAsset>([["fixture-old", makeAsset({ id: "fixture-old", geckoId: "fixture-old" })]]);
    const result = await runStablecoinsPostIntakePublication({
      db, assets, previousAssetsById, previousCacheState: { state: "missing" }, previousActivePriceCoverage: null,
      syncStartSec: NOW_SEC, priceCacheEntries: [], providerDiagnostics: [],
      metadata: { path: "fallback", input: { enrichStats: {}, authoritativeOverrideCount: 0, rejectedCount: 0, cachedFallbackCount: 0 } },
    });
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(metadata).toMatchObject({
      depegPipelineSucceeded: true, providerDiagnostics: [], cacheWriteSucceeded: true, downstreamSafe: false,
      capabilities: { stablecoinsCache: false, depegPipeline: true }, activePublicationCoverage: { complete: false },
    });
    expect(metadata.activePriceCoverage.missingActiveIds).toContain("usdt-tether");
    expect(metadata.activePriceCoverage.missingActiveIds).not.toContain("fixture-new");
    expect(result.productivity).toEqual({
      productive: true, reason: "stablecoins-fallback-cache-published",
      publications: [{
        surface: "stablecoins", generationId: `stablecoins:${NOW_SEC}`, publishedAt: NOW_SEC,
        candidateRows: 1, publishedRows: 1, expectedRows: 1, artifactCacheKey: "stablecoins",
        validationSummary: { publicationPath: "coingecko-fallback" },
      }],
    });
    const noticeOrder = fallbackMocks.queueTrackedAdditionsNotice.mock.invocationCallOrder[0];
    const depegOrder = fallbackMocks.runDepegPipeline.mock.invocationCallOrder[0];
    expect(noticeOrder).toBeDefined();
    expect(depegOrder).toBeDefined();
    expect(noticeOrder!).toBeLessThan(depegOrder!);
    expect(fallbackMocks.queueTrackedAdditionsNotice).toHaveBeenCalledTimes(1);
    const noticeCall = fallbackMocks.queueTrackedAdditionsNotice.mock.calls[0];
    expect(noticeCall).toBeDefined();
    const [noticeDb, previousIds, noticeAssets] = noticeCall!;
    expect(noticeDb).toBe(db);
    expect(Array.from(previousIds as Iterable<string>)).toEqual(["fixture-old"]);
    expect(noticeAssets).toBe(assets);
    expect(fallbackMocks.runDepegPipeline).toHaveBeenCalledWith(db, assets, undefined, undefined, undefined, "fallback-", " (CG fallback)", undefined, undefined, undefined);
  });
});

describe("overlayFallbackCuratedAggregateSupply", () => {
  beforeEach(() => {
    onchainSupplyMocks.fetchCuratedAggregateOnChainMcap.mockReset();
    onchainSupplyMocks.fetchOnChainMcap.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([1, null])("preserves sFRAX's explicit publication hold after a failed overlay with price %s", async (price) => {
    onchainSupplyMocks.fetchCuratedAggregateOnChainMcap.mockResolvedValue(null);
    const assets = [makeAsset({ id: "sfrax-frax", price, supplySource: "coingecko-fallback" })];
    await overlayFallbackCuratedAggregateSupply(assets);
    expect(assets).toHaveLength(1);
    const [published] = normalizeStablecoinsPayload({ peggedAssets: assets }, NOW_SEC).peggedAssets;
    expect(published).toMatchObject({ supplySource: "onchain-supply-withheld", supplyUnavailableReason: "economic-float-unreconciled" });
    expect(published.circulating).toEqual({});
  });

  it.each(["usg-tangent", "usyc-hashnote", "jtrsy-anemoy"].map((id) => {
    const meta = ACTIVE_STABLECOINS.find((entry) => entry.id === id);
    if (!meta) throw new Error(`missing preferred supply fixture: ${id}`);
    return meta;
  }))(
    "withholds $id's supply without dropping its row when native supply cannot be admitted", async (meta) => {
      for (const price of [1, undefined]) {
        onchainSupplyMocks.fetchCuratedAggregateOnChainMcap.mockReset().mockResolvedValue(null);
        const assets = buildFallbackAssetsFromCoinGecko({
          stablecoins: [meta], syncStartSec: NOW_SEC,
          cgData: { [meta.geckoId!]: { usd: price, usd_market_cap: 1_000_000, last_updated_at: NOW_SEC } },
        });
        expect(assets).toHaveLength(1);
        await overlayFallbackCuratedAggregateSupply(assets);
        expect(assets).toHaveLength(1);
        expect(assets[0]).toMatchObject({ circulating: {}, supplySource: "onchain-supply-withheld" });
        expect(assets[0].supplyUnavailableReason).toBeUndefined();
        expect(onchainSupplyMocks.fetchCuratedAggregateOnChainMcap).toHaveBeenCalledTimes(price == null ? 0 : 1);
      }
    },
  );

  it("reads a preferred single-register asset instead of withholding its provable supply", async () => {
    onchainSupplyMocks.fetchCuratedAggregateOnChainMcap.mockResolvedValue(null);
    onchainSupplyMocks.fetchOnChainMcap.mockResolvedValue({
      mcap: 3_500_000,
      supplySource: "onchain-circulating-supply",
      observedAt: NOW_SEC,
      chain: "ethereum", chainLabel: "Ethereum", chainCirculating: { Ethereum: { current: 3_500_000, chainId: "ethereum" } },
    });
    const assets = [makeAsset({ id: "usg-tangent", price: 1.01, supplySource: "coingecko-fallback" })];
    await overlayFallbackCuratedAggregateSupply(assets);
    expect(onchainSupplyMocks.fetchOnChainMcap).toHaveBeenCalledTimes(1);
    expect(assets[0]).toMatchObject({
      supplySource: "onchain-circulating-supply", supplyObservedAt: NOW_SEC,
      circulating: { peggedUSD: 3_500_000 }, chainCirculating: { Ethereum: { current: 3_500_000 } },
    });
    expect(assets[0].supplyUnavailableReason).toBeUndefined();
  });

  it("threads the run's RPC map into the real single-register probe", async () => {
    const realOnchainSupply = await vi.importActual<typeof import("../supplemental-assets/onchain-supply")>("../supplemental-assets/onchain-supply");
    const evmRpc = await import("../../../lib/evm-rpc");
    const chainRpcs = buildChainRpcs();
    const blockHash = `0x${"1".repeat(64)}` as const;
    let keeperReads = 0;
    onchainSupplyMocks.fetchCuratedAggregateOnChainMcap.mockResolvedValue(null);
    onchainSupplyMocks.fetchOnChainMcap.mockImplementation(realOnchainSupply.fetchOnChainMcap);
    vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
    vi.spyOn(evmRpc, "fetchEvmBlockNumber").mockImplementation(async (_chain, options) => { expect(options?.chainRpcs).toBe(chainRpcs); return 123; });
    vi.spyOn(evmRpc, "fetchEvmBlockHeader").mockResolvedValue({ number: 123, hash: blockHash, timestamp: NOW_SEC });
    vi.spyOn(evmRpc, "fetchEvmUint256AtBlock").mockImplementation(async (_chain, _contract, data) => {
      if (data === TOTAL_SUPPLY_SELECTOR) return 4_000_000n * 10n ** 18n;
      keeperReads += 1;
      return keeperReads === 1 ? 300_000n * 10n ** 18n : 100_000n * 10n ** 18n;
    });
    const assets = [makeAsset({ id: "usg-tangent", price: 1.01, supplySource: "coingecko-fallback" })];
    await overlayFallbackCuratedAggregateSupply(assets, undefined, chainRpcs);
    expect(keeperReads).toBe(2);
    expect(assets[0]).toMatchObject({
      supplySource: "onchain-circulating-supply", supplyObservedAt: NOW_SEC,
      circulating: { peggedUSD: 3_636_000 }, chainCirculating: { Ethereum: { current: 3_636_000, chainId: "ethereum" } },
    });
    expect(assets[0].supplyUnavailableReason).toBeUndefined();
  });

  it("replaces fresh CoinGecko supply and incompatible history on a successful preferred read", async () => {
    const native = makeAsset({
      id: "usyc-hashnote", supplySource: "onchain-total-supply", supplyObservedAt: NOW_SEC - 60,
      supplyRestored: true, circulating: { peggedUSD: 300 }, chainCirculating: { Ethereum: { current: 100 }, Solana: { current: 200 } },
    });
    const fresh = [makeAsset({
      id: native.id, supplySource: "coingecko-fallback", supplyRestored: true,
      circulatingPrevDay: { peggedUSD: 1_000_000 }, circulatingPrevWeek: { peggedUSD: 900_000 }, circulatingPrevMonth: { peggedUSD: 800_000 },
      chainPartition: { basis: "onchain-share", observedAt: NOW_SEC - 60, onchainUsd: 1_000_000, ratio: 1, admission: "carried" },
      supplyUnavailableReason: "supply-chain-dropout",
      supplyGapFill: {
        method: "coingecko-single-missing-chain", admission: "entered", missingChainId: "solana",
        canonicalSource: "defillama", canonicalCurrentUsd: 800_000, supplementalSource: "coingecko",
        supplementalCurrentUsd: 1_000_000, ratio: 1.25, maxRatio: 1.5, observedAt: NOW_SEC - 60,
      },
      supplyChainGuard: {
        reason: "supply-chain-dropout", status: "quarantined", chains: [{
          chainId: "solana", chainLabel: "Solana", listCurrentUsd: null, baselineUsd: 200_000,
          baselineObservedAt: NOW_SEC - 60, baselineSource: "state", resolution: "carried-baseline",
        }],
      },
    })];
    onchainSupplyMocks.fetchCuratedAggregateOnChainMcap.mockResolvedValue({
      mcap: 400, supplySource: "onchain-total-supply", observedAt: NOW_SEC,
      chainCirculating: { Ethereum: { current: 100, chainId: "ethereum" }, Solana: { current: 300, chainId: "solana" } },
    });
    await overlayFallbackCuratedAggregateSupply(fresh);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ supplySource: "onchain-total-supply", supplyObservedAt: NOW_SEC,
      circulating: { peggedUSD: 400 }, chainCirculating: { Ethereum: { current: 100 }, Solana: { current: 300 } },
      circulatingPrevDay: null, circulatingPrevWeek: null, circulatingPrevMonth: null });
    expect([fresh[0].chainPartition, fresh[0].supplyRestored, fresh[0].supplyGapFill, fresh[0].supplyChainGuard, fresh[0].supplyUnavailableReason]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it.each([4_884_400_000 / 1.06, undefined])("replaces the whole curated supply packet with producer count %s", async (nativeSupply) => {
    onchainSupplyMocks.fetchCuratedAggregateOnChainMcap.mockResolvedValue({
      mcap: 4_884_400_000, nativeSupply, supplySource: "onchain-total-supply", observedAt: NOW_SEC + 10,
      chainCirculating: {
        Ethereum: { current: 4_517_720_000, chainId: "ethereum" }, Base: { current: 11_478_000, chainId: "base" },
        Optimism: { current: 4_876_000, chainId: "optimism" }, Arbitrum: { current: 346_620_000, chainId: "arbitrum" },
        Unichain: { current: 3_706_000, chainId: "unichain" },
      },
    });
    const susds = makeAsset({
      id: "susds-sky", symbol: "sUSDS", geckoId: "susds", price: 1.06, priceObservedAt: NOW_SEC - 60, priceObservedAtMode: "upstream",
      circulatingNative: 4_600_000_000, valuationPriceUsd: 1, valuationObservedAtSec: NOW_SEC - 90,
      supplySource: "coingecko-fallback", circulating: { peggedUSD: 4_600_000_000 },
      chainCirculating: { Ethereum: { current: null } }, chains: ["Ethereum"], supplyObservedAt: NOW_SEC,
    });
    const other = makeAsset({ id: "fixture-usd", chainCirculating: { Ethereum: { current: 1 } } });
    await overlayFallbackCuratedAggregateSupply([other, susds]);
    expect(onchainSupplyMocks.fetchCuratedAggregateOnChainMcap).toHaveBeenCalledTimes(1);
    const [meta, priceUsd] = onchainSupplyMocks.fetchCuratedAggregateOnChainMcap.mock.calls[0]!;
    expect((meta as { id: string }).id).toBe("susds-sky");
    expect(priceUsd).toBe(1.06);
    expect({
      supplyObservedAt: susds.supplyObservedAt, supplySource: susds.supplySource,
      circulating: susds.circulating, chains: susds.chains,
    }).toEqual({
      supplyObservedAt: NOW_SEC + 10, supplySource: "onchain-total-supply",
      circulating: { peggedUSD: 4_884_400_000 }, chains: ["Ethereum", "Base", "Optimism", "Arbitrum", "Unichain"],
    });
    expect([susds.circulatingNative, susds.valuationPriceUsd, susds.valuationObservedAtSec])
      .toEqual([nativeSupply, nativeSupply == null ? undefined : 1.06, nativeSupply == null ? undefined : NOW_SEC - 60]);
    const noHist = { circulatingPrevDay: undefined, circulatingPrevWeek: undefined, circulatingPrevMonth: undefined };
    expect(susds.chainCirculating).toEqual({
      Ethereum: { current: 4_517_720_000, chainId: "ethereum", ...noHist },
      Base: { current: 11_478_000, chainId: "base", ...noHist },
      Optimism: { current: 4_876_000, chainId: "optimism", ...noHist },
      Arbitrum: { current: 346_620_000, chainId: "arbitrum", ...noHist },
      Unichain: { current: 3_706_000, chainId: "unichain", ...noHist },
    });
    expect(other.chainCirculating).toEqual({ Ethereum: { current: 1 } });
  });

  it("keeps fresh aggregate and unavailable chains when a configured chain read fails", async () => {
    onchainSupplyMocks.fetchCuratedAggregateOnChainMcap.mockResolvedValue(null);
    const unavailableChains = { Ethereum: { current: null } };
    const susds = makeAsset({
      id: "susds-sky", symbol: "sUSDS", geckoId: "susds", price: 1.06, supplySource: "coingecko-fallback",
      circulating: { peggedUSD: 4_600_000_000 }, chainCirculating: unavailableChains, chains: ["Ethereum"], supplyObservedAt: NOW_SEC,
    });
    await overlayFallbackCuratedAggregateSupply([susds]);
    expect(onchainSupplyMocks.fetchCuratedAggregateOnChainMcap).toHaveBeenCalledTimes(1);
    expect(susds.chainCirculating).toBe(unavailableChains);
    expect({ chainCirculating: susds.chainCirculating, supplyObservedAt: susds.supplyObservedAt, chains: susds.chains, circulating: susds.circulating, supplySource: susds.supplySource })
      .toEqual({ chainCirculating: { Ethereum: { current: null } }, supplyObservedAt: NOW_SEC, chains: ["Ethereum"], circulating: { peggedUSD: 4_600_000_000 }, supplySource: "coingecko-fallback" });
  });

  it("does not par-value a missing NAV price for the curated aggregate overlay", async () => {
    const susds = makeAsset({ id: "susds-sky", symbol: "sUSDS", geckoId: "susds", price: null, supplySource: "coingecko-fallback", circulating: { peggedUSD: 4_600_000_000 }, chainCirculating: {}, chains: [] });
    await overlayFallbackCuratedAggregateSupply([susds]);
    expect(onchainSupplyMocks.fetchCuratedAggregateOnChainMcap).not.toHaveBeenCalled();
    expect({ circulating: susds.circulating, chainCirculating: susds.chainCirculating }).toEqual({ circulating: { peggedUSD: 4_600_000_000 }, chainCirculating: {} });
  });
});
