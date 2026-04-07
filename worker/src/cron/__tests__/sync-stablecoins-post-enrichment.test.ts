import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

vi.mock("@shared/lib/stablecoins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/lib/stablecoins")>();
  return {
    ...actual,
    TRACKED_META_BY_ID: new Map([
      ["eurc-circle", {
        geckoId: "euro-coin",
        flags: { pegCurrency: "EUR", navToken: false },
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
import { isAbortResult, runPostEnrichmentPricePipeline } from "../sync-stablecoins/post-enrichment";
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
  return {
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
  };
}

describe("runPostEnrichmentPricePipeline", () => {
  beforeEach(() => {
    fetchCurrentNativePegImpliedUsdQuotesMock.mockReset().mockResolvedValue(new Map());
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
    expect(asset.priceConfidence).toBe("single-source");
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
    expect(asset.priceConfidence).toBe("single-source");
    expect(
      db.getHistory().some((entry) => entry.sql.includes("INSERT OR REPLACE INTO price_cache")),
    ).toBe(false);
  });
});
