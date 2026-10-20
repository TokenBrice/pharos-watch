import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { WORKER_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { getCirculatingRawOrNull, getPrevDayRawOrNull, getPrevWeekRawOrNull, getPrevMonthRawOrNull } from "@shared/lib/supply";
import type { PeggedAsset } from "../enrich-prices";
import * as fetchRetry from "../../../lib/fetch-retry";
import * as onchain from "../supplemental-assets/onchain-supply";
import { reconcileTrackedSupplyGaps } from "../supply-gap-reconciliation";
import { makePeggedAsset } from "./_fixtures";
import * as phase from "../phase-helpers";
import * as runtime from "../runtime";
import * as post from "../post-enrichment";
import * as notices from "../telegram-tracked-additions";
import * as circuit from "../../../lib/circuit-breaker";
import { getCache, getPriceCache } from "../../../lib/db-cache";
import { evaluateStablecoinActivePriceCoverage } from "../../../lib/stablecoin-publication-coverage";
import { createEmptyGtProbeStats } from "../../../lib/geckoterminal-price-probe-stats";
import {
  runStablecoinsPostIntakePublication,
  type StablecoinsPostIntakePublicationContext,
} from "../publication";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); });

function publicationInput(path: "main" | "fallback", db: D1Database, assets: PeggedAsset[]): StablecoinsPostIntakePublicationContext {
  const base = {
    db, assets, syncStartSec: 1_800_000_000, previousAssetsById: new Map<string, PeggedAsset>(),
    previousCacheState: { state: "missing" as const }, previousActivePriceCoverage: null,
    priceCacheEntries: [], providerDiagnostics: [],
  };
  return path === "main" ? { ...base, metadata: { path, input: {
    rawAssetCount: assets.length, droppedMalformedAssets: 0,
    canonicalDeduplication: { duplicateRows: 0, affectedIds: [] },
    enrichStats: null, priceValidationStats: {}, rejectedCount: 0, gtProbe: { stats: createEmptyGtProbeStats() },
  } } } : { ...base, metadata: { path, input: {
    enrichStats: {}, authoritativeOverrideCount: 0, rejectedCount: 0,
    cachedFallbackCount: 0, nativePegCorrectionCount: 0, nativePegFillCount: 0,
  } } };
}

describe("publication path authority", () => {
  it.each(["main", "fallback"] as const)("preserves %s operational labels, terminal metadata and circuit bookkeeping", async (path) => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { db } = fixtures.open();
    const assets = [makePeggedAsset({
      id: "fixture-usd", price: 1, pegMechanism: "fiat-backed",
      circulating: { peggedUSD: 100 }, chainCirculating: {}, chains: [],
    }), ...WORKER_ACTIVE_STABLECOINS.map((meta) => makePeggedAsset({
      id: meta.id, name: meta.name, symbol: meta.symbol, price: 1, priceSource: "coingecko",
      pegMechanism: "fiat-backed", circulating: { peggedUSD: 100 }, chainCirculating: {}, chains: [],
    }))];
    vi.spyOn(phase, "fillMissingSupplyHistory").mockResolvedValue(0);
    vi.spyOn(notices, "queueTrackedAdditionsNotice").mockResolvedValue(undefined);
    const depeg = vi.spyOn(post, "runDepegPipeline").mockResolvedValue({
      depegErrorCount: 0, depegErrors: [], providerDiagnostics: [],
    });
    const record = vi.spyOn(circuit, "recordOutcome");
    const stages: string[] = [];
    const result = await runStablecoinsPostIntakePublication({
      ...publicationInput(path, db, assets),
      reportProgress: async (update) => { stages.push(update.stage!); },
    });
    expect(stages).toEqual(path === "main"
      ? ["staleness-check", "cache-validation", "cache-write", "depeg-pipeline", "complete"]
      : ["fallback-staleness-check", "fallback-cache-validation", "fallback-cache-write", "fallback-depeg-pipeline", "complete"]);
    expect(record.mock.calls).toEqual(path === "main" ? [[db, "defillama-stablecoins", true]] : []);
    expect(depeg).toHaveBeenCalledWith(
      db, assets, undefined, undefined, undefined,
      path === "main" ? "" : "fallback-", path === "main" ? "" : " (CG fallback)", undefined, undefined,
    );
    expect(JSON.parse(result.metadata!)).toMatchObject({
      rowsRead: assets.length, rowsWritten: assets.length, rowsDropped: 0, cacheWriteSucceeded: true, depegPipelineSucceeded: true,
      upstreamFetchOk: path === "main", fallbackMode: path === "main" ? null : "coingecko-supply-fallback",
    });
    expect(JSON.parse((await getCache(db, "stablecoins"))!.value).peggedAssets[0]).toMatchObject({
      id: "fixture-usd", circulating: assets[0].circulating,
    });
  });

  it.each(["main", "fallback"] as const)("retains %s mid-stage cancellation metadata and writes no generation", async (path) => {
    const { db } = fixtures.open();
    const controller = new AbortController();
    vi.spyOn(phase, "fillMissingSupplyHistory").mockImplementation(async () => {
      controller.abort("cancel after history");
      return 0;
    });
    const result = await runStablecoinsPostIntakePublication({
      ...publicationInput(path, db, [makePeggedAsset()]), signal: controller.signal,
    });
    expect(JSON.parse(result.metadata!)).toMatchObject({
      reason: "aborted", detail: "cancel after history",
      stage: path === "main" ? "detect-price-staleness" : "fallback-detect-price-staleness",
      cacheWriteMode: "no-write", capabilities: { stablecoinsCache: false, depegPipeline: false },
    });
    expect(await getCache(db, "stablecoins")).toBeNull();
    expect(await getPriceCache(db)).toEqual(new Map());
  });
});

