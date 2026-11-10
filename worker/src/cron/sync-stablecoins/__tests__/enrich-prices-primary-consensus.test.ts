import { describe, expect, it } from "vitest";
import { buildPrimaryConsensusResults } from "../enrich-prices-primary-consensus";
import { applyListAggregatorDowngrade } from "../enrich-prices-primary-hardening";
import { validateCompositePricingSourceFreshness } from "../../../lib/pricing-source-freshness";
import { classifyPrimaryDepegTrust } from "../../../lib/depeg-trust-policy";
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

    function build(input: { dexAgeSec: number | null; withIndependentLegs: boolean; aggregatorLegsOnly?: boolean; dexPrice?: number }, asset = usdc, sourceTotalTvl = 2_411_298_816): PrimaryPriceResult | undefined {
      const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
      if (input.aggregatorLegsOnly) {
        asset.geckoId = "usd-coin";
        quoteMaps.cgQuotes.set("usd-coin", { price: 0.9999, observedAt: nowSec - 30, observedAtMode: "upstream" });
      } else {
        delete asset.geckoId;
      }
      if (input.withIndependentLegs && !input.aggregatorLegsOnly) {
        quoteMaps.krakenPrices.set("USDC", 0.9999);
        quoteMaps.krakenObservedAt = nowSec - 60;
        quoteMaps.binancePrices.set("USDC", 1.0001);
        quoteMaps.binanceObservedAt = nowSec - 30;
      }
      const dexRows = new Map([[
        asset.id,
        {
          stablecoin_id: asset.id,
          dex_price_usd: input.dexPrice ?? 0.999936,
          deviation_from_primary_bps: 0,
          source_pool_count: 748,
          source_total_tvl: sourceTotalTvl,
          updated_at: nowSec - 1,
          aggregateObservedAt: input.dexAgeSec == null ? null : nowSec - input.dexAgeSec,
        },
      ]]) as PrimaryDexRows;
      const results = new Map<string, PrimaryPriceResult>();
      buildPrimaryConsensusResults({
        candidates: [asset],
        quoteMaps,
        dexRows,
        dexPriceSources: new Map() as PrimaryDexPriceSources,
        nowSec,
        resolveDlListQuote: () => undefined,
        results,
        stats: createStats(),
      });
      return results.get(asset.id);
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

    it.each([0.999936, 0.4])("keeps an older DEX aggregate as the sole leg with its own clock ($%s)", (price) => {
      const result = build({ dexAgeSec: 3_018, withIndependentLegs: false, dexPrice: price });

      expect(result).toMatchObject({
        source: "dex-promoted",
        price,
        confidence: "single-source",
        observedAt: nowSec - 3_018,
      });
    });

    it.each([
      ["usdc-circle", 250_000, 60, false],
      ["vusd-virtue", 249_999, 60, false],
      ["vusd-virtue", 250_000, 4500, true],
      ["vusd-virtue", 250_000, 4501, false],
    ] as const)("preserves the %s aggregate tier at TVL %s and original age %s", (id, tvl, dexAgeSec, accepted) => {
      expect(build({ dexAgeSec, withIndependentLegs: false }, { ...usdc, id }, tvl) != null).toBe(accepted);
    });

    it.each([null, 21_600, 4500])("rejects original age %s despite fresh publication", (dexAgeSec) => {
      expect(build({ dexAgeSec, withIndependentLegs: false })).toBeUndefined();
      expect(build({ dexAgeSec, withIndependentLegs: true })?.candidateSources).not.toContain("dex-promoted");
    });
  });

  describe("promoted DEX protocol lane", () => {
    // pmUSD at the 2026-11-02 06:45 UTC run, when its open depeg event went blind.
    const nowSec = 1_793_601_977;
    const pmusd: PeggedAsset = {
      id: "pmusd-precious-metals", name: "Precious Metals USD", symbol: "pmUSD",
      geckoId: "precious-metals-usd", pegType: "peggedUSD",
    };

    function build(laneAgeSec: number, cgPrice: number | null = 0.534161): PrimaryPriceResult | undefined {
      const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
      if (cgPrice != null) {
        quoteMaps.cgQuotes.set("precious-metals-usd", { price: cgPrice, observedAt: nowSec - 20, observedAtMode: "upstream" });
      }
      quoteMaps.curvePrices.set(pmusd.id, 0.53416);
      quoteMaps.curveObservedAtByCoinId.set(pmusd.id, nowSec - 30);
      const results = new Map<string, PrimaryPriceResult>();
      buildPrimaryConsensusResults({
        candidates: [pmusd],
        quoteMaps,
        dexRows: new Map() as PrimaryDexRows,
        dexPriceSources: new Map([[pmusd.id, [{
          protocol: "curve", chain: "ethereum", price: 0.53416, tvl: 7_684_693, updatedAt: nowSec - laneAgeSec,
        }]]]) as PrimaryDexPriceSources,
        nowSec,
        resolveDlListQuote: () => undefined,
        results,
        stats: createStats(),
      });
      return results.get(pmusd.id);
    }

    const trustOf = (result: PrimaryPriceResult) => classifyPrimaryDepegTrust({
      price: result.price,
      priceSource: result.source,
      priceConfidence: result.confidence,
      priceObservedAt: result.observedAt,
      priceObservedAtMode: result.observedAtMode,
      agreeSources: result.agreeSources,
    }, nowSec);

    it("keeps a lane past the strictest co-leg window from ageing fresh hard agreement past the depeg budget", () => {
      // 34 minutes old: inside the 35-minute protocol-source budget, outside the
      // 30-minute primary budget, so it stamped the composite untrusted.
      const result = build(2_071);

      expect(result).toMatchObject({ source: "coingecko+curve-onchain", confidence: "high", observedAt: nowSec - 30 });
      expect(trustOf(result!)).toBe("authoritative");
      expect(validateCompositePricingSourceFreshness({
        source: result!.source,
        observedAt: result!.observedAt,
        observedAtMode: result!.observedAtMode,
        nowSec,
        requireObservedAt: true,
      }).accepted).toBe(true);
      // The held lane was read this run: it stays an available candidate, so the
      // three-source depth that keeps pmUSD out of the corroboration probes holds.
      expect(result!.candidateSources).toEqual(["coingecko", "curve-onchain", "curve-dex"]);
      expect(result!.agreeSources).not.toContain("curve-dex");
    });

    it("drops a lane inside the primary budget too while the fresh legs agree", () => {
      const result = build(1_500);

      expect(result).toMatchObject({ source: "coingecko+curve-onchain", observedAt: nowSec - 30 });
      expect(result!.candidateSources).toContain("curve-dex");
    });

    it("admits a lane inside the strictest co-leg window as an agreeing leg", () => {
      const result = build(100);

      expect(result?.agreeSources).toContain("curve-dex");
      expect(result?.observedAt).toBe(nowSec - 100);
    });

    it("keeps Curve agreement through a missing CoinGecko leg, dated by the older lane", () => {
      const result = build(1_500, null);

      expect(result).toMatchObject({ source: "curve-dex+curve-onchain", confidence: "high", observedAt: nowSec - 1_500 });
      expect(trustOf(result!)).toBe("authoritative");
    });

    it("keeps Curve agreement through a CoinGecko leg more than 50 bps away, dated by the older lane", () => {
      // 0.5450 sits about 200 bps from the Curve quote, outside the agreement threshold.
      const result = build(1_500, 0.545);

      expect(result).toMatchObject({ source: "curve-dex+curve-onchain", confidence: "high", observedAt: nowSec - 1_500 });
      expect(result!.disagreeSources).toContain("coingecko");
      expect(trustOf(result!)).toBe("authoritative");
    });

    it("does not let a list-aggregator pair block a lane that agrees with a diverging hard leg", () => {
      // CoinGecko and DefiLlama-list agree with each other but are later reduced
      // to `single-source`; Curve on-chain diverges. The 25-minute curve-dex lane
      // agrees with Curve and must rejoin, restoring the pre-6.68 authoritative
      // composite instead of the downgraded list pair outvoting Curve.
      const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
      quoteMaps.cgQuotes.set("precious-metals-usd", {
        price: 0.545,
        observedAt: nowSec - 20,
        observedAtMode: "upstream",
      });
      quoteMaps.curvePrices.set(pmusd.id, 0.53416);
      quoteMaps.curveObservedAtByCoinId.set(pmusd.id, nowSec - 30);
      const results = new Map<string, PrimaryPriceResult>();
      const stats = createStats();
      buildPrimaryConsensusResults({
        candidates: [pmusd],
        quoteMaps,
        dexRows: new Map() as PrimaryDexRows,
        dexPriceSources: new Map([[pmusd.id, [{
          protocol: "curve", chain: "ethereum", price: 0.53416, tvl: 7_684_693, updatedAt: nowSec - 1_500,
        }]]]) as PrimaryDexPriceSources,
        nowSec,
        resolveDlListQuote: () => ({ price: 0.54505, observedAt: nowSec - 25, observedAtMode: "upstream" }),
        results,
        stats,
      });
      applyListAggregatorDowngrade(results, stats);

      const result = results.get(pmusd.id)!;
      expect(result).toMatchObject({
        source: "curve-dex+curve-onchain",
        confidence: "high",
        observedAt: nowSec - 1_500,
      });
      expect(result.disagreeSources).toEqual(expect.arrayContaining(["coingecko", "defillama-list"]));
      expect(trustOf(result)).toBe("authoritative");
    });

    it("does not rejoin a lane that lands in the list pair's group instead of the hard leg's", () => {
      // The CoinGecko/list pair sits about 53 bps from Curve, so a 25-minute lane
      // at 0.535 agrees with both. Rejoining it creates a three-source cluster
      // with the pair, not Curve: the composite is dated 1,500 s old, fails its
      // CoinGecko leg's freshness, and escapes the list-pair downgrade. The lane
      // must stay held; the fresh list pair is the correct single-source result.
      const quoteMaps = createEmptyPrimaryConsensusQuoteMaps();
      quoteMaps.cgQuotes.set("precious-metals-usd", {
        price: 0.537,
        observedAt: nowSec - 20,
        observedAtMode: "upstream",
      });
      quoteMaps.curvePrices.set(pmusd.id, 0.53416);
      quoteMaps.curveObservedAtByCoinId.set(pmusd.id, nowSec - 30);
      const results = new Map<string, PrimaryPriceResult>();
      const stats = createStats();
      buildPrimaryConsensusResults({
        candidates: [pmusd],
        quoteMaps,
        dexRows: new Map() as PrimaryDexRows,
        dexPriceSources: new Map([[pmusd.id, [{
          protocol: "curve", chain: "ethereum", price: 0.535, tvl: 7_684_693, updatedAt: nowSec - 1_500,
        }]]]) as PrimaryDexPriceSources,
        nowSec,
        resolveDlListQuote: () => ({ price: 0.537, observedAt: nowSec - 25, observedAtMode: "upstream" }),
        results,
        stats,
      });
      applyListAggregatorDowngrade(results, stats);

      const result = results.get(pmusd.id)!;
      expect(result).toMatchObject({
        source: "coingecko+defillama-list",
        confidence: "single-source",
        observedAt: nowSec - 25,
      });
      expect(result.agreeSources).not.toContain("curve-dex");
      expect(result.candidateSources).toContain("curve-dex");
      expect(validateCompositePricingSourceFreshness({
        source: result.source,
        observedAt: result.observedAt,
        observedAtMode: result.observedAtMode,
        nowSec,
        requireObservedAt: true,
      }).accepted).toBe(true);
    });

    it("does not rescue a missing CoinGecko leg with a lane past the primary budget", () => {
      const result = build(2_071, null);

      expect(result).toMatchObject({ source: "curve-onchain", confidence: "single-source", observedAt: nowSec - 30 });
      expect(trustOf(result!)).toBe("confirm_required");
      expect(result!.candidateSources).toEqual(["curve-onchain", "curve-dex"]);
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
});
