import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "../../../test-helpers/sqlite-d1";
import * as enrichment from "../enrich-prices";
import * as shared from "../shared";
import { PRICE_CORROBORATION_OBSERVATIONS_KEY } from "../price-corroboration-observations";
import type { AddressPriceQuote } from "../../../lib/address-price-providers";
import type { PeggedAsset } from "../enrich-prices";
import {
  buildPriceCorroborationCacheEntries,
  buildPriceCorroborationCohort,
  isPriceCorroborationSlot,
  runPriceCorroboration,
} from "../price-corroboration";
import { makePeggedAsset } from "./_fixtures";

function quote(stablecoinId: string, priceUsd: number): AddressPriceQuote {
  return {
    stablecoinId,
    source: "coingecko-onchain-address",
    chain: "base",
    address: "0x0000000000000000000000000000000000000001",
    priceUsd,
    observedAt: 1_800_000_000,
    observedAtMode: "local_fetch",
  };
}

describe("hourly price corroboration", () => {
  it("stages fetched observations without promoting the previous published reference", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const db = createSqliteD1(sqlite);
    const previous = makePeggedAsset({ id: "usdt-tether", price: 1, priceSource: "coingecko", priceConfidence: "single-source" });
    const previousLoad = vi.spyOn(shared, "loadPreviousStablecoinsById").mockResolvedValue({
      previousAssetsById: new Map([[previous.id, previous]]), cacheState: { state: "ok" },
    });
    const collect = vi.spyOn(enrichment, "enrichMissingPrices").mockImplementation(async (assets) => {
      expect(assets[0]?.price).toBeNull();
      // No provider returned a fresh quote. The published reference cannot enter the handoff.
      return {} as Awaited<ReturnType<typeof enrichment.enrichMissingPrices>>;
    });
    try {
      await runPriceCorroboration({ db, syncStartSec: 1_800_000_000 });
      const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(PRICE_CORROBORATION_OBSERVATIONS_KEY);
      expect(JSON.parse(String(row?.value))).toEqual([]);
    } finally {
      previousLoad.mockRestore();
      collect.mockRestore();
      sqlite.close();
    }
  });

  it("runs only for the top-of-hour quarter-hour invocation", () => {
    expect(isPriceCorroborationSlot(1_800_000_000)).toBe(true);
    expect(isPriceCorroborationSlot(1_800_000_900)).toBe(false);
    expect(isPriceCorroborationSlot(1_800_001_800)).toBe(false);
    expect(isPriceCorroborationSlot(1_800_002_700)).toBe(false);
  });

  it("selects only missing and fewer-than-three-source publication rows", () => {
    const assets = [
      makePeggedAsset({ id: "missing", price: null }),
      makePeggedAsset({ id: "thin", price: 1, priceSource: "coingecko", priceObservedAt: 1_800_000_000, consensusSources: ["coingecko"] }),
      makePeggedAsset({
        id: "deep",
        price: 1,
        priceSource: "coingecko+defillama-list+protocol-redeem",
        priceObservedAt: 1_800_000_000,
        consensusSources: ["coingecko", "defillama-list", "protocol-redeem"],
      }),
    ];

    expect(buildPriceCorroborationCohort(assets).map((asset) => asset.id)).toEqual(["missing", "thin"]);
  });

  it("preserves the legacy published price set across a seven-day replay fixture", () => {
    const publicationRows: PeggedAsset[] = [
      makePeggedAsset({
        id: "primary",
        price: 1,
        priceSource: "coingecko+defillama-list",
        priceConfidence: "single-source",
        priceObservedAt: 1_800_000_000,
        consensusSources: ["coingecko", "defillama-list"],
        agreeSources: ["coingecko", "defillama-list"],
      }),
      makePeggedAsset({ id: "fallback", price: null }),
    ];
    const fallbackProbes = new Map<string, PeggedAsset>([
      ["primary", makePeggedAsset({ id: "primary", price: 1.0002, priceSource: "defillama-contract", priceConfidence: "fallback", priceObservedAt: 1_800_000_000 })],
      ["fallback", makePeggedAsset({ id: "fallback", price: 0.999, priceSource: "coinmarketcap", priceConfidence: "fallback", priceObservedAt: 1_800_000_000 })],
    ]);
    const legacyPublishedRows = new Map([
      ["primary", 1],
      ["fallback", 0.999],
    ]);
    for (let day = 0; day < 7; day++) {
      const entries = buildPriceCorroborationCacheEntries({
        publishedAssets: publicationRows,
        fallbackProbes,
        addressQuotes: new Map([
          ["primary", [quote("primary", 1.0001)]],
          ["fallback", [quote("fallback", 0.9991)]],
        ]),
        syncedAt: 1_800_000_000 + day * 24 * 60 * 60,
      });

      const replayedPublicationRows = new Map(entries.map((entry) => [entry.id, entry.price]));
      expect(replayedPublicationRows).toEqual(legacyPublishedRows);
      expect(entries).toEqual([
        expect.objectContaining({
          id: "primary",
          price: 1,
          source: "coingecko+defillama-list",
          consensusSources: ["coingecko", "defillama-list", "defillama-contract", "coingecko-onchain-address"],
        }),
        expect.objectContaining({
          id: "fallback",
          price: 0.999,
          source: "coinmarketcap",
          confidence: "fallback",
          agreeSources: ["coinmarketcap", "coingecko-onchain-address"],
        }),
      ]);
    }
  });
});
