import { afterEach, describe, expect, it, vi } from "vitest";
import * as currentPeg from "../../../lib/current-peg-observations";
import { handlePegSummary } from "../../../api/peg-summary";
import { CurrentPegSchema } from "@shared/types/current-peg";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import { overlayCanonicalDetail } from "../../../api/stablecoin-detail/price";
import { DEX_PRICE_CHECK_FRESHNESS_SEC } from "../../../lib/constants";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { encodeResponseReadyCacheValue, getResponseReadyCacheKey } from "../../../lib/api-cache-read";
import { RESPONSE_READY_CACHE_SCHEMA_IDS } from "../../../lib/response-ready-cache-contracts";
import { commitReplayPriceCache, validateAndWriteStablecoinsCache } from "../cache-publication";
import { loadPreviousStablecoinsById, mergeSupplementalLastKnownGood, normalizeStablecoinsPayload } from "../shared";
import { normalizeChainCirculating } from "../phase-helpers";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getCache, getPriceCache } from "../../../lib/db-cache";
import { makePeggedAsset } from "./_fixtures";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { StablecoinDetailResponseSchema, StablecoinListResponseSchema } from "@shared/types/market";
import type { PeggedAsset } from "../enrich-prices";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); });

describe("validateAndWriteStablecoinsCache", () => {
  it.each([[0.8, false], [null, false], [0.8, true]] as const)("publishes quote-bound fields at %s with DEX overload=%s", async (price, overload) => {
    const derive = vi.spyOn(currentPeg, "deriveCurrentPegObservationMap");
    const { db, sqlite } = fixtures.open();
    vi.spyOn(Date, "now").mockReturnValue(1_777_000_100_000);
    sqlite.prepare("INSERT INTO dex_prices (stablecoin_id, symbol, dex_price_usd, source_pool_count, source_total_tvl, updated_at, price_sources_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("usdc-circle", "USDC", 0.8, 4, 10_000_000, 1_777_000_090,
        JSON.stringify({ aggregateObservedAt: 1_777_000_101 - DEX_PRICE_CHECK_FRESHNESS_SEC, sources: [] }));
    const prepare = db.prepare.bind(db);
    const dexRead = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (overload && sql.includes("FROM dex_prices")) throw new Error("D1 DB is overloaded: consumed within a 10 second window");
      return prepare(sql);
    });
    const chainPartition = {
      basis: "onchain-share", observedAt: 1_777_000_000, onchainUsd: 102, ratio: 1.02, admission: "carried",
    } as const;
    const asset = makePeggedAsset({
      id: "usdc-circle", pegMechanism: "fiat-backed", price, priceSource: "coingecko",
      priceConfidence: "single-source", priceObservedAt: 1_777_000_000, priceObservedAtMode: "upstream",
      agreeSources: ["coingecko"], consensusSources: ["coingecko"],
      circulating: { peggedUSD: 2_000_000 }, circulatingPrevDay: { peggedUSD: 90 },
      supplySource: "coingecko-fallback", supplyObservedAt: 1_777_000_050,
      chainCirculating: { Ethereum: { chainId: "ethereum", current: 100 } }, chains: ["Ethereum"], chainPartition,
    });
    await validateAndWriteStablecoinsCache({
      assets: [asset], db, syncStartSec: 1_777_000_100, validationContext: "main",
    }, () => ({ metadata: "blocked" }));
    dexRead.mockRestore();
    const canonical = JSON.parse((await getCache(db, "stablecoins"))!.value);
    expect(StablecoinListResponseSchema.parse(canonical).peggedAssets[0]).toMatchObject({
      chainPartition, circulating: asset.circulating, circulatingPrevDay: asset.circulatingPrevDay,
      supplySource: asset.supplySource, supplyObservedAt: asset.supplyObservedAt,
    });
    const companion = JSON.parse((await getCache(db, getResponseReadyCacheKey("stablecoins")))!.value) as { body: string };
    expect(JSON.parse(companion.body)).toEqual(canonical);
    expect((await loadPreviousStablecoinsById(db)).previousAssetsById.get(asset.id)?.chainPartition).toEqual(chainPartition);
    const published = canonical.peggedAssets[0];
    expect(published.currentPeg).toMatchObject({ currentDeviationBps: price == null ? null : -2_000, currentPriceUnavailable: price == null });
    expect(published.price).toBe(price);
    expect(published.currentPeg.dexPriceCheckExpiresAt).toBe(price == null || overload ? null : 1_777_000_101);
    expect(published.currentPeg.dexPriceCheck?.agrees ?? null).toBe(price == null || overload ? null : true);
    expect(derive).toHaveBeenCalledOnce();
    derive.mockClear();
    const summary = await (await handlePegSummary(db)).json() as { coins: { id: string }[] };
    const summaryCoin = summary.coins.find(({ id }) => id === asset.id);
    expect(CurrentPegSchema.parse({ ...summaryCoin, dexPriceCheck: published.currentPeg.dexPriceCheck, dexPriceCheckExpiresAt: published.currentPeg.dexPriceCheckExpiresAt })).toEqual(published.currentPeg);
    expect(derive).toHaveBeenCalledTimes(2);
    const detail = await (await overlayCanonicalDetail(db, asset.id, Response.json({ price: 1 }))).json();
    expect(projectStablecoinLiveSummary(StablecoinDetailResponseSchema.parse(detail))).toMatchObject({ price, currentPeg: published.currentPeg });
  });

  it.each(["main", "fallback"] as const)("withholds sFRAX current supply and retained chain quantities at %s publication", async (validationContext) => {
    const db = fixtures.open().db;
    const assets = [makePeggedAsset({
      id: "sfrax-frax", name: "Staked FRAX", symbol: "sFRAX", pegType: "peggedUSD", pegMechanism: "crypto-backed", price: 1.14,
      circulating: { peggedUSD: 64_000_000 }, circulatingPrevDay: { peggedUSD: 63_000_000 },
      supplySource: "onchain-total-supply", supplyObservedAt: 1_777_000_000, supplyRestored: true,
      chains: ["Ethereum", "Arbitrum"],
      chainCirculating: { Ethereum: { current: 63_900_000 }, Arbitrum: { current: 100_000 } },
    })];
    const result = await validateAndWriteStablecoinsCache({
      assets, db, syncStartSec: 1_777_000_001, validationContext,
    }, () => ({ metadata: "blocked" }));
    expect(result).toMatchObject({ written: true, quarantinedAssets: [] });
    const cached = await getCache(db, "stablecoins");
    const payload = StablecoinListResponseSchema.parse(JSON.parse(cached!.value));
    const held = payload.peggedAssets[0]!;
    expect(held).toMatchObject({
      id: "sfrax-frax", circulating: {}, circulatingPrevDay: {}, circulatingPrevWeek: {}, circulatingPrevMonth: {},
      supplySource: "onchain-supply-withheld", supplyUnavailableReason: "economic-float-unreconciled", price: 1.14,
    });
    expect(getCirculatingRawOrNull(held)).toBeNull();
    expect(held.supplyObservedAt).toBeUndefined();
    expect(held.supplyRestored).toBeUndefined();
    expect(held.chainCirculating.Solana).toMatchObject({ chainId: "solana", current: null });
    expect(Object.values(held.chainCirculating)).toHaveLength(10);
    expect(Object.values(held.chainCirculating).every(({ current }) => current === null)).toBe(true);
    // Subsequent same-run consumers must see the refusal too, not the old input.
    expect(getCirculatingRawOrNull(assets[0])).toBeNull();
    expect(assets[0]!.supplyUnavailableReason).toBe("economic-float-unreconciled");
    const companion = JSON.parse((await getCache(db, getResponseReadyCacheKey("stablecoins")))!.value) as { body: string };
    expect(JSON.parse(companion.body)).toEqual(JSON.parse(cached!.value));
  });

  it("does not resurrect a previously overstated sFRAX aggregate during supplemental carry", () => {
    const current = makePeggedAsset({ id: "sfrax-frax", circulating: {}, chainCirculating: {} });
    const previous = makePeggedAsset({
      id: "sfrax-frax", circulating: { peggedUSD: 64_000_000 }, supplySource: "coingecko-fallback", supplyObservedAt: 1_777_000_000,
    });
    const merged = mergeSupplementalLastKnownGood([current], new Map([[previous.id, previous]]), new Set(), 1_777_000_001);
    expect(merged.restoredCount).toBe(0);
    expect(getCirculatingRawOrNull(merged.assets[0])).toBeNull();
    expect(merged.assets[0]!.supplyUnavailableReason).toBe("economic-float-unreconciled");
  });

  it("writes byte-identical canonical and replay-price payloads for main and fallback policies", async () => {
    const syncStartSec = 1_777_000_000;
    const fxFallbackRates = { EUR: 1.1 };
    const priceCacheEntries = [{
      id: "fixture-usd",
      price: 1,
      source: "coingecko",
      confidence: "single-source" as const,
      observedAt: syncStartSec - 30,
      observedAtMode: "upstream" as const,
      syncedAt: syncStartSec,
      agreeSources: ["coingecko"],
      consensusSources: ["coingecko"],
    }];
    const mainDb = fixtures.open().db;
    const fallbackDb = fixtures.open().db;

    for (const [db, validationContext, stagePrefix] of [
      [mainDb, "main", undefined],
      [fallbackDb, "fallback", "fallback-"],
    ] as const) {
      await validateAndWriteStablecoinsCache({
        assets: [],
        fxFallbackRates,
        db,
        syncStartSec,
        validationContext,
      }, () => ({ metadata: "blocked" }));
      await commitReplayPriceCache({
        db,
        entries: priceCacheEntries,
        stagePrefix,
      });
    }

    for (const db of [mainDb, fallbackDb]) {
      expect(await getCache(db, "stablecoins")).toEqual({
        value: JSON.stringify({ peggedAssets: [], fxFallbackRates }), updatedAt: syncStartSec,
      });
      expect([...(await getPriceCache(db))]).toEqual([["fixture-usd", {
        price: 1, source: "coingecko", confidence: "single-source",
        updatedAt: syncStartSec - 30, observedAt: syncStartSec - 30,
        observedAtMode: "upstream", syncedAt: syncStartSec,
        hasExplicitClocks: true,
        agreeSources: ["coingecko"], consensusSources: ["coingecko"],
      }]]);
    }
  });

  it.each(["invalid", "newer", "aborted"] as const)("preserves published generations when %s blocks publication", async (gate) => {
    const { db, sqlite } = fixtures.open();
    const companionKey = getResponseReadyCacheKey("stablecoins");
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("stablecoins", "prior", 200);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(companionKey, "companion", 50);
    const controller = new AbortController();
    if (gate === "aborted") controller.abort("cancelled before cache publication");
    const result = await validateAndWriteStablecoinsCache({
      db, assets: gate === "invalid" ? [makePeggedAsset({ name: 42 as never })] : [],
      syncStartSec: gate === "newer" ? 100 : 300, validationContext: "main",
      signal: controller.signal,
    }, () => ({ metadata: "blocked" }));
    expect(await getCache(db, "stablecoins")).toEqual({ value: "prior", updatedAt: 200 });
    expect(await getCache(db, companionKey)).toEqual({ value: "companion", updatedAt: 50 });
    if (gate === "invalid") {
      expect(result).toMatchObject({ written: false, blockedResult: { metadata: "blocked" } });
      expect(sqlite.prepare("SELECT key FROM cache WHERE key NOT IN (?, ?)").all("stablecoins", companionKey))
        .toEqual([expect.objectContaining({ key: expect.stringContaining("invalid") })]);
    } else if (gate === "newer") {
      expect(result).toMatchObject({ written: false, skippedBecauseNewer: true });
    } else {
      expect(result).toMatchObject({ aborted: true });
    }
  });

  it("preserves the replay generation when cancellation blocks persistence", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO price_cache (asset_id, price, updated_at, synced_at) VALUES (?, ?, ?, ?)")
      .run("fixture-usd", 0.99, 100, 100);
    const before = await getPriceCache(db);
    const result = await commitReplayPriceCache({
      db, entries: [{ id: "fixture-usd", price: 1, syncedAt: 200 }],
      signal: AbortSignal.abort("cancelled before replay persistence"),
    });
    expect(result).toMatchObject({ aborted: true });
    expect(JSON.parse(result!.metadata!)).toMatchObject({ stage: "save-price-cache", reason: "aborted" });
    expect(await getPriceCache(db)).toEqual(before);
  });

  it("normalizes every unusable price to explicit missing provenance", () => {
    const payload = normalizeStablecoinsPayload({
      peggedAssets: [makePeggedAsset({
        price: null, priceSource: "coingecko", priceSelectedSource: "coingecko", priceConfidence: "single-source",
        priceUpdatedAt: 1_700_000_000, priceObservedAt: 1_700_000_000, priceObservedAtMode: "upstream", priceSyncedAt: 1_700_000_010,
        consensusSources: ["coingecko"], agreeSources: ["coingecko"],
        priceSourceConfidenceProfile: { activeDexLanes: 1, freshestDexLaneAgeSec: 30, aggregateLaneOnly: false },
      })],
    });

    expect(payload.peggedAssets[0]).toMatchObject({
      price: null, priceSource: "missing", priceSelectedSource: null, priceConfidence: null,
      priceUpdatedAt: null, priceObservedAt: null, priceObservedAtMode: null, priceSyncedAt: null,
      consensusSources: [], agreeSources: [], priceSourceConfidenceProfile: null,
    });
  });

  it("keeps canonical stablecoins publication successful when response-ready cache write fails", async () => {
    const syncStartSec = 1_777_000_000;
    const body = JSON.stringify({ peggedAssets: [] });
    const responseReadyBody = encodeResponseReadyCacheValue(body, RESPONSE_READY_CACHE_SCHEMA_IDS.stablecoins);
    const db = mockD1(
      [
        {
          match: "INSERT INTO cache",
          matchBinds: ["stablecoins", body, syncStartSec],
          rows: [],
          runMeta: { changes: 1 },
        },
        {
          match: "INSERT INTO cache",
          matchBinds: [getResponseReadyCacheKey("stablecoins"), responseReadyBody, syncStartSec],
          rows: [],
          throwError: new Error("response-ready write failed"),
        },
      ],
    );

    const result = await validateAndWriteStablecoinsCache({
      assets: [], db, syncStartSec, validationContext: "main",
    }, () => ({ status: "degraded", itemCount: 0, metadata: "blocked" }));

    expect(result).toMatchObject({
      written: true,
      skippedBecauseNewer: false,
      cacheKey: "stablecoins",
      responseReadyCacheError: "Error",
    });
  });

  it("quarantines a post-enrichment schema-invalid row per asset and publishes the healthy cohort", async () => {
    const { db, sqlite } = fixtures.open();
    const syncStartSec = 1_777_000_000;
    const publishable = (id: string, overrides: Partial<PeggedAsset> = {}) => makePeggedAsset({
      id, name: id, symbol: id.toUpperCase(), pegMechanism: "fiat-backed", price: 1, priceSource: "defillama",
      circulating: { peggedUSD: 1000 }, chainCirculating: {}, chains: [], ...overrides,
    });
    const healthy = Array.from({ length: 50 }, (_, index) => publishable(`healthy-${index}`));
    healthy[0]!.chainCirculating = {
      Ethereum: { current: 5, circulatingPrevDay: {}, circulatingPrevWeek: {}, circulatingPrevMonth: {} },
      Tron: { current: {} },
      Base: { current: { peggedUSD: 0 }, circulatingPrevDay: { peggedUSD: 0 } },
    };
    normalizeChainCirculating(healthy);
    const invalid = publishable("negative-history", { circulatingPrevDay: { peggedUSD: -1 } });
    const assets = [...healthy, invalid];

    const result = await validateAndWriteStablecoinsCache({
      assets, db, syncStartSec, validationContext: "main",
    }, () => ({ metadata: "blocked" }));

    expect(result).toMatchObject({ written: true, quarantinedAssets: [expect.objectContaining({ id: "negative-history" })] });
    // Later stages (depeg, coverage) see only the published cohort.
    expect(assets.map((asset) => asset.id)).toEqual(healthy.map((asset) => asset.id));
    const canonical = JSON.parse((await getCache(db, "stablecoins"))!.value) as { peggedAssets: Array<{ id: string; chainCirculating: unknown }> };
    expect(canonical.peggedAssets.map((asset) => asset.id)).toEqual(healthy.map((asset) => asset.id));
    const expectedChains = {
      Ethereum: { current: 5, circulatingPrevDay: null, circulatingPrevWeek: null, circulatingPrevMonth: null },
      Tron: { current: null },
      Base: { current: 0, circulatingPrevDay: 0 },
    };
    expect(canonical.peggedAssets[0]?.chainCirculating).toEqual(expectedChains);
    const companion = JSON.parse((await getCache(db, getResponseReadyCacheKey("stablecoins")))!.value) as { body: string };
    expect((JSON.parse(companion.body) as typeof canonical).peggedAssets[0]?.chainCirculating)
      .toEqual(expectedChains);
    expect(sqlite.prepare("SELECT key FROM cache WHERE key = ?").all("stablecoins:invalid-last")).toHaveLength(1);
  });
  it("strips upstream frozen fields from non-registry assets before publishing", async () => {
    const syncStartSec = 1_777_000_000;
    const db = mockD1([{ match: "INSERT INTO cache", rows: [], runMeta: { changes: 1 } }]);
    const result = await validateAndWriteStablecoinsCache({
      assets: [makePeggedAsset({
        id: "upstream-controlled-active-coin", pegMechanism: "fiat-backed", price: 1, priceSource: "defillama",
        circulating: { peggedUSD: 1000 }, chainCirculating: {}, chains: [], frozen: true, frozenAt: "2026-04-27",
      })],
      db, syncStartSec, validationContext: "main",
    }, () => ({ status: "degraded", itemCount: 0, metadata: "blocked" }));

    expect(result).toMatchObject({ written: true, skippedBecauseNewer: false });
    const stablecoinsWrite = db.getHistory().find((entry) => entry.binds[0] === "stablecoins");
    expect(stablecoinsWrite).toBeDefined();
    const published = JSON.parse(stablecoinsWrite?.binds[1] as string) as {
      peggedAssets: Array<{ frozen?: boolean; frozenAt?: string }>;
    };
    expect(published.peggedAssets[0].frozen).toBeUndefined();
    expect(published.peggedAssets[0].frozenAt).toBeUndefined();
  });
});
