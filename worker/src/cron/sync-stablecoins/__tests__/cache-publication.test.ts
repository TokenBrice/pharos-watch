import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { encodeResponseReadyCacheValue, getResponseReadyCacheKey } from "../../../lib/api-cache-read";
import { RESPONSE_READY_CACHE_SCHEMA_IDS } from "../../../lib/response-ready-cache-contracts";
import { validateAndWriteStablecoinsCache } from "../cache-publication";
import { normalizeStablecoinsPayload } from "../shared";

describe("validateAndWriteStablecoinsCache", () => {
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