async function publishSupplyPacket(asset: PeggedAsset, path: "main" | "fallback"): Promise<PeggedAsset> {
  const { db, sqlite } = fixtures.open();
  const now = Math.floor(Date.now() / 1000);
  const ordinary = makePeggedAsset({
    id: "usdc-circle", price: 1, priceSource: "coingecko", pegMechanism: "fiat-backed",
    circulating: { peggedUSD: 100 }, chainCirculating: {}, chains: [], supplySource: "coingecko",
  });
  const healthy = WORKER_ACTIVE_STABLECOINS.filter((meta) => meta.id !== asset.id && meta.id !== ordinary.id)
    .map((meta) => makePeggedAsset({
      id: meta.id, name: meta.name, symbol: meta.symbol, price: 1, priceSource: "coingecko",
      pegMechanism: "fiat-backed", circulating: { peggedUSD: 1000 }, chainCirculating: {}, chains: [],
    }));
  const assets = [...healthy, ordinary, asset];
  const date = new Date();
  for (const row of [ordinary, asset]) {
    for (const days of [1, 7, 30]) {
      const snapshotDate = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - days) / 1000;
      sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd) VALUES (?, ?, ?)")
        .run(row.id, snapshotDate, getCirculatingRawOrNull(row)! * 0.95);
    }
  }
  vi.spyOn(runtime, "checkStablecoinsPriceStaleness").mockResolvedValue({
    state: "ok", stalenessWarning: false, stalenessSummary: { compared: 1, identical: 0, identicalRatio: 0 }, stalenessCheckFailed: false,
  });
  vi.spyOn(post, "runDepegPipeline").mockResolvedValue({ depegErrorCount: 0, depegErrors: [], providerDiagnostics: [] });
  vi.spyOn(notices, "queueTrackedAdditionsNotice").mockResolvedValue(undefined);
  const circuitRecord = {
    state: "closed", consecutiveFailures: 0, lastFailureAt: null, lastSuccessAt: now, openedAt: null,
  } satisfies circuit.CircuitRecord;
  vi.spyOn(circuit, "recordOutcome").mockResolvedValue({ before: circuitRecord, after: circuitRecord });
  const base = {
    db, assets, syncStartSec: now, previousAssetsById: new Map<string, PeggedAsset>(),
    previousCacheState: { state: "ok" }, previousActivePriceCoverage: null, priceCacheEntries: [], providerDiagnostics: [],
  } satisfies Omit<StablecoinsPostIntakePublicationContext, "metadata">;
  const input: StablecoinsPostIntakePublicationContext = path === "main" ? {
    ...base,
    metadata: { path: "main", input: {
      rawAssetCount: assets.length, droppedMalformedAssets: 0,
      canonicalDeduplication: { duplicateRows: 0, affectedIds: [] },
      enrichStats: {}, priceValidationStats: {}, rejectedCount: 0, gtProbe: { stats: createEmptyGtProbeStats() },
    } },
  } : {
    ...base,
    metadata: { path: "fallback", input: { enrichStats: {}, authoritativeOverrideCount: 0, rejectedCount: 0,
      cachedFallbackCount: 0, nativePegCorrectionCount: 0, nativePegFillCount: 0 } },
  };
  await runStablecoinsPostIntakePublication(input);
  const cached: { peggedAssets: PeggedAsset[] } = JSON.parse((await getCache(db, "stablecoins"))!.value);
  expect(cached.peggedAssets.find((row) => row.id === ordinary.id)).toMatchObject({
    circulatingPrevDay: { peggedUSD: 95 }, circulatingPrevWeek: { peggedUSD: 95 }, circulatingPrevMonth: { peggedUSD: 95 },
  });
  const published = cached.peggedAssets.find((row) => row.id === asset.id);
  expect(published).toBeDefined();
  return published!;
}

