import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { normalizeStablecoinsPayload } from "../sync-stablecoins/shared";
import {
  loadPriceCorroborationObservations,
  writePriceCorroborationObservations,
} from "../sync-stablecoins/price-corroboration-observations";

vi.mock("@shared/lib/stablecoins/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/lib/stablecoins/registry")>();
  const eurc = actual.TRACKED_META_BY_ID.get("eurc-circle");
  if (!eurc) throw new Error("missing EURC test metadata");
  return {
    ...actual,
    TRACKED_META_BY_ID: new Map([
      ...actual.TRACKED_META_BY_ID,
      ["eurc-circle", {
        ...eurc,
        geckoId: "euro-coin",
        flags: { ...eurc.flags, pegCurrency: "EUR", navToken: false },
      }],
    ]),
  };
});

const fetchCurrentNativePegImpliedUsdQuotesMock = vi.fn();

vi.mock("../../lib/native-peg-implied-prices", async () => {
  const actual = await vi.importActual<typeof import("../../lib/native-peg-implied-prices")>("../../lib/native-peg-implied-prices");
  return {
    ...actual,
    fetchCurrentNativePegImpliedUsdQuotes: (...args: unknown[]) => fetchCurrentNativePegImpliedUsdQuotesMock(...args),
  };
});

import type { PeggedAsset } from "../sync-stablecoins/enrich-prices";
import { makePeggedAsset } from "../sync-stablecoins/__tests__/_fixtures";
import { isAbortResult, runPostEnrichmentPricePipeline } from "../sync-stablecoins/post-enrichment";
import type { PrimaryPriceResult } from "../sync-stablecoins/enrich-prices";
import { buildPriceValidationContext, type PriceValidationContext } from "../../lib/price-validation";

function makeValidationContext(asset: PeggedAsset): PriceValidationContext {
  return buildPriceValidationContext({
    stablecoinId: asset.id,
    pegType: asset.pegType,
    navToken: asset.navToken,
    commodityOunces: asset.commodityOunces,
  });
}

function makeAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return makePeggedAsset({
    id: "eurc-circle",
    name: "EURC",
    symbol: "EURC",
    geckoId: "euro-coin",
    pegType: "peggedEUR",
    pegMechanism: "fiat-backed",
    circulating: { peggedEUR: 1_000_000 },
    price: 1.12,
    priceSource: "coingecko",
    priceConfidence: "single-source",
    navToken: false,
    ...overrides,
  });
}

