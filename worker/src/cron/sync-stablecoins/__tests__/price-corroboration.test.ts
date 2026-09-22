import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import * as enrichment from "../enrich-prices";
import * as shared from "../shared";
import { PRICE_CORROBORATION_OBSERVATIONS_KEY, loadPriceCorroborationObservations, writePriceCorroborationObservations } from "../price-corroboration-observations";
import type { AddressPriceQuote } from "../../../lib/address-price-providers";
import type { PeggedAsset } from "../enrich-prices";
import {
  buildPriceCorroborationCacheEntries,
  buildPriceCorroborationCohort,
  isPriceCorroborationSlot,
  summarizePriceCorroboration,
  type PriceCorroborationResult,
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
  it("restores curated fallback hints without changing published rows and preserves original missing priority", async () => {
    const published = [
      makePeggedAsset({ id: "susd1plus-lorenzo", symbol: "sUSD1+", price: 0.99, priceSource: "coingecko", priceObservedAt: 1_800_000_000 }),
      makePeggedAsset({ id: "usdv-solomon", symbol: "USDv", price: null, geckoId: "wrong-generation" }),
    ];
    const original = structuredClone(published);
    const load = vi.spyOn(shared, "loadPreviousStablecoinsById").mockResolvedValue({
      previousAssetsById: new Map(published.map((asset) => [asset.id, asset])), cacheState: { state: "ok" },
    });
    const stop = new Error("collection inspected");
    const collect = vi.spyOn(enrichment, "enrichMissingPrices").mockRejectedValue(stop);
    const chainRpcs = new Map();
    try {
      await expect(runPriceCorroboration({ db: {} as D1Database, syncStartSec: 1_800_000_540, chainRpcs })).rejects.toBe(stop);
      const args = collect.mock.calls[0];
      expect(args[0][0]).toMatchObject({ cmcSlug: "lorenzo-staked-usd1", navToken: true, price: null });
      expect(args[0][1].geckoId).toBeUndefined();
      expect(published).toEqual(original);
    } finally {
      load.mockRestore();
      collect.mockRestore();
    }
  });

  it.each([false, true])("stages only fetched observations (fresh quote: %s)", async (hasQuote) => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    sqlite.exec("CREATE TABLE price_cache (asset_id TEXT PRIMARY KEY, price REAL, updated_at INTEGER, source TEXT, confidence TEXT, observed_at INTEGER, observed_at_mode TEXT, synced_at INTEGER, agree_sources_json TEXT, consensus_sources_json TEXT)");
    const db = createSqliteD1(sqlite);
    const previous = makePeggedAsset({
      id: "usdt-tether", price: 1, priceSource: "coingecko", priceConfidence: "single-source",
      priceObservedAt: 1_799_999_900, priceObservedAtMode: "upstream",
      agreeSources: ["coingecko"], consensusSources: ["coingecko"],
    });
    const previousLoad = vi.spyOn(shared, "loadPreviousStablecoinsById").mockResolvedValue({
      previousAssetsById: new Map([[previous.id, previous]]), cacheState: { state: "ok" },
    });
    let capturedProbes: PeggedAsset[] = [];
    const collect = vi.spyOn(enrichment, "enrichMissingPrices").mockImplementation(async (assets) => {
      capturedProbes = structuredClone(assets);
      if (hasQuote) Object.assign(assets[0], {
        price: 0.999,
        priceSource: "coinmarketcap",
        priceConfidence: "fallback",
        priceObservedAt: 1_800_000_000,
        priceObservedAtMode: "local_fetch",
      });
      return {} as Awaited<ReturnType<typeof enrichment.enrichMissingPrices>>;
    });
    try {
      await runPriceCorroboration({ db, syncStartSec: 1_800_000_000 });
      expect(collect).toHaveBeenCalledTimes(1);
      expect(capturedProbes).toEqual([expect.objectContaining({
        id: "usdt-tether", price: null, priceSource: undefined, priceConfidence: null,
        priceObservedAt: null, priceObservedAtMode: null, agreeSources: [], consensusSources: [],
      })]);
      const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(PRICE_CORROBORATION_OBSERVATIONS_KEY);
      expect(JSON.parse(String(row?.value))).toEqual(hasQuote ? [{
        id: "usdt-tether", source: "coinmarketcap", price: 0.999,
        observedAt: 1_800_000_000, observedAtMode: "local_fetch",
      }] : []);
      expect(previous.price).toBe(1);
    } finally {
      previousLoad.mockRestore();
      collect.mockRestore();
      sqlite.close();
    }
  });

  it.each(["missing", "malformed", "error"] as const)("preserves staging and avoids providers when published cache is %s", async (state) => {
    const load = vi.spyOn(shared, "loadPreviousStablecoinsById").mockResolvedValue({
      previousAssetsById: new Map(), cacheState: state === "error" ? { state, message: "read failed" } : { state },
    });
    const collect = vi.spyOn(enrichment, "enrichMissingPrices");
    const db = { prepare: vi.fn() } as unknown as D1Database;
    try {
      await expect(runPriceCorroboration({ db, syncStartSec: 1_800_000_540 })).rejects.toThrow("valid published stablecoins cache");
      expect(collect).not.toHaveBeenCalled();
      expect(db.prepare).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
      collect.mockRestore();
    }
  });

  it("makes a 15-minute quote usable at the next publication by collecting at :09", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const db = createSqliteD1(sqlite);
    const hour = 1_800_000_000;
    const publicationSelection = hour + 17 * 60;
    const observation = { id: "usdt-tether", source: "defillama-contract", price: 1, observedAtMode: "upstream" as const };
    try {
      // Previously fetched at :02, with the source clock already one minute old.
      await writePriceCorroborationObservations(db, [{ ...observation, observedAt: hour + 60 }], hour);
      expect((await loadPriceCorroborationObservations(db, publicationSelection)).summary.discarded.sourceExpired).toBe(1);
      // The same upstream age after the :09 checks leaves seven minutes of headroom.
      await writePriceCorroborationObservations(db, [{ ...observation, observedAt: hour + 9 * 60 }], hour + 9 * 60);
      const { summary } = await loadPriceCorroborationObservations(db, publicationSelection);
      expect(summary.eligibleObservationCount).toBe(1);
      expect(summary.minimumFreshnessHeadroomSec).toBe(7 * 60);
    } finally {
      sqlite.close();
    }
  });

  it("runs only for the :09 hourly status-check invocation", () => {
    expect(isPriceCorroborationSlot(1_800_000_540)).toBe(true);
    expect(isPriceCorroborationSlot(1_800_000_000)).toBe(false);
    expect(isPriceCorroborationSlot(1_800_001_440)).toBe(false);
    expect(isPriceCorroborationSlot(1_800_002_340)).toBe(false);
    expect(isPriceCorroborationSlot(1_800_003_240)).toBe(false);
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

  it("preserves published references while merging corroborating provenance", () => {
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
    const entries = buildPriceCorroborationCacheEntries({
      publishedAssets: publicationRows,
      fallbackProbes,
      addressQuotes: new Map([
        ["primary", [quote("primary", 1.0001)]],
        ["fallback", [quote("fallback", 0.9991)]],
      ]),
      syncedAt: 1_800_000_000,
    });

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
  });
});