describe("source-owned supply history publication", () => {
  it.each([
    ["day", "circulatingPrevDay", getPrevDayRawOrNull],
    ["week", "circulatingPrevWeek", getPrevWeekRawOrNull],
    ["month", "circulatingPrevMonth", getPrevMonthRawOrNull],
  ] as const)("preserves unavailable %s through fresh and carried CoinGecko publication", async (bucket, field, readHistory) => {
    const nowMs = Date.now();
    const original = makePeggedAsset({
      id: "eurcv-societe-generale-forge", name: "EUR CoinVertible", symbol: "EURCV",
      pegType: "peggedEUR", pegMechanism: "fiat-backed", price: 1, priceSource: "coingecko",
      supplySource: "defillama", circulating: { peggedEUR: 100 },
      circulatingPrevDay: { peggedEUR: 90 }, circulatingPrevWeek: { peggedEUR: 80 }, circulatingPrevMonth: { peggedEUR: 70 },
      chainCirculating: {
        Ethereum: { current: 60, circulatingPrevDay: 54, circulatingPrevWeek: 48, circulatingPrevMonth: 42 },
        Solana: { current: 30, circulatingPrevDay: 27, circulatingPrevWeek: 24, circulatingPrevMonth: 21 },
        Stellar: { current: 10, circulatingPrevDay: 9, circulatingPrevWeek: 8, circulatingPrevMonth: 7 },
      }, chains: ["Ethereum", "Solana", "Stellar"],
    });
    original[field] = null;
    vi.spyOn(fetchRetry, "fetchTextWithRetry").mockImplementation(async (url) => ({
      response: new Response(null, { status: 200 }),
      body: JSON.stringify(String(url).includes("/simple/price")
        ? { "societe-generale-forge-eurcv": { usd_market_cap: 130, last_updated_at: Math.floor(nowMs / 1000) } }
        : { market_caps: [[nowMs - 30 * 86400_000, 70], [nowMs - 7 * 86400_000, 80], [nowMs - 86400_000, 90], [nowMs, 130]] }),
    }));
    expect((await reconcileTrackedSupplyGaps([original])).totalReconciled).toBe(1);
    expect(original[field]).toBeNull();
    const freshPacket = structuredClone(original);
    const published = await publishSupplyPacket(original, "main");
    expect(readHistory(published)).toBeNull();
    expect(published.circulating).toEqual({ peggedEUR: 130 });
    expect(published.chainCirculating).toEqual(freshPacket.chainCirculating);
    expect(published.supplyGapFill).toEqual(freshPacket.supplyGapFill);

    vi.mocked(fetchRetry.fetchTextWithRetry).mockResolvedValue({ response: new Response(null, { status: 429 }), body: "" });
    const carried = makePeggedAsset({ ...freshPacket, supplySource: "defillama", circulating: { peggedEUR: 100 },
      chainCirculating: { Ethereum: { current: 100 } } });
    await reconcileTrackedSupplyGaps([carried], undefined, null, undefined, undefined, new Map([[original.id, freshPacket]]));
    expect(carried.supplyRestored).toBe(true);
    const carriedPacket = structuredClone(carried);
    const publishedCarry = await publishSupplyPacket(carried, "fallback");
    expect(readHistory(publishedCarry)).toBeNull();
    expect(publishedCarry.circulating).toEqual({ peggedEUR: 130 });
    expect(publishedCarry.chainCirculating).toEqual(carriedPacket.chainCirculating);
    expect(publishedCarry.supplyGapFill).toEqual({
      ...freshPacket.supplyGapFill, carryForwardRuns: 1,
      withheldHistoricalBuckets: [bucket], withheldHistoricalBucketReasons: { [bucket]: "history-unobserved" },
    });
    expect(publishedCarry.supplyObservedAt).toBe(freshPacket.supplyObservedAt);
  });

  it.each(["onchain-total-supply", "onchain-circulating-supply"] as const)(
    "preserves current-only %s history through reconciliation and publication", async (supplySource) => {
      const now = Math.floor(Date.now() / 1000);
      const asset = makePeggedAsset({
        id: "cadd-cad-digital", name: "CAD Digital", symbol: "CADD", pegType: "peggedCAD",
        pegMechanism: "fiat-backed", price: 1, priceSource: "coingecko", supplySource: "defillama",
        circulating: { peggedCAD: 0 }, chainCirculating: {}, chains: [],
      });
      vi.spyOn(fetchRetry, "fetchTextWithRetry").mockResolvedValue({ response: new Response(null, { status: 200 }), body: "[]" });
      vi.spyOn(onchain, "fetchCuratedAggregateOnChainMcap").mockResolvedValue({
        mcap: 3_000_000, supplySource, observedAt: now, chainCirculating: { Ethereum: { current: 3_000_000, chainId: "ethereum" } },
      });
      expect((await reconcileTrackedSupplyGaps([asset], undefined, null, undefined, { peggedCAD: 0.72 })).totalReconciled).toBe(1);
      const published = await publishSupplyPacket(asset, "main");
      expect([getPrevDayRawOrNull(published), getPrevWeekRawOrNull(published), getPrevMonthRawOrNull(published)]).toEqual([null, null, null]);
      expect(published).toMatchObject({
        circulating: { peggedCAD: 3_000_000 }, supplySource, supplyObservedAt: now,
        chainCirculating: { Ethereum: { current: 3_000_000, chainId: "ethereum" } },
      });
    },
  );
});

