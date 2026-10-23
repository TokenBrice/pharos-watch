import { describe, expect, it } from "vitest";
import { buildPrimaryConsensusResults } from "../enrich-prices-primary-consensus";
import { validateCompositePricingSourceFreshness } from "../../../lib/pricing-source-freshness";
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
  it("keeps the valid native candidate through family collapse and final peg validation, only for HBD", () => {
    const nowSec = 1_800_000_000;
    const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
    quoteMaps.cgQuotes.set("hive_dollar", { price: 2.25, observedAt: nowSec, observedAtMode: "upstream" });
    quoteMaps.hiveNativeQuote = { price: 0.98662, observedAt: nowSec - 4, observedAtMode: "local_fetch" };
    const results = new Map<string, PrimaryPriceResult>();
    buildPrimaryConsensusResults({
      candidates: [{ id: "hbd-hive", name: "HBD", symbol: "HBD", geckoId: "hive_dollar", pegType: "peggedUSD" }, { id: "test-usd", name: "Other", symbol: "OTHER", pegType: "peggedUSD" }],
      quoteMaps, dexRows: new Map(), dexPriceSources: new Map(), nowSec,
      resolveDlListQuote: () => undefined, results, stats: createStats(),
    });
    expect(results.get("hbd-hive")).toMatchObject({ source: "hive-native-cg", price: 0.98662, confidence: "single-source", observedAt: nowSec - 4, observedAtMode: "local_fetch" });
    expect(results.has("test-usd")).toBe(false);
  });
  describe("DEX aggregate leg", () => {
    const nowSec = 1_790_629_276;
    const usdc: PeggedAsset = { id: "usdc-circle", name: "USD Coin", symbol: "USDC", pegType: "peggedUSD" };

    function build(input: { dexAgeSec: number; withIndependentLegs: boolean; aggregatorLegsOnly?: boolean }): PrimaryPriceResult | undefined {
      const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
      if (input.aggregatorLegsOnly) {
        usdc.geckoId = "usd-coin";
        quoteMaps.cgQuotes.set("usd-coin", { price: 0.9999, observedAt: nowSec - 30, observedAtMode: "upstream" });
      } else {
        delete usdc.geckoId;
      }
      if (input.withIndependentLegs && !input.aggregatorLegsOnly) {
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

    it("admits a DEX aggregate inside the strictest co-leg window as an agreeing leg", () => {
      const result = build({ dexAgeSec: 100, withIndependentLegs: true });

      expect(result?.agreeSources).toContain("dex-promoted");
      expect(result?.observedAt).toBe(nowSec - 100);
    });

    it("keeps a DEX aggregate past a co-leg's window from failing the composite's freshness", () => {
      // 20 minutes old: inside the 30-minute primary budget, outside CoinGecko's
      // 15-minute window, so admitting it stamped USDC stale for every
      // authoritative child priced from it.
      const result = build({ dexAgeSec: 1_200, withIndependentLegs: true, aggregatorLegsOnly: true });

      expect(result?.candidateSources).not.toContain("dex-promoted");
      expect(result?.observedAt).toBe(nowSec - 30);
      expect(validateCompositePricingSourceFreshness({
        source: result!.source,
        observedAt: result!.observedAt,
        observedAtMode: result!.observedAtMode,
        nowSec,
        requireObservedAt: true,
      }).accepted).toBe(true);
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

  it("does not treat two chains of one promoted DEX protocol as independent corroboration", () => {
    const nowSec = 1_800_000_000;
    const asset: PeggedAsset = { id: "cgusd-cygnus-finance", name: "Cygnus USD", symbol: "cgUSD", pegType: "peggedUSD" };
    const results = new Map<string, PrimaryPriceResult>();
    buildPrimaryConsensusResults({
      candidates: [asset],
      quoteMaps: createEmptyPrimaryConsensusQuoteMaps(),
      dexRows: new Map(),
      dexPriceSources: new Map([[asset.id, ["ethereum", "base"].map((chain) => ({
        protocol: "uniswap-v3", chain, price: 0.99, tvl: 50_000, updatedAt: nowSec - 60,
      }))]]),
      nowSec,
      resolveDlListQuote: () => undefined,
      results,
      stats: createStats(),
    });
    expect(results.size).toBe(0);
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
