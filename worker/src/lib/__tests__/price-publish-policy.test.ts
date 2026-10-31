import { describe, it, expect } from "vitest";
import {
  detectDefiLlamaListFillDefaultPrices,
  hasDepegAuthoritativeSource,
  isReplaySafePriceSource,
} from "@shared/lib/pricing-source-policy";
import {
  validateFallbackPriceCandidate,
  validatePrimaryPriceCandidate,
  validatePublishedAssetPrice,
} from "../price-publish-policy";
import type { PriceValidationContext } from "../price-validation";

const USD_CONTEXT: PriceValidationContext = {
  pegClass: "usd",
  pegType: "peggedUSD",
  navToken: false,
  tracked: true,
};

describe("validatePrimaryPriceCandidate — severe downside with directional corroboration", () => {
  it("does not let the native CG-dependent leg bypass severe-downside or temporal-jump guards", () => {
    expect(validatePrimaryPriceCandidate({
      price: 0.38, source: "hive-native-cg", confidence: "single-source",
      agreeSources: ["hive-native-cg"], candidatePrices: { "hive-native-cg": 0.38, coingecko: 0.39 },
      validationContext: { ...USD_CONTEXT, stablecoinId: "hbd-hive" },
    })).toMatchObject({ accepted: false, reason: "severe_downside_requires_corroboration" });
    expect(validatePrimaryPriceCandidate({
      price: 0.7, source: "hive-native-cg", confidence: "single-source", agreeSources: ["hive-native-cg"],
      validationContext: { ...USD_CONTEXT, stablecoinId: "hbd-hive" },
      previousTrustedPrice: { price: 1, source: "coingecko", confidence: "single-source", observedAt: null, agreeSources: ["coingecko"] },
    })).toMatchObject({ accepted: false, reason: "temporal_jump_requires_corroboration" });
  });
  it("rejects an uncorroborated AZND exact-pool severe downside", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.38,
      source: "curve-thin-onchain",
      confidence: "fallback",
      agreeSources: ["curve-thin-onchain"],
      validationContext: { ...USD_CONTEXT, stablecoinId: "aznd-mu-digital" },
    });

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("severe_downside_requires_corroboration");
  });

  it("rejects an uncorroborated AZND exact-pool temporal jump", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.7,
      source: "curve-thin-onchain",
      confidence: "fallback",
      agreeSources: ["curve-thin-onchain"],
      validationContext: { ...USD_CONTEXT, stablecoinId: "aznd-mu-digital" },
      previousTrustedPrice: {
        price: 1,
        source: "pyth",
        confidence: "high",
        observedAt: null,
        agreeSources: ["pyth"],
      },
    });

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("temporal_jump_requires_corroboration");
  });

  it("rejects severe downside with single source and no corroboration", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.38,
      source: "pyth",
      confidence: "low",
      agreeSources: ["pyth"],
      validationContext: USD_CONTEXT,
    });
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("severe_downside_requires_corroboration");
  });

  it("keeps a VUSD dex-promoted aggregate subject to severe-downside corroboration", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.38,
      source: "dex-promoted",
      confidence: "single-source",
      agreeSources: ["dex-promoted"],
      candidatePrices: { "dex-promoted": 0.38 },
      validationContext: { ...USD_CONTEXT, stablecoinId: "vusd-virtue" },
    });

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("severe_downside_requires_corroboration");
  });

  it("accepts severe downside when 2+ candidate sources confirm severe downside", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.38,
      source: "pyth",
      confidence: "low",
      agreeSources: ["pyth"],
      candidatePrices: { coingecko: 0.39, pyth: 0.38, "defillama-list": 0.51 },
      validationContext: USD_CONTEXT,
    });
    // coingecko 0.39 < 0.50 and pyth 0.38 < 0.50 → 2 severe → accepted
    expect(decision.accepted).toBe(true);
  });

  it("rejects severe downside when only correlated list aggregators corroborate", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.38,
      source: "coingecko+defillama-list",
      confidence: "low",
      agreeSources: ["coingecko", "defillama-list"],
      candidatePrices: { coingecko: 0.39, "defillama-list": 0.38 },
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("severe_downside_requires_corroboration");
  });

  it("accepts corroborated severe downside despite a large jump from previous trusted price", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.1525,
      source: "coingecko+defillama-list",
      confidence: "low",
      agreeSources: ["coingecko", "defillama-list"],
      candidatePrices: {
        coingecko: 0.1525,
        "defillama-list": 0.1524,
        pyth: 0.151,
        "dex-promoted": 1.0007,
      },
      validationContext: USD_CONTEXT,
      previousTrustedPrice: {
        price: 1.0007,
        source: "pyth",
        confidence: "high",
        observedAt: null,
        agreeSources: ["pyth"],
      },
    });
    expect(decision.accepted).toBe(true);
  });

  it("rejects severe downside when only 1 candidate source is in severe downside", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.45,
      source: "pyth",
      confidence: "low",
      agreeSources: ["pyth"],
      candidatePrices: { coingecko: 0.92, pyth: 0.45 },
      validationContext: USD_CONTEXT,
    });
    // only pyth 0.45 < 0.50 → 1 severe → rejected
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("severe_downside_requires_corroboration");
  });

  it("still allows exempt sources without candidatePrices", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.3,
      source: "pool-tvl-weighted",
      confidence: "low",
      agreeSources: ["pool-tvl-weighted"],
      validationContext: USD_CONTEXT,
    });
    expect(decision.accepted).toBe(true);
  });

  it("still allows high confidence with 2+ agree sources", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.35,
      source: "coingecko+pyth",
      confidence: "high",
      agreeSources: ["coingecko", "pyth"],
      validationContext: USD_CONTEXT,
    });
    expect(decision.accepted).toBe(true);
  });

  it("rejects severe downside corroborated only by correlated CoinGecko paths", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.38,
      source: "coingecko+coingecko-onchain-address",
      confidence: "high",
      agreeSources: ["coingecko", "coingecko-onchain-address"],
      candidatePrices: { coingecko: 0.38, "coingecko-onchain-address": 0.38 },
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("severe_downside_requires_corroboration");
  });

  it("still allows when previous trusted price was also severe downside", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.38,
      source: "pyth",
      confidence: "low",
      agreeSources: ["pyth"],
      validationContext: USD_CONTEXT,
      previousTrustedPrice: {
        price: 0.4,
        source: "coingecko",
        confidence: "low",
        observedAt: null,
        agreeSources: ["coingecko"],
      },
    });
    expect(decision.accepted).toBe(true);
  });

  it("does not trigger directional corroboration for non-severe prices", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.85,
      source: "pyth",
      confidence: "low",
      agreeSources: ["pyth"],
      candidatePrices: { coingecko: 0.3, pyth: 0.85 },
      validationContext: USD_CONTEXT,
    });
    // price 0.85 is NOT severe downside, so the check doesn't trigger at all
    expect(decision.accepted).toBe(true);
  });
});

