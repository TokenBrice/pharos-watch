import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTrackedAssetOverrides } from "../../cron/sync-stablecoins/phase-helpers";
import { buildPreviousTrustedPriceLookup } from "../../cron/sync-stablecoins/pricing";
import { runDlContractPasses } from "../../cron/sync-stablecoins/enrich-prices-defillama-pass";
import { makePeggedAsset } from "../../cron/sync-stablecoins/__tests__/_fixtures";
import { validatePrimaryPriceCandidate, validateFallbackPriceCandidate } from "../price-publish-policy";
import { buildPriceValidationContext } from "../price-validation";
import { fetchCoinGeckoMarketHistory } from "../coingecko-market-history";
import { fetchCgPriceHistoryHourly, fetchMarketBackfillPriceSeries } from "../../api/backfill-price-sources";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { isCoinGeckoHistoryAllowed } from "../solomon-usdv-identity";

const LEGACY = "usdv-solomon";
const NEW = "usdv-solomon-v2";
const NOW = 1_800_000_000;
afterEach(() => vi.unstubAllGlobals());

describe("Solomon's separate replacement mint", () => {
  it("drops the recycled upstream identity and price while retaining legacy USD supply and history", () => {
    const legacy = makePeggedAsset({ id: LEGACY, geckoId: "solomon-usdv", gecko_id: "solomon-usdv", price: 0.99994,
      circulating: { peggedUSD: 1_514_652.7038658247 }, circulatingPrevDay: { peggedUSD: 1_514_653 } });
    const replacement = makePeggedAsset({ id: NEW, geckoId: "solomon-usdv", price: 0.99992, circulating: { peggedUSD: 20_998 } });
    applyTrackedAssetOverrides([legacy, replacement]);
    expect(legacy.name).toBe("Solomon USDv (Legacy)");
    expect(legacy).toMatchObject({ price: null, circulating: { peggedUSD: 1_514_652.7038658247 }, circulatingPrevDay: { peggedUSD: 1_514_653 } });
    expect(legacy.geckoId).toBeUndefined();
    expect(legacy.gecko_id).toBeUndefined();
    expect(replacement).toMatchObject({ geckoId: "solomon-usdv", price: 0.99992, circulating: { peggedUSD: 20_998 } });
  });

  it.each(["defillama", "defillama-list", "defillama-contract", "coingecko", "coingecko+defillama", "cached"])(
    "rejects mismatched legacy %s publication and replay", (source) => {
      const input = { price: 0.99994, source, confidence: "single-source" as const,
        validationContext: buildPriceValidationContext({ stablecoinId: LEGACY, pegCurrency: "USD" }) };
      expect(validatePrimaryPriceCandidate(input)).toEqual({ accepted: false, reason: "provider_identity_mismatch" });
      expect(validateFallbackPriceCandidate(input).accepted).toBe(false);
      const row = makePeggedAsset({ id: LEGACY, price: 0.99994, priceSource: source, priceConfidence: "single-source",
        priceObservedAt: NOW - 10, priceObservedAtMode: "upstream", agreeSources: [source] });
      expect(buildPreviousTrustedPriceLookup(new Map([[LEGACY, row]]), NOW).has(LEGACY)).toBe(false);
      expect(buildPreviousTrustedPriceLookup(new Map(), NOW, new Map([[LEGACY, {
        price: 0.99994, source, confidence: "single-source", updatedAt: NOW - 10, observedAt: NOW - 10, agreeSources: [source],
      }]])).has(LEGACY)).toBe(false);
    },
  );

  it("permits exact-mint DEX prices and new-token CG but rejects contaminated agreement lineage", () => {
    const input = { price: 0.9988, source: "dexscreener", confidence: "fallback" as const,
      validationContext: buildPriceValidationContext({ stablecoinId: LEGACY, pegCurrency: "USD" }) };
    expect(validateFallbackPriceCandidate(input).accepted).toBe(true);
    expect(validateFallbackPriceCandidate({ ...input, agreeSources: ["dexscreener", "defillama"] }).accepted).toBe(false);
    expect(validatePrimaryPriceCandidate({ ...input, source: "coingecko", confidence: "single-source",
      validationContext: buildPriceValidationContext({ stablecoinId: NEW, pegCurrency: "USD" }) }).accepted).toBe(true);
  });

  it("never queries the contaminated legacy DefiLlama contract fallback", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const assets = [makePeggedAsset({ id: LEGACY, address: "Ex5DaKYMCN6QWFA4n67TmMwsH8MJV68RX6YXTmVM532C", price: null })];
    const result = await runDlContractPasses(assets, undefined);
    expect(result.pass1).toBe(0);
    expect(assets[0].price).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("withholds mixed CG supply/price history, hourly history and caller-provided seeds without fetching", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(isCoinGeckoHistoryAllowed("tether")).toBe(true);
    expect(await fetchCoinGeckoMarketHistory("solomon-usdv")).toBeNull();
    expect(await fetchCgPriceHistoryHourly("solomon-usdv")).toEqual([]);
    for (const id of [LEGACY, NEW]) {
      const result = await fetchMarketBackfillPriceSeries(TRACKED_META_BY_ID.get(id)!, "solomon-usdv", {
        seedCoinGeckoPrices: [{ timestamp: NOW - 86_400, price: 1 }],
      });
      expect(result.prices).toBeNull();
      expect(result.diagnostics.finalPointCount).toBe(0);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
