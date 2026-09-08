import { afterEach, describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { encodeResponseReadyCacheValue, getResponseReadyCacheKey } from "../../../lib/api-cache-read";
import { RESPONSE_READY_CACHE_SCHEMA_IDS } from "../../../lib/response-ready-cache-contracts";
import { commitReplayPriceCache, validateAndWriteStablecoinsCache } from "../cache-publication";
import { normalizeStablecoinsPayload } from "../shared";
import { createLatestSchemaFixtureTracker } from "../../../test-helpers/latest-schema-sqlite";
import { getCache, getPriceCache } from "../../../lib/db-cache";
import { makePeggedAsset } from "./_fixtures";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

describe("validateAndWriteStablecoinsCache", () => {
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
        returnIfAborted: () => null,
        abortResult: () => ({ aborted: true, metadata: "aborted" }),
      }, () => ({ metadata: "blocked" }));
      await commitReplayPriceCache({
        db,
        entries: priceCacheEntries,
        returnIfAborted: () => null,
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
        agreeSources: ["coingecko"], consensusSources: ["coingecko"],
      }]]);
    }
  });

  it.each(["invalid", "newer", "aborted"] as const)("preserves published generations when %s blocks publication", async (gate) => {
    const { db, sqlite } = fixtures.open();
    const companionKey = getResponseReadyCacheKey("stablecoins");
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("stablecoins", "prior", 200);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(companionKey, "companion", 50);
    const result = await validateAndWriteStablecoinsCache({
      db, assets: gate === "invalid" ? [makePeggedAsset({ name: 42 as never })] : [],
      syncStartSec: gate === "newer" ? 100 : 300, validationContext: "main",
      returnIfAborted: () => gate === "aborted" ? { aborted: true, metadata: "aborted" } : null,
      abortResult: () => ({ aborted: true, metadata: "aborted" }),
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
      returnIfAborted: () => ({ aborted: true, metadata: "aborted" }),
    });
    expect(result).toMatchObject({ aborted: true });
    expect(await getPriceCache(db)).toEqual(before);
  });

  it("normalizes every unusable price to explicit missing provenance", () => {
    const payload = normalizeStablecoinsPayload({
      peggedAssets: [
        {
          id: "missing-price",
          name: "Missing Price",
          symbol: "MISS",
          price: null,
          priceSource: "coingecko",
          priceSelectedSource: "coingecko",
          priceConfidence: "single-source",
          priceUpdatedAt: 1_700_000_000,
          priceObservedAt: 1_700_000_000,
          priceObservedAtMode: "upstream",
          priceSyncedAt: 1_700_000_010,
          consensusSources: ["coingecko"],
          agreeSources: ["coingecko"],
          priceSourceConfidenceProfile: {
            activeDexLanes: 1,
            freshestDexLaneAgeSec: 30,
            aggregateLaneOnly: false,
          },
        },
      ],
    });

    expect(payload.peggedAssets[0]).toMatchObject({
      price: null,
      priceSource: "missing",
      priceSelectedSource: null,
      priceConfidence: null,
      priceUpdatedAt: null,
      priceObservedAt: null,
      priceObservedAtMode: null,
      priceSyncedAt: null,
      consensusSources: [],
      agreeSources: [],
      priceSourceConfidenceProfile: null,
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
      { requireMatch: true },
    );

    const result = await validateAndWriteStablecoinsCache(
      {
        assets: [],
        db,
        syncStartSec,
        validationContext: "main",
        returnIfAborted: () => null,
        abortResult: () => ({
          status: "degraded",
          itemCount: 0,
          metadata: "aborted",
        }),
      },
      () => ({
        status: "degraded",
        itemCount: 0,
        metadata: "blocked",
      }),
    );

    expect(result).toMatchObject({
      written: true,
      skippedBecauseNewer: false,
      cacheKey: "stablecoins",
      responseReadyCacheError: "Error",
    });
  });
  it("strips upstream frozen fields from non-registry assets before publishing", async () => {
    const syncStartSec = 1_777_000_000;
    const db = mockD1(
      [
        {
          match: "INSERT INTO cache",
          rows: [],
          runMeta: { changes: 1 },
        },
      ],
      { requireMatch: true },
    );

    const result = await validateAndWriteStablecoinsCache(
      {
        assets: [
          {
            id: "upstream-controlled-active-coin",
            name: "Active Coin",
            symbol: "ACTIVE",
            pegType: "peggedUSD",
            pegMechanism: "fiat-backed",
            price: 1,
            priceSource: "defillama",
            circulating: { peggedUSD: 1000 },
            chainCirculating: {
              Ethereum: {
                current: 1000,
                circulatingPrevDay: 1000,
                circulatingPrevWeek: 1000,
                circulatingPrevMonth: 1000,
              },
            },
            chains: ["Ethereum"],
            frozen: true,
            frozenAt: "2026-04-27",
          },
        ],
        db,
        syncStartSec,
        validationContext: "main",
        returnIfAborted: () => null,
        abortResult: () => ({
          status: "degraded",
          itemCount: 0,
          metadata: "aborted",
        }),
      },
      () => ({
        status: "degraded",
        itemCount: 0,
        metadata: "blocked",
      }),
    );

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
