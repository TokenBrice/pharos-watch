import { afterEach, describe, expect, it, vi } from "vitest";
import { applyConsensusResults, createValidationContextResolver, prevalidatePrices } from "../sync-stablecoins/pricing";
import { restoreMissingTrackedAssets } from "../sync-stablecoins/shared";
import { enrichMissingPrices, type PeggedAsset, type PrimaryPriceResult } from "../sync-stablecoins/enrich-prices";
import { mockFetch } from "@shared/test-utils/mock-fetch";

const freshObservedAtSec = () => Math.floor(Date.now() / 1000) - 60;

function dlQuote(price: number, symbol: string) {
  return {
    price,
    symbol,
    timestamp: freshObservedAtSec(),
    confidence: 0.95,
  };
}

describe("pricing application policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lets USG reject a weak address-provider depeg and recover through exact DefiLlama contract fallback", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "usg-tangent",
        name: "Tangent USD",
        symbol: "USG",
        pegType: "peggedUSD",
        circulating: {},
      },
    ];
    const primaryResult: PrimaryPriceResult = {
      price: 0.9459920248,
      source: "coingecko-onchain-address",
      selectedSource: "coingecko-onchain-address",
      confidence: "single-source",
      dlPrice: null,
      cgPrice: null,
      candidateSources: ["coingecko-onchain-address"],
      agreeSources: ["coingecko-onchain-address"],
      allPrices: { "coingecko-onchain-address": 0.9459920248 },
      observedAt: freshObservedAtSec(),
      observedAtMode: "local_fetch",
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    applyConsensusResults({
      assets,
      primaryPriceResults: new Map([["usg-tangent", primaryResult]]),
      validationContexts: createValidationContextResolver(),
      syncStartSec: Math.floor(Date.now() / 1000),
      reason: "primary",
    });

    expect(assets[0].price).toBeUndefined();
    expect(assets[0].priceSource).toBeUndefined();
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("weak_fallback_depeg_requires_corroboration"))).toBe(true);

    mockFetch([
      {
        match: "coins.llama.fi/prices/current/ethereum:0xb1c2db5d6ca03fce73dbd304d320bf76c55ae1b1",
        body: {
          coins: {
            "ethereum:0xb1c2db5d6ca03fce73dbd304d320bf76c55ae1b1": dlQuote(0.9994, "USG"),
          },
        },
      },
    ]);

    const stats = await enrichMissingPrices(assets);

    expect(stats.pass1).toBe(1);
    expect(assets[0].price).toBe(0.9994);
    expect(assets[0].priceSource).toBe("defillama-contract");
    expect(assets[0].priceConfidence).toBe("single-source");
  });

  it("publishes a current composite with a 20-minute-old DEX member and drops only the restored stale quote", () => {
    const nowSec = 1_790_541_043;
    const usdt: PeggedAsset = {
      id: "usdt-tether", name: "Tether", symbol: "USDT", pegType: "peggedUSD",
      price: 1.0001, circulating: { peggedUSD: 185_000_000_000 },
    };
    const members = ["bitstamp", "coingecko", "kraken", "uniswap-v3-dex"];
    const candidate: PrimaryPriceResult = {
      price: 1.0002,
      source: members.join("+"),
      confidence: "high",
      dlPrice: 1.0001,
      cgPrice: 1.0002,
      candidateSources: members,
      agreeSources: members,
      allPrices: { bitstamp: 1.0002, coingecko: 1.0002, kraken: 1.0001, "uniswap-v3-dex": 1.0003 },
      // The consensus stamps the oldest agreeing member: the hourly DEX quote.
      observedAt: nowSec - 1_200,
      observedAtMode: "local_fetch",
      observedAtBySource: { bitstamp: nowSec - 40, coingecko: nowSec - 60, kraken: nowSec - 35, "uniswap-v3-dex": nowSec - 1_200 },
    };
    // Previous-generation MXNE row: an ordinary CoinGecko quote ~40h old at restore time.
    const previousMxne: PeggedAsset = {
      id: "mxne-real-mxn", name: "MXNe", symbol: "MXNE", pegType: "peggedMXN",
      price: 0.0567, priceSource: "coingecko", priceConfidence: "single-source",
      priceObservedAt: nowSec - 144_443, priceObservedAtMode: "upstream", priceSyncedAt: nowSec - 900,
      agreeSources: ["coingecko"], supplyObservedAt: nowSec - 900, circulating: { peggedMXN: 21_000_000 },
    };
    const restored = restoreMissingTrackedAssets([usdt], new Map([[previousMxne.id, previousMxne]]), nowSec).assets;
    const assets = [usdt, ...restored];
    const validationContexts = createValidationContextResolver();
    const primaryPriceResults = new Map([[usdt.id, candidate]]);

    applyConsensusResults({ assets, primaryPriceResults, validationContexts, syncStartSec: nowSec, reason: "primary" });
    prevalidatePrices({ assets, primaryPriceResults, validationContexts, logLabel: "test" });

    expect(usdt).toMatchObject({ price: 1.0002, priceSource: candidate.source, priceConfidence: "high", priceObservedAt: nowSec - 1_200 });
    const mxne = assets.find((asset) => asset.id === previousMxne.id);
    expect(mxne).toMatchObject({ price: null, supplyRestored: true, circulating: previousMxne.circulating });
  });
});