describe("runPostEnrichmentPricePipeline", () => {
  beforeEach(() => {
    fetchCurrentNativePegImpliedUsdQuotesMock.mockReset().mockResolvedValue(new Map());
  });

  it.each([
    ["tryb-bilira", "peggedTRY", 0.022, "coingecko-low-volume", 40 * 3600, 900, true],
    ["gbpm-mento", "peggedGBP", 1.32, "coingecko-low-volume", 40 * 3600, 900, true],
    ["cadm-mento", "peggedCAD", 0.73, "coingecko-low-volume", 40 * 3600, 900, true],
    ["usdt-tether", "peggedUSD", 1, "coinmarketcap", 1200, 900, true],
    ["usdt-tether", "peggedUSD", 1, "coingecko-low-volume", 8 * 86400, 900, false],
    ["usdt-tether", "peggedUSD", 1, "coinmarketcap", 3601, 900, false],
    ["usdt-tether", "peggedUSD", 1, "coingecko-onchain-address", 901, 900, false],
    ["gbpm-mento", "peggedGBP", 1.32, "coingecko-low-volume", 41 * 3600, 3601, true],
    ["usdt-tether", "peggedUSD", 1, "coingecko-low-volume", 40 * 3600, 4501, false],
    ["usdt-tether", "peggedUSD", 1, "cached", 60, 30, false],
    ["usdt-tether", "peggedUSD", 0.45, "coinmarketcap", 60, 30, false],
    ["usdt-tether", "peggedUSD", 1, "coinmarketcap", -60, 30, false],
  ] as const)("revalidates staged %s %s %s %s evidence aged %s with stage age %s", async (
    id, pegType, price, source, observationAge, stageAge, accepted,
  ) => {
    const now = 1_800_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const db = createSqliteD1(sqlite);
    const asset = makeAsset({ id, pegType, price: null, priceSource: undefined, priceConfidence: null });
    try {
      await writePriceCorroborationObservations(db, [{
        id, source, price, observedAt: now - observationAge, observedAtMode: "upstream",
      }], now - stageAge);
      const result = await runPostEnrichmentPricePipeline({
        assets: [asset], missingBefore: new Set([id]), db, syncStartSec: now,
        priceCache: new Map(), validationContexts: { get: makeValidationContext },
        validationReferences: { rates: { [pegType]: pegType === "peggedUSD" ? 1 : price }, type: "fresh", updatedAt: now },
        previousTrustedPrices: new Map(), returnIfAborted: () => null,
        abortResult: () => ({ status: "error", metadata: "{}" }),
      }, "");
      expect(isAbortResult(result)).toBe(false);
      const normalized = normalizeStablecoinsPayload({ peggedAssets: [asset] }).peggedAssets[0]!;
      expect(normalized.price).toBe(accepted ? price : null);
      if (accepted) {
        expect(normalized.priceSource).toBe(source);
        expect(normalized.priceConfidence).toBe("fallback");
        expect(normalized.priceObservedAt).toBe(now - observationAge);
      }
    } finally {
      clock.mockRestore();
      sqlite.close();
    }
  });

  it("clears an empty hourly collection and rejects an older stage writer", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const db = createSqliteD1(sqlite);
    const rows = [{ id: "usdt-tether", source: "coinmarketcap", price: 1, observedAt: 1000, observedAtMode: "upstream" as const }];
    try {
      await writePriceCorroborationObservations(db, rows, 1000);
      expect((await loadPriceCorroborationObservations(db, 1001)).size).toBe(1);
      await writePriceCorroborationObservations(db, [], 1002);
      await writePriceCorroborationObservations(db, rows, 1001);
      expect((await loadPriceCorroborationObservations(db, 1003)).size).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("replaces weak non-USD fiat prices with fresh native-implied USD prices", async () => {
    const asset = makeAsset();
    const db = mockD1();
    fetchCurrentNativePegImpliedUsdQuotesMock.mockResolvedValue(new Map([
      ["eurc-circle", {
        stablecoinId: "eurc-circle",
        pegCurrency: "EUR",
        nativePrice: 1,
        priceUsd: 1.08,
        updatedAt: 1_700_000_000,
        referencePriceUsd: 1.08,
        referenceType: "fresh",
      }],
    ]));

    const result = await runPostEnrichmentPricePipeline({
      assets: [asset],
      missingBefore: new Set(),
      db,
      syncStartSec: 1_700_000_050,
      validationReferences: {
        rates: { peggedEUR: 1.08 },
        type: "fresh",
        updatedAt: 1_700_000_000,
        typeByPeg: { peggedEUR: "fresh" },
      },
      validationContexts: { get: makeValidationContext },
      previousTrustedPrices: new Map(),
      returnIfAborted: () => null,
      abortResult: () => ({ status: "error", metadata: "{}" }),
    }, "");

    expect(isAbortResult(result)).toBe(false);
    if (isAbortResult(result)) {
      throw new Error("unexpected abort result");
    }
    expect(result.nativePegCorrectionCount).toBe(1);
    expect(result.nativePegFillCount).toBe(0);
    expect(result.rejectedCount).toBe(0);
    expect(asset.price).toBe(1.08);
    expect(asset.priceSource).toBe("coingecko-native-implied");
    expect(asset.priceSelectedSource).toBe("coingecko-native-implied");
    expect(asset.priceConfidence).toBe("single-source");
    expect(asset.priceObservedAt).toBe(1_700_000_000);
    expect(asset.priceObservedAtMode).toBe("upstream");
    expect(asset.priceSyncedAt).toBe(1_700_000_050);
    expect(asset.consensusSources).toEqual(["coingecko-native-implied"]);
    expect(asset.agreeSources).toEqual(["coingecko-native-implied"]);
    expect(
      db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO price_cache")),
    ).toBe(false);
  });

  it("does not replace multi-hard-source authoritative agreement with a native-implied quote", async () => {
    const asset = makeAsset({
      price: 1.1,
      priceSource: "binance+kraken",
      priceConfidence: "high",
      agreeSources: ["binance", "kraken"],
      consensusSources: ["binance", "kraken"],
    });
    fetchCurrentNativePegImpliedUsdQuotesMock.mockResolvedValue(new Map([
      ["eurc-circle", {
        stablecoinId: "eurc-circle",
        pegCurrency: "EUR",
        nativePrice: 1,
        priceUsd: 1.08,
        updatedAt: 1_700_000_000,
        referencePriceUsd: 1.08,
        referenceType: "fresh",
      }],
    ]));

    const result = await runPostEnrichmentPricePipeline({
      assets: [asset],
      missingBefore: new Set(),
      db: mockD1(),
      syncStartSec: 1_700_000_050,
      validationReferences: {
        rates: { peggedEUR: 1.08 },
        type: "fresh",
        updatedAt: 1_700_000_000,
        typeByPeg: { peggedEUR: "fresh" },
      },
      validationContexts: { get: makeValidationContext },
      previousTrustedPrices: new Map(),
      returnIfAborted: () => null,
      abortResult: () => ({ status: "error", metadata: "{}" }),
    }, "");

    expect(isAbortResult(result)).toBe(false);
    if (isAbortResult(result)) {
      throw new Error("unexpected abort result");
    }
    expect(result.nativePegCorrectionCount).toBe(0);
    expect(result.nativePegFillCount).toBe(0);
    expect(asset.price).toBe(1.1);
    expect(asset.priceSource).toBe("binance+kraken");
    expect(asset.priceConfidence).toBe("high");
  });

  it("replaces high-confidence mixed-source output when only one hard source disagrees with native pricing", async () => {
    const asset = makeAsset({
      price: 1.1,
      priceSource: "kraken+coingecko",
      priceConfidence: "high",
      agreeSources: ["kraken", "coingecko"],
      consensusSources: ["kraken", "coingecko"],
    });
    fetchCurrentNativePegImpliedUsdQuotesMock.mockResolvedValue(new Map([
      ["eurc-circle", {
        stablecoinId: "eurc-circle",
        pegCurrency: "EUR",
        nativePrice: 1,
        priceUsd: 1.08,
        updatedAt: 1_700_000_000,
        referencePriceUsd: 1.08,
        referenceType: "fresh",
      }],
    ]));

    const result = await runPostEnrichmentPricePipeline({
      assets: [asset],
      missingBefore: new Set(),
      db: mockD1(),
      syncStartSec: 1_700_000_050,
      validationReferences: {
        rates: { peggedEUR: 1.08 },
        type: "fresh",
        updatedAt: 1_700_000_000,
        typeByPeg: { peggedEUR: "fresh" },
      },
      validationContexts: { get: makeValidationContext },
      previousTrustedPrices: new Map(),
      returnIfAborted: () => null,
      abortResult: () => ({ status: "error", metadata: "{}" }),
    }, "");

    expect(isAbortResult(result)).toBe(false);
    if (isAbortResult(result)) {
      throw new Error("unexpected abort result");
    }
    expect(result.nativePegCorrectionCount).toBe(1);
    expect(result.nativePegFillCount).toBe(0);
    expect(asset.price).toBe(1.08);
    expect(asset.priceSource).toBe("coingecko-native-implied");
    expect(asset.priceSelectedSource).toBe("coingecko-native-implied");
    expect(asset.priceConfidence).toBe("single-source");
  });

  it("fills missing supported non-USD fiat prices from the native-implied lane", async () => {
    const asset = makeAsset({
      price: null,
      priceSource: undefined,
      priceConfidence: null,
    });
    const db = mockD1([
      {
        match: "SELECT asset_id, price, updated_at, source, confidence, observed_at, observed_at_mode, synced_at, agree_sources_json, consensus_sources_json FROM price_cache",
        rows: [],
      },
    ]);
    fetchCurrentNativePegImpliedUsdQuotesMock.mockResolvedValue(new Map([
      ["eurc-circle", {
        stablecoinId: "eurc-circle",
        pegCurrency: "EUR",
        nativePrice: 1,
        priceUsd: 1.08,
        updatedAt: 1_700_000_000,
        referencePriceUsd: 1.08,
        referenceType: "fresh",
      }],
    ]));

    const result = await runPostEnrichmentPricePipeline({
      assets: [asset],
      missingBefore: new Set(["eurc-circle"]),
      db,
      syncStartSec: 1_700_000_050,
      validationReferences: {
        rates: { peggedEUR: 1.08 },
        type: "fresh",
        updatedAt: 1_700_000_000,
        typeByPeg: { peggedEUR: "fresh" },
      },
      validationContexts: { get: makeValidationContext },
      previousTrustedPrices: new Map(),
      returnIfAborted: () => null,
      abortResult: () => ({ status: "error", metadata: "{}" }),
    }, "");

    expect(isAbortResult(result)).toBe(false);
    if (isAbortResult(result)) {
      throw new Error("unexpected abort result");
    }
    expect(result.nativePegCorrectionCount).toBe(0);
    expect(result.nativePegFillCount).toBe(1);
    expect(asset.price).toBe(1.08);
    expect(asset.priceSource).toBe("coingecko-native-implied");
    expect(asset.priceSelectedSource).toBe("coingecko-native-implied");
    expect(asset.priceConfidence).toBe("single-source");
    expect(
      db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO price_cache")),
    ).toBe(false);
  });

  it("stages replay-safe prices without writing price_cache before canonical publication", async () => {
    const asset = makeAsset({
      id: "usdc-circle",
      symbol: "USDC",
      price: 0.9998,
      priceSource: "coingecko",
      priceConfidence: "single-source",
      priceObservedAt: 1_700_000_000,
      priceObservedAtMode: "upstream",
      priceSyncedAt: 1_700_000_050,
      agreeSources: ["coingecko"],
      consensusSources: ["coingecko"],
      pegType: "peggedUSD",
    });
    const db = mockD1();

    const result = await runPostEnrichmentPricePipeline({
      assets: [asset],
      missingBefore: new Set(),
      db,
      syncStartSec: 1_700_000_050,
      validationContexts: { get: makeValidationContext },
      previousTrustedPrices: new Map(),
      returnIfAborted: () => null,
      abortResult: () => ({ status: "error", metadata: "{}" }),
    }, "");

    expect(isAbortResult(result)).toBe(false);
    if (isAbortResult(result)) {
      throw new Error("unexpected abort result");
    }
    expect(result.priceCacheEntries).toEqual([{
      id: "usdc-circle",
      price: 0.9998,
      source: "coingecko",
      confidence: "single-source",
      observedAt: 1_700_000_000,
      observedAtMode: "upstream",
      syncedAt: 1_700_000_050,
      agreeSources: ["coingecko"],
      consensusSources: ["coingecko"],
    }]);
    expect(db.getHistory().some((entry) => entry.sql.includes("price_cache") && entry.sql.includes("INSERT"))).toBe(false);
  });

  it("keeps a severe USX fallback when same-run CoinGecko and DexScreener quotes corroborate it", async () => {
    const asset = makeAsset({
      id: "usx-dforce",
      name: "dForce USD",
      symbol: "USX",
      geckoId: "token-dforce-usd",
      pegType: "peggedUSD",
      price: 0.3904,
      priceSource: "dexscreener-exact",
      priceConfidence: "fallback",
      consensusSources: ["dexscreener-exact"],
      agreeSources: ["dexscreener-exact"],
    });
    const primaryPriceResults = new Map<string, PrimaryPriceResult>([
      ["usx-dforce", {
        price: 0.390247,
        source: "coingecko",
        selectedSource: "coingecko",
        confidence: "single-source",
        dlPrice: null,
        cgPrice: 0.390247,
        candidateSources: ["coingecko"],
        agreeSources: ["coingecko"],
        allPrices: { coingecko: 0.390247 },
        observedAt: 1_700_000_000,
        observedAtMode: "upstream",
      }],
    ]);

    const result = await runPostEnrichmentPricePipeline({
      assets: [asset],
      missingBefore: new Set(["usx-dforce"]),
      db: mockD1(),
      syncStartSec: 1_700_000_050,
      validationContexts: { get: makeValidationContext },
      primaryPriceResults,
      previousTrustedPrices: new Map(),
      returnIfAborted: () => null,
      abortResult: () => ({ status: "error", metadata: "{}" }),
    }, "");

    expect(isAbortResult(result)).toBe(false);
    if (isAbortResult(result)) {
      throw new Error("unexpected abort result");
    }
    expect(result.rejectedCount).toBe(0);
    expect(asset.price).toBe(0.3904);
    expect(asset.priceSource).toBe("dexscreener-exact");
  });
});
