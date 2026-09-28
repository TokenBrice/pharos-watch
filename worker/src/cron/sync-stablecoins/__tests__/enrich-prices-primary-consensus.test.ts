import { describe, expect, it } from "vitest";
import { buildPrimaryConsensusResults } from "../enrich-prices-primary-consensus";
import {
  createEmptyPrimaryConsensusQuoteMaps,
  type PrimaryDexPriceSources,
  type PrimaryDexRows,
} from "../enrich-prices-primary-provider-collection";
import type { PeggedAsset, PriceValidationStats, PrimaryPriceResult } from "../enrich-prices-shared";


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
  describe("DEX aggregate leg", () => {
    const nowSec = 1_790_629_276;
    const usdc: PeggedAsset = { id: "usdc-circle", name: "USD Coin", symbol: "USDC", pegType: "peggedUSD" };

    function build(input: { dexAgeSec: number; withIndependentLegs: boolean }): PrimaryPriceResult | undefined {
      const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
      if (input.withIndependentLegs) {
        quoteMaps.krakenPrices.set("USDC", 0.9999);
        quoteMaps.krakenObservedAt = nowSec - 60;
        quoteMaps.redstonePrices.set("usdc-circle", {
          price: 1.0001,
          venueCount: 3,
          venueAgreementPct: 100,
          timestamp: nowSec - 30,
        });
      }
      const dexRows = new Map([[
        "usdc-circle",
        {
          stablecoin_id: "usdc-circle",
          dex_price_usd: 0.999936,
          deviation_from_primary_bps: 0,
          source_pool_count: 748,
          source_total_tvl: 2_411_298_816,
          updated_at: nowSec - input.dexAgeSec,
        },
      ]]) as PrimaryDexRows;
      const results = new Map<string, PrimaryPriceResult>();
      buildPrimaryConsensusResults({
        candidates: [usdc],
        quoteMaps,
        dexRows,
        dexPriceSources: new Map() as PrimaryDexPriceSources,
        nowSec,
        resolveDlListQuote: () => undefined,
        results,
        stats: createStats(),
      });
      return results.get("usdc-circle");
    }

    it("keeps a DEX aggregate older than the primary budget from ageing fresh agreement", () => {
      // The previous hourly DEX run's row, 50 minutes old: still inside its own
      // 75-minute window, outside the 30-minute primary budget.
      const result = build({ dexAgeSec: 3_018, withIndependentLegs: true });

      expect(result?.agreeSources).not.toContain("dex-promoted");
      expect(result?.candidateSources).not.toContain("dex-promoted");
      expect(result?.confidence).toBe("high");
      expect(result?.observedAt).toBe(nowSec - 60);
    });

    it("admits a DEX aggregate inside the primary budget as an agreeing leg", () => {
      const result = build({ dexAgeSec: 1_800, withIndependentLegs: true });

      expect(result?.agreeSources).toContain("dex-promoted");
      expect(result?.observedAt).toBe(nowSec - 1_800);
    });

    it("keeps an older DEX aggregate as the sole leg with its own clock", () => {
      const result = build({ dexAgeSec: 3_018, withIndependentLegs: false });

      expect(result).toMatchObject({
        source: "dex-promoted",
        confidence: "single-source",
        observedAt: nowSec - 3_018,
      });
    });
  });

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
    const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
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
