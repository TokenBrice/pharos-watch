import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { WORKER_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
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
  buildMainStablecoinsPublicationPolicy,
  buildFallbackStablecoinsPublicationPolicy,
  runStablecoinsPostIntakePublication,
  type StablecoinsPostIntakePublicationContext,
} from "../publication";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); });

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
      returnIfAborted: () => null, abortResult: () => ({ aborted: true, metadata: "aborted" }),
    } satisfies Omit<StablecoinsPostIntakePublicationContext, "metadata" | "policy">;
    const input = path === "main" ? {
      ...base,
      policy: buildMainStablecoinsPublicationPolicy({ assets, rawAssetCount: assets.length, droppedMalformedAssets: 0 }),
      metadata: { path: "main", input: {
        rawAssetCount: assets.length, droppedMalformedAssets: 0,
        canonicalDeduplication: { dedupedAssets: assets, duplicateRows: 0, affectedIds: [] },
        enrichStats: {}, priceValidationStats: {}, rejectedCount: 0, gtProbe: { stats: createEmptyGtProbeStats() },
      } },
    } satisfies StablecoinsPostIntakePublicationContext : {
      ...base,
      policy: buildFallbackStablecoinsPublicationPolicy(assets),
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
