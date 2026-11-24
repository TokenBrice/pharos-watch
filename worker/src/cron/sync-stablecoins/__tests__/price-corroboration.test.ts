import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import * as enrichment from "../enrich-prices";
import * as shared from "../shared";
import {
  PRICE_CORROBORATION_OBSERVATIONS_KEY,
  filterStageablePriceObservations,
  loadPriceCorroborationObservations,
  writePriceCorroborationObservations,
} from "../price-corroboration-observations";
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
      makePeggedAsset({
        id: "susd1plus-lorenzo", symbol: "sUSD1+", price: 0.99,
        priceSource: "coinmarketcap", priceConfidence: "fallback", priceObservedAt: 1_800_000_000,
      }),
      makePeggedAsset({ id: "a7a5-old-vector", symbol: "A7A5", price: null, geckoId: "wrong-generation" }),
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
      expect(args[0]).toHaveLength(2);
      expect(args[0][0]).toMatchObject({ cmcSlug: "lorenzo-staked-usd1", navToken: true, price: null });
      expect(args[0][1]).toMatchObject({ id: "a7a5-old-vector", geckoId: "a7a5", price: null });
      expect(args[8]).toEqual(new Set(["a7a5-old-vector"]));
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
      id: "usdt-tether", price: 1, priceSource: "coinmarketcap", priceConfidence: "fallback",
      priceObservedAt: 1_799_999_900, priceObservedAtMode: "upstream",
      agreeSources: ["coinmarketcap"], consensusSources: ["coinmarketcap"],
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

  it("makes a 15-minute quote usable at the next publication by collecting at :09 and skips unreachable quotes", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const db = createSqliteD1(sqlite);
    const hour = 1_800_000_000;
    const slot09 = hour + 9 * 60;
    const publicationSelection = hour + 17 * 60;
    const local15m = { id: "usdt-tether", source: "coingecko-onchain-address", price: 1, observedAtMode: "local_fetch" as const };
    try {
      // Previously fetched at :02, with the source clock already one minute old.
      await writePriceCorroborationObservations(db, [{ ...local15m, observedAt: hour + 60 }], hour);
      expect((await loadPriceCorroborationObservations(db, publicationSelection)).summary.discarded.sourceExpired).toBe(1);
      // The same age after the :09 checks leaves seven minutes of headroom.
      await writePriceCorroborationObservations(db, [{ ...local15m, observedAt: slot09 }], slot09);
      const { summary } = await loadPriceCorroborationObservations(db, publicationSelection);
      expect(summary.eligibleObservationCount).toBe(1);
      expect(summary.minimumFreshnessHeadroomSec).toBe(7 * 60);
      // 3h upstream defillama-contract survives 2h old, while 5m TTL lanes and already-expiring quotes are not staged.
      const filtered = filterStageablePriceObservations([
        { id: "a7a5-old-vector", source: "defillama-contract", price: 0.0124, observedAt: slot09 - 2 * 3600, observedAtMode: "upstream" },
        { id: "a7a5-old-vector", source: "defillama-contract", price: 0.0124, observedAt: slot09 - (3 * 3600 - 300), observedAtMode: "upstream" },
        { id: "a7a5-old-vector", source: "defillama-contract", price: 0.0124, observedAt: slot09, observedAtMode: "local_fetch" },
        { id: "gbpm-mento", source: "mento-fpmm", price: 1.32, observedAt: slot09, observedAtMode: "upstream" },
        { id: "aznd-mu-digital", source: "curve-thin-onchain", price: 0.999, observedAt: slot09, observedAtMode: "upstream" },
      ], slot09);
      expect(filtered).toEqual([
        { id: "a7a5-old-vector", source: "defillama-contract", price: 0.0124, observedAt: slot09 - 2 * 3600, observedAtMode: "upstream" },
      ]);
      await writePriceCorroborationObservations(db, filtered, slot09 + 1);
      const contractLoad = await loadPriceCorroborationObservations(db, publicationSelection);
      expect(contractLoad.summary.eligibleObservationCount).toBe(1);
      expect(contractLoad.summary.minimumFreshnessHeadroomSec).toBe(52 * 60);
    } finally {
      sqlite.close();
    }
  });

  it("writes a rollback-readable DEX collection clock and admits only a matching activity receipt", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const db = createSqliteD1(sqlite);
    const now = 1_800_000_540;
    const observation = { id: "moveusd-cfx", source: "dexscreener-exact", chain: "solana",
      target: "3AdhVEX6k85yNivHVXDEiY3WyP2WgFQTUZCahGaeC2qm", price: 0.9993, observedAt: null,
      observedAtMode: "unknown" as const, recentActivity: { evidence: "positive-volume-m5" as const, collectedAt: now } };
    try {
      await writePriceCorroborationObservations(db, [observation], now);
      const wire = JSON.parse(String(sqlite.prepare("SELECT value FROM cache WHERE key = ?")
        .get(PRICE_CORROBORATION_OBSERVATIONS_KEY)?.value))[0];
      expect(wire).toEqual({ ...observation, observedAt: now, observedAtMode: "local_fetch" });
      for (const age of [60, 360, 899]) {
        expect((await loadPriceCorroborationObservations(db, now + age)).byId.get(observation.id)).toEqual([observation]);
      }
      expect((await loadPriceCorroborationObservations(db, now + 900)).byId.size).toBe(0);
      for (const invalid of [{ ...wire, observedAt: now + 1 }, { ...wire, observedAtMode: "upstream" }, { ...wire, target: "" }]) {
        sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(JSON.stringify([invalid]), PRICE_CORROBORATION_OBSERVATIONS_KEY);
        expect((await loadPriceCorroborationObservations(db, now + 60)).summary.discarded.unknownTime).toBe(1);
      }
    } finally { sqlite.close(); }
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

  it("selects only active missing, fallback, and low-confidence publication rows", () => {
    const assets = [
      makePeggedAsset({ id: "a7a5-old-vector", price: null }),
      makePeggedAsset({ id: "nusd-nexus", price: 0.999, priceSource: "defillama-contract", priceConfidence: "fallback", priceObservedAt: 1_800_000_000 }),
      makePeggedAsset({ id: "m-m0", price: 0.999, priceSource: "coingecko", priceConfidence: "low", priceObservedAt: 1_800_000_000 }),
      makePeggedAsset({ id: "usdc-circle", price: 1, priceSource: "coingecko", priceConfidence: "single-source", priceObservedAt: 1_800_000_000, consensusSources: ["coingecko"] }),
      makePeggedAsset({ id: "usdt-tether", price: 1, priceSource: "coingecko+binance", priceConfidence: "high", priceObservedAt: 1_800_000_000, consensusSources: ["coingecko", "binance"] }),
      makePeggedAsset({ id: "usdv-solomon", price: null }),
      makePeggedAsset({ id: "untracked-token", price: null }),
    ];

    expect(buildPriceCorroborationCohort(assets).map((asset) => asset.id)).toEqual([
      "a7a5-old-vector",
      "nusd-nexus",
      "m-m0",
    ]);
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
      makePeggedAsset({ id: "display-only", price: null }),
    ];
    const fallbackProbes = new Map<string, PeggedAsset>([
      ["primary", makePeggedAsset({ id: "primary", price: 1.0002, priceSource: "defillama-contract", priceConfidence: "fallback", priceObservedAt: 1_800_000_000 })],
      ["fallback", makePeggedAsset({ id: "fallback", price: 0.999, priceSource: "coinmarketcap", priceConfidence: "fallback", priceObservedAt: 1_800_000_000 })],
      ["display-only", makePeggedAsset({ id: "display-only", price: 0.9993, priceSource: "dexscreener-exact",
        priceConfidence: "fallback", priceObservedAt: null, priceObservedAtMode: "unknown" })],
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
