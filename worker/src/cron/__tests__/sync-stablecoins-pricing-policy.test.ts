import { afterEach, describe, expect, it, vi } from "vitest";
import { applyConsensusResults, createValidationContextResolver } from "../sync-stablecoins/pricing";
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
});