describe("validatePublishedAssetPrice — candidatePrices as a separate argument", () => {
  it("uses separately passed candidatePrices for severe-downside corroboration", () => {
    const decision = validatePublishedAssetPrice({
      asset: {
        price: 0.38,
        priceSource: "pyth",
        priceConfidence: "low",
        agreeSources: ["pyth"],
      },
      candidatePrices: { coingecko: 0.39, pyth: 0.38, "defillama-list": 0.51 },
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(true);
  });

  it("rejects the same severe downside when no candidatePrices are passed", () => {
    const decision = validatePublishedAssetPrice({
      asset: {
        price: 0.38,
        priceSource: "pyth",
        priceConfidence: "low",
        agreeSources: ["pyth"],
      },
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("severe_downside_requires_corroboration");
  });
});

describe("DefiLlama exact-reference defaults", () => {
  it("rejects a sole DefiLlama list quote at exactly the peg reference", () => {
    expect(validatePrimaryPriceCandidate({
      price: 1, source: "defillama-list", confidence: "single-source",
      agreeSources: ["defillama-list"], validationContext: USD_CONTEXT,
    })).toMatchObject({ accepted: false, reason: "exact_par_list_price_requires_corroboration" });
  });

  it("rejects a retained sole DefiLlama list price at exactly the reference", () => {
    expect(validatePublishedAssetPrice({
      asset: { price: 1, priceSource: "defillama", priceConfidence: "single-source", agreeSources: ["defillama"] },
      validationContext: USD_CONTEXT,
    })).toMatchObject({ accepted: false, reason: "exact_par_list_price_requires_corroboration" });
  });

  it("rejects a sole DefiLlama contract quote at exactly the reference", () => {
    expect(validateFallbackPriceCandidate({
      price: 1, source: "defillama-contract", confidence: "fallback",
      agreeSources: ["defillama-contract"], validationContext: USD_CONTEXT,
    })).toMatchObject({ accepted: false, reason: "exact_par_list_price_requires_corroboration" });
  });

  it("admits an exact-reference quote corroborated by another source family", () => {
    expect(validatePrimaryPriceCandidate({
      price: 1, source: "coingecko+defillama-list", confidence: "high",
      agreeSources: ["coingecko", "defillama-list"], validationContext: USD_CONTEXT,
    }).accepted).toBe(true);
  });

  it("keeps non-reference DefiLlama list quotes admitted", () => {
    expect(validatePrimaryPriceCandidate({
      price: 0.999, source: "defillama-list", confidence: "single-source",
      agreeSources: ["defillama-list"], validationContext: USD_CONTEXT,
    }).accepted).toBe(true);
  });

  it("applies to the exact non-USD peg reference", () => {
    const phpContext: PriceValidationContext = {
      stablecoinId: "test-php",
      pegCurrency: "PHP",
      pegType: "peggedPHP",
      pegClass: "fiat_fx",
      navToken: false,
      tracked: true,
    };
    const references = {
      rates: { peggedPHP: 0.01755 },
      type: "fresh" as const,
      updatedAt: 1_800_000_000,
    };
    expect(validatePrimaryPriceCandidate({
      price: 0.01755, source: "defillama-list", confidence: "single-source",
      agreeSources: ["defillama-list"], validationContext: phpContext, validationReferences: references,
    })).toMatchObject({ accepted: false, reason: "exact_par_list_price_requires_corroboration" });
    expect(validatePrimaryPriceCandidate({
      price: 0.0175, source: "defillama-list", confidence: "single-source",
      agreeSources: ["defillama-list"], validationContext: phpContext, validationReferences: references,
    }).accepted).toBe(true);
  });
});

describe("DefiLlama list fill defaults", () => {
  const FILL_DEFAULT = 0.9990120985638516;
  const LIST_FILL = { value: FILL_DEFAULT, upstreamSource: "defillama" };

  it("flags a value repeated across five distinct list assets and not one shared by four", () => {
    const distinctRows = (count: number, price: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `list-${index}`, price }));

    expect(detectDefiLlamaListFillDefaultPrices(distinctRows(5, FILL_DEFAULT))).toEqual(new Set([FILL_DEFAULT]));
    expect(detectDefiLlamaListFillDefaultPrices(distinctRows(4, 0.999520515794015)).size).toBe(0);
  });

  it("rejects a sole DefiLlama list quote at a per-response fill default", () => {
    expect(validatePrimaryPriceCandidate({
      price: FILL_DEFAULT, source: "defillama-list", confidence: "single-source",
      agreeSources: ["defillama-list"], listFillDefault: LIST_FILL, validationContext: USD_CONTEXT,
    })).toMatchObject({ accepted: false, reason: "list_fill_default_requires_corroboration" });
  });

  it("rejects a retained list-attributed quote stamped from the raw list", () => {
    expect(validatePublishedAssetPrice({
      asset: {
        price: FILL_DEFAULT, priceSource: "defillama", priceConfidence: "single-source",
        agreeSources: ["defillama"], priceListFillDefault: LIST_FILL,
      },
      validationContext: USD_CONTEXT,
    })).toMatchObject({ accepted: false, reason: "list_fill_default_requires_corroboration" });
  });

  it("covers a fill default the list itself attributes to coingecko", () => {
    expect(validatePublishedAssetPrice({
      asset: {
        price: FILL_DEFAULT, priceSource: "coingecko", priceConfidence: "single-source",
        agreeSources: ["coingecko"],
        priceListFillDefault: { value: FILL_DEFAULT, upstreamSource: "coingecko" },
      },
      validationContext: USD_CONTEXT,
    })).toMatchObject({ accepted: false, reason: "list_fill_default_requires_corroboration" });
  });

  it("rejects a fill default offered by the DefiLlama contract fallback lane", () => {
    expect(validateFallbackPriceCandidate({
      price: FILL_DEFAULT, source: "defillama-contract", confidence: "fallback",
      agreeSources: ["defillama-contract"], listFillDefault: LIST_FILL, validationContext: USD_CONTEXT,
    })).toMatchObject({ accepted: false, reason: "list_fill_default_requires_corroboration" });
  });

  it("admits a fill-default value corroborated by another source family", () => {
    expect(validatePublishedAssetPrice({
      asset: {
        price: FILL_DEFAULT, priceSource: "coingecko+defillama-list", priceConfidence: "high",
        agreeSources: ["coingecko", "defillama-list"], priceListFillDefault: LIST_FILL,
      },
      validationContext: USD_CONTEXT,
    }).accepted).toBe(true);
  });

  it("leaves the same value admitted when the response did not flag it", () => {
    expect(validatePrimaryPriceCandidate({
      price: FILL_DEFAULT, source: "defillama-list", confidence: "single-source",
      agreeSources: ["defillama-list"], validationContext: USD_CONTEXT,
    }).accepted).toBe(true);
  });
});

describe("validatePrimaryPriceCandidate — weak fallback fixed-peg depegs", () => {
  it("accepts a legacy exact-pool display route without granting depeg authority", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.01621,
      source: "uniswap-v3-exact",
      confidence: "fallback",
      agreeSources: ["uniswap-v3-exact"],
      validationContext: {
        stablecoinId: "test-php",
        pegCurrency: "PHP",
        pegType: "peggedPHP",
        pegClass: "fiat_fx",
        navToken: false,
        tracked: true,
      },
      validationReferences: {
        rates: { peggedPHP: 0.01755 },
        type: "fresh",
        updatedAt: Math.floor(Date.now() / 1000),
      },
    });

    expect(decision.accepted).toBe(true);
    expect(hasDepegAuthoritativeSource(["uniswap-v3-exact"])).toBe(false);
    expect(isReplaySafePriceSource("uniswap-v3-exact")).toBe(false);
  });

  it("rejects a depeg-sized single-source address-provider quote", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.9459920248,
      source: "coingecko-onchain-address",
      confidence: "single-source",
      agreeSources: ["coingecko-onchain-address"],
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("weak_fallback_depeg_requires_corroboration");
  });

  it("still accepts a near-peg address-provider quote", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.99967,
      source: "coingecko-onchain-address",
      confidence: "single-source",
      agreeSources: ["coingecko-onchain-address"],
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(true);
  });

  it("does not block exact DefiLlama contract fallback prices", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.9459920248,
      source: "defillama-contract",
      confidence: "single-source",
      agreeSources: ["defillama-contract"],
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(true);
  });

  it("allows depeg-sized hard-source quotes", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.9459920248,
      source: "pyth",
      confidence: "single-source",
      agreeSources: ["pyth"],
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(true);
  });

  it("accepts a severe exact-address fallback corroborated by a same-run independent quote", () => {
    const decision = validateFallbackPriceCandidate({
      price: 0.3904,
      source: "dexscreener-exact",
      confidence: "fallback",
      agreeSources: ["dexscreener-exact"],
      candidatePrices: {
        coingecko: 0.390247,
        "dexscreener-exact": 0.3904,
      },
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(true);
  });

  it("still rejects severe fallback evidence from list aggregators only", () => {
    const decision = validateFallbackPriceCandidate({
      price: 0.3904,
      source: "coinmarketcap",
      confidence: "fallback",
      agreeSources: ["coinmarketcap"],
      candidatePrices: {
        coingecko: 0.390247,
        "defillama-list": 0.3903,
        coinmarketcap: 0.3904,
      },
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("severe_downside_requires_corroboration");
  });

  it("does not use severe candidate evidence to admit a non-severe fallback quote", () => {
    const decision = validateFallbackPriceCandidate({
      price: 0.94,
      source: "dexscreener-exact",
      confidence: "fallback",
      agreeSources: ["dexscreener-exact"],
      candidatePrices: {
        coingecko: 0.390247,
        pyth: 0.3904,
        "dexscreener-exact": 0.94,
      },
      validationContext: USD_CONTEXT,
    });

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe("weak_fallback_depeg_requires_corroboration");
  });
});