describe("stablecoins publication cohort", () => {
  it.each(["main", "fallback"] as const)("uses admitted %s rows for coverage, continuity, attempts and replay generations", async (path) => {
    const { db, sqlite } = fixtures.open();
    const now = Math.floor(Date.now() / 1000);
    const rejectedId = "usdc-circle";
    const healthy = WORKER_ACTIVE_STABLECOINS.filter((meta) => meta.id !== rejectedId).map((meta) => makePeggedAsset({
      id: meta.id, name: meta.name, symbol: meta.symbol, price: 1, priceSource: "coingecko",
      priceConfidence: "single-source", priceObservedAt: now, priceObservedAtMode: "upstream",
      pegMechanism: "fiat-backed",
      circulating: { peggedUSD: 1000 }, chainCirculating: {}, chains: [],
    }));
    expect(healthy.length).toBeGreaterThanOrEqual(50);
    const previous = makePeggedAsset({ id: rejectedId, pegMechanism: "fiat-backed", price: 0.99, priceSource: "coingecko",
      priceObservedAt: now - 900, priceObservedAtMode: "upstream", circulating: { peggedUSD: 500 }, supplyObservedAt: now - 900 });
    const invalid = makePeggedAsset({ ...previous, price: 1, priceObservedAt: now, circulatingPrevDay: { peggedUSD: -1 } });
    const assets = [...healthy, invalid];
    const previousCoverage = evaluateStablecoinActivePriceCoverage(healthy);
    sqlite.prepare("INSERT INTO price_cache (asset_id, price, updated_at, synced_at) VALUES (?, ?, ?, ?)")
      .run(rejectedId, 0.99, now - 900, now - 900);
    const priorReplay = (await getPriceCache(db)).get(rejectedId);
    vi.spyOn(phase, "fillMissingSupplyHistory").mockResolvedValue(0);
    vi.spyOn(runtime, "checkStablecoinsPriceStaleness").mockResolvedValue({
      state: "ok", stalenessWarning: false, stalenessSummary: { compared: 1, identical: 0, identicalRatio: 0 }, stalenessCheckFailed: false,
    });
    vi.spyOn(post, "runDepegPipeline").mockResolvedValue({ depegErrorCount: 0, depegErrors: [], providerDiagnostics: [] });
    vi.spyOn(notices, "queueTrackedAdditionsNotice").mockResolvedValue(undefined);
    const circuitRecord = {
      state: "closed", consecutiveFailures: 0, lastFailureAt: null, lastSuccessAt: now, openedAt: null,
    } satisfies circuit.CircuitRecord;
    vi.spyOn(circuit, "recordOutcome").mockResolvedValue({ before: circuitRecord, after: circuitRecord });
    const base = {
      db, assets, syncStartSec: now, previousAssetsById: new Map([[rejectedId, previous]]),
      previousCacheState: { state: "ok" }, previousActivePriceCoverage: previousCoverage,
      priceCacheEntries: [healthy[0]!, invalid].map((asset) => ({ id: asset.id, price: 1, source: "coingecko", observedAt: now, syncedAt: now })),
      providerDiagnostics: [{ source: "coingecko", stage: "primary", endpoint: "test", status: 200, ok: true, success: true,
        assetAttempts: [{ assetId: rejectedId, adapter: "coingecko", source: "coingecko", state: "attempted", result: "resolved", replaySafe: true }] }],
    } satisfies Omit<StablecoinsPostIntakePublicationContext, "metadata">;
    const input = path === "main" ? {
      ...base,
      metadata: { path: "main", input: {
        rawAssetCount: assets.length, droppedMalformedAssets: 0,
        canonicalDeduplication: { duplicateRows: 0, affectedIds: [] },
        enrichStats: {}, priceValidationStats: {}, rejectedCount: 0, gtProbe: { stats: createEmptyGtProbeStats() },
      } },
    } satisfies StablecoinsPostIntakePublicationContext : {
      ...base,
      metadata: { path: "fallback", input: { enrichStats: {}, authoritativeOverrideCount: 0, rejectedCount: 0,
        cachedFallbackCount: 0, nativePegCorrectionCount: 0, nativePegFillCount: 0 } },
    } satisfies StablecoinsPostIntakePublicationContext;
    const result = await runStablecoinsPostIntakePublication(input);
    const cached = JSON.parse((await getCache(db, "stablecoins"))!.value);
    expect(cached.peggedAssets.map((asset: { id: string }) => asset.id)).toEqual(healthy.map((asset) => asset.id));
    const metadata = JSON.parse(result.metadata!);
    expect(metadata.activePriceCoverage.pricedActiveIds).not.toContain(rejectedId);
    expect(metadata.activePriceCoverage.pricedActiveCount).toBe(healthy.length);
    expect(metadata.activePriceCoverage.presentActiveCount).toBe(healthy.length);
    expect(metadata.activePriceCoverage.missingActiveIds).toEqual([rejectedId]);
    expect(metadata.activePriceCoverage.missingActiveAssets[0]).toMatchObject({
      stablecoinId: rejectedId, consecutiveMissingGenerations: 2, lastAcceptedPrice: 0.99,
      lastKnownMarketCapUsd: 500, lastKnownMarketCapObservedAt: now - 900,
    });
    expect(metadata.priceSourceAttemptLedger).toMatchObject({ missingActiveIds: [rejectedId], recordCount: 1 });
    const replay = await getPriceCache(db);
    expect(replay.get(rejectedId)).toEqual(priorReplay);
    expect(replay.get(healthy[0]!.id)?.syncedAt).toBe(now);
  });
});
