import { describe, expect, it } from "vitest";
import { buildPrimaryConsensusResults } from "../enrich-prices-primary-consensus";
import type {
  PrimaryConsensusQuoteMaps,
  PrimaryDexPriceSources,
  PrimaryDexRows,
} from "../enrich-prices-primary-provider-collection";
import type { PeggedAsset, PrimaryPriceResult } from "../enrich-prices-shared";
import type { PriceValidationStats } from "../enrich-prices-primary-shared";

function createEmptyQuoteMaps(): PrimaryConsensusQuoteMaps {
  return {
    cgPrices: new Map(),
    cgObservedAtByGeckoId: new Map(),
    cgObservedAtModeByGeckoId: new Map(),
    cgObservedAt: null,
    cgTickerPrices: new Map(),
    cgTickerObservedAt: null,
    binancePrices: new Map(),
    binanceObservedAt: null,
    krakenPrices: new Map(),
    krakenObservedAt: null,
    bitstampPrices: new Map(),
    bitstampObservedAtBySymbol: new Map(),
    coinbasePrices: new Map(),
    coinbaseObservedAtBySymbol: new Map(),
    redstonePrices: new Map(),
    curvePrices: new Map(),
    curveObservedAtByCoinId: new Map(),
    curveOraclePrice: null,
    curveOracleObservedAt: null,
    navPrices: new Map(),
    addressProviderQuotes: new Map(),
  };
}

function createStats(): PriceValidationStats {
  return {
    attempted: 0,
    high: 0,
    singleSource: 0,
    cgOnly: 0,
    low: 0,
  };
}

describe("buildPrimaryConsensusResults", () => {
  it("attributes RedStone quotes by stablecoin id instead of same-symbol peers", () => {
    const nowSec = 1_780_752_600;
    const candidates: PeggedAsset[] = [
      {
        id: "usdh-hubble",
        name: "Hubble USDH",
        symbol: "USDH",
        pegType: "peggedUSD",
      },
      {
        id: "usdh-native-markets",
        name: "Native Markets USDH",
        symbol: "USDH",
        pegType: "peggedUSD",
      },
    ];
    const quoteMaps = createEmptyQuoteMaps();
    quoteMaps.redstonePrices.set("usdh-native-markets", {
      price: 0.9999,
      venueCount: 2,
      venueAgreementPct: 100,
      timestamp: nowSec,
    });

    const results = new Map<string, PrimaryPriceResult>();
    buildPrimaryConsensusResults({
      candidates,
      quoteMaps,
      dexRows: new Map() as PrimaryDexRows,
      dexPriceSources: new Map() as PrimaryDexPriceSources,
      nowSec,
      resolveDlListQuote: () => undefined,
      results,
      stats: createStats(),
    });

    expect(results.has("usdh-hubble")).toBe(false);
    expect(results.get("usdh-native-markets")?.source).toBe("redstone");
  });
});