describe("bounded corroboration diagnostics", () => {
  it("retains the failed DexScreener attempt while dropping URLs, credentials and payload text", () => {
    const diagnostic = { source: "coinmarketcap" as const, stage: "fallback" as const, status: 403,
      ok: false, success: false, endpoint: "provider.example/api?key=secret-token",
      errorClass: "http-error", errorMessage: "secret-token response body", snippet: "private payload" };
    const result: PriceCorroborationResult = {
      cohortSize: 40, cacheEntriesWritten: 12, addressProviderCount: 1, providerDiagnosticCount: 2,
      fallbackStats: { totalMissing: 40, finalMissing: 28, pass1: 2, pass1b: 1, passCmc: 5,
        passJupiter: 2, passDex: 0, passCgLowVolume: 2, failedPasses: [],
        providerDiagnostics: [...Array.from({ length: 25 }, () => diagnostic), {
          ...diagnostic, source: "dexscreener-exact", status: 429, errorClass: "rate-limited",
          endpoint: "api.dexscreener.com/tokens/v1/base/0xprivate-address", candidateCount: 30,
        }] },
    };
    const summary = summarizePriceCorroboration(result);
    expect(summary.providerDiagnostics).toHaveLength(20);
    expect(summary.providerDiagnostics[0]).toMatchObject({ source: "dexscreener-exact", chain: "base",
      status: 429, errorClass: "rate-limited", candidateCount: 30, success: false });
    expect(summary.providerDiagnosticCount).toBe(28);
    expect(summary.resolvedByPass.defillama).toBe(3);
    const serialized = JSON.stringify(summary);
    for (const forbidden of ["secret-token", "response body", "private payload", "0xprivate-address", "provider.example"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
