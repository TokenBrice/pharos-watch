import { describe, expect, it } from "vitest";
import { buildPrimaryConsensusResults } from "../enrich-prices-primary-consensus";
import type {
  PrimaryDexPriceSources,
  PrimaryDexRows,
} from "../enrich-prices-primary-provider-collection";
import type { PeggedAsset, PrimaryPriceResult } from "../enrich-prices-shared";
import { createEmptyQuoteMaps, createStats } from "./enrich-prices-primary-consensus.test-support";

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
