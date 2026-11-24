import { describe, it, expect } from "vitest";
import {
  detectDefiLlamaContractFillDefaultPrices,
  detectDefiLlamaListFillDefaultPrices,
  hasDepegAuthoritativeSource,
  isReplaySafePriceSource,
} from "@shared/lib/pricing-source-policy";
import {
  resolveContractFillLineageGroup,
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

describe("fiat upper-band publication", () => {
  it.each([
    ["reviewed-range premium", 1.23, "kraken", { kraken: 1.23, binance: 1.231 }, true],
    ["exact boundary", 1.19, "kraken", { kraken: 1.19, binance: 1.19 }, true],
    ["lone price", 1.23, "kraken", undefined, false],
    ["different magnitude", 1.23, "kraken", { kraken: 1.23, binance: 1.48 }, false],
    ["different magnitudes around the candidate", 1.23, "kraken+binance", { kraken: 1.225, binance: 1.235 }, false],
    ["selected price lacks direct support", 1.23, "coingecko", { kraken: 1.23, binance: 1.23 }, false],
    ["same family", 1.23, "coingecko", { coingecko: 1.23, "coingecko-low-volume": 1.23 }, false],
    ["list aggregators only", 1.23, "coingecko", { coingecko: 1.23, "defillama-list": 1.23 }, false],
    ["converted vote", 1.23, "kraken", { kraken: 1.23, "coingecko-native-implied": 1.23 }, false],
    ["potential venue mirror", 1.23, "kraken", { kraken: 1.23, "cg-ticker": 1.23 }, false],
    ["stale pool clock", 1.23, "kraken", { kraken: 1.23, "curve-dex": 1.23 }, false],
  ] as const)("evaluates %s", (_name, ratio, source, quotes, accepted) => {
    const par = 0.2;
    const candidatePrices = quotes && Object.fromEntries(Object.entries(quotes).map(([key, value]) => [key, value * par]));
    const now = Math.floor(Date.now() / 1000);
    const fiatPremiumEvidence = Object.fromEntries(Object.entries(candidatePrices ?? {}).map(([key, priceUsd]) => [key, {
      priceUsd,
      observedAtSec: now - (key === "curve-dex" ? 6_000 : 60),
      upstreamKeys: [`venue:${key === "cg-ticker" ? "kraken" : key}`],
    }]));
    const decision = validatePrimaryPriceCandidate({
      price: par * ratio, source, confidence: "high", candidatePrices, fiatPremiumEvidence,
      validationContext: { ...USD_CONTEXT, pegClass: "fiat_fx", pegType: "peggedREAL" },
      validationReferences: { rates: { peggedREAL: par }, type: "fresh", updatedAt: null },
    });
    expect(decision).toEqual({
      accepted, reason: accepted ? "corroborated_fiat_premium" : "fiat_upper_band_requires_corroboration",
    });
  });
});

describe("validatePrimaryPriceCandidate — severe downside with directional corroboration", () => {
  it("requires disjoint upstreams for severe downside even when two source names agree", () => {
    const pool = "ethereum:0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7";
    const input = {
      price: 0.45, source: "bitstamp", confidence: "high" as const,
      agreeSources: ["bitstamp", "curve-onchain"],
      candidatePrices: { bitstamp: 0.45, "curve-onchain": 0.45 },
      validationContext: USD_CONTEXT,
    };
    expect(validatePrimaryPriceCandidate(input).accepted).toBe(true);
    expect(validatePrimaryPriceCandidate({
      ...input,
      upstreamKeysBySource: { bitstamp: ["venue:bitstamp"], "curve-onchain": [pool, "venue:bitstamp"] },
    })).toMatchObject({ accepted: false, reason: "severe_downside_requires_corroboration" });
    expect(validatePrimaryPriceCandidate({
      ...input, confidence: "low", source: "coinbase", agreeSources: ["coinbase"],
      candidatePrices: { coinbase: 0.45, "curve-onchain": 0.36 },
      upstreamKeysBySource: { coinbase: ["venue:coinbase"], "curve-onchain": [pool, "venue:bitstamp"] },
    }).accepted).toBe(true);
  });

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
  const severeCases: Array<[string, Omit<Parameters<typeof validatePrimaryPriceCandidate>[0], "validationContext">, boolean, string?]> = [
    ["rejects uncorroborated AZND exact-pool severe downside", { price: 0.38, source: "curve-thin-onchain", confidence: "fallback", agreeSources: ["curve-thin-onchain"] }, false, "severe_downside_requires_corroboration"],
    ["rejects uncorroborated AZND exact-pool temporal jump", { price: 0.7, source: "curve-thin-onchain", confidence: "fallback", agreeSources: ["curve-thin-onchain"], previousTrustedPrice: { price: 1, source: "pyth", confidence: "high", observedAt: null, agreeSources: ["pyth"] } }, false, "temporal_jump_requires_corroboration"],
    ["rejects severe downside with single source", { price: 0.38, source: "pyth", confidence: "low", agreeSources: ["pyth"] }, false, "severe_downside_requires_corroboration"],
    ["keeps VUSD dex-promoted subject to severe-downside corroboration", { price: 0.38, source: "dex-promoted", confidence: "single-source", agreeSources: ["dex-promoted"], candidatePrices: { "dex-promoted": 0.38 } }, false, "severe_downside_requires_corroboration"],
    ["accepts severe downside when 2+ candidate sources confirm", { price: 0.38, source: "pyth", confidence: "low", agreeSources: ["pyth"], candidatePrices: { coingecko: 0.39, pyth: 0.38, "defillama-list": 0.51 } }, true],
    ["rejects severe downside when only correlated list aggregators corroborate", { price: 0.38, source: "coingecko+defillama-list", confidence: "low", agreeSources: ["coingecko", "defillama-list"], candidatePrices: { coingecko: 0.39, "defillama-list": 0.38 } }, false, "severe_downside_requires_corroboration"],
    ["accepts corroborated severe downside despite large jump from previous trusted price", { price: 0.1525, source: "coingecko+defillama-list", confidence: "low", agreeSources: ["coingecko", "defillama-list"], candidatePrices: { coingecko: 0.1525, "defillama-list": 0.1524, pyth: 0.151, "dex-promoted": 1.0007 }, previousTrustedPrice: { price: 1.0007, source: "pyth", confidence: "high", observedAt: null, agreeSources: ["pyth"] } }, true],
    ["rejects severe downside when only 1 candidate source is severe", { price: 0.45, source: "pyth", confidence: "low", agreeSources: ["pyth"], candidatePrices: { coingecko: 0.92, pyth: 0.45 } }, false, "severe_downside_requires_corroboration"],
    ["allows exempt sources without candidatePrices", { price: 0.3, source: "pool-tvl-weighted", confidence: "low", agreeSources: ["pool-tvl-weighted"] }, true],
    ["allows high confidence with 2+ agree sources", { price: 0.35, source: "coingecko+pyth", confidence: "high", agreeSources: ["coingecko", "pyth"] }, true],
    ["rejects severe downside corroborated only by CoinGecko paths", { price: 0.38, source: "coingecko+coingecko-onchain-address", confidence: "high", agreeSources: ["coingecko", "coingecko-onchain-address"], candidatePrices: { coingecko: 0.38, "coingecko-onchain-address": 0.38 } }, false, "severe_downside_requires_corroboration"],
    ["allows when previous trusted price was also severe downside", { price: 0.38, source: "pyth", confidence: "low", agreeSources: ["pyth"], previousTrustedPrice: { price: 0.4, source: "coingecko", confidence: "low", observedAt: null, agreeSources: ["coingecko"] } }, true],
    ["does not trigger directional corroboration for non-severe prices", { price: 0.85, source: "pyth", confidence: "low", agreeSources: ["pyth"], candidatePrices: { coingecko: 0.3, pyth: 0.85 } }, true],
  ];

  it.each(severeCases)("%s", (label, input, accepted, reason) => {
    const id = label.includes("AZND") ? "aznd-mu-digital" : label.includes("VUSD") ? "vusd-virtue" : undefined;
    const decision = validatePrimaryPriceCandidate({ ...input, validationContext: id ? { ...USD_CONTEXT, stablecoinId: id } : USD_CONTEXT });
    expect(decision).not.toHaveProperty("confidenceCap");
    expect(decision).not.toHaveProperty("publicationReason");
    expect(decision.accepted).toBe(accepted);
    if (reason) expect(decision.reason).toBe(reason);
  });
});

describe("validatePublishedAssetPrice — candidatePrices as a separate argument", () => {
  it.each([true, false])("enforces severe-downside corroboration (with candidatePrices: %s)", (withCandidates) => {
    const decision = validatePublishedAssetPrice({
      asset: { price: 0.38, priceSource: "pyth", priceConfidence: "low", agreeSources: ["pyth"] },
      ...(withCandidates ? { candidatePrices: { coingecko: 0.39, pyth: 0.38, "defillama-list": 0.51 } } : {}),
      validationContext: USD_CONTEXT,
    });
    expect(decision.accepted).toBe(withCandidates);
    if (!withCandidates) expect(decision.reason).toBe("severe_downside_requires_corroboration");
  });
});

describe("DefiLlama exact-reference and fill defaults", () => {
  const FILL = 0.9990120985638516;
  const LIST_FILL = { value: FILL, upstreamSource: "defillama" };
  const CONTRACT_FILL = 0.99987355779;

  it.each([
    ["sole list exact-par", () => validatePrimaryPriceCandidate({ price: 1, source: "defillama-list", confidence: "single-source", agreeSources: ["defillama-list"], validationContext: USD_CONTEXT }), false, "exact_par_list_price_requires_corroboration"],
    ["retained list exact-par", () => validatePublishedAssetPrice({ asset: { price: 1, priceSource: "defillama", priceConfidence: "single-source", agreeSources: ["defillama"] }, validationContext: USD_CONTEXT }), false, "exact_par_list_price_requires_corroboration"],
    ["sole contract exact-par", () => validateFallbackPriceCandidate({ price: 1, source: "defillama-contract", confidence: "fallback", agreeSources: ["defillama-contract"], validationContext: USD_CONTEXT }), false, "exact_par_list_price_requires_corroboration"],
    ["corroborated exact-par", () => validatePrimaryPriceCandidate({ price: 1, source: "coingecko+defillama-list", confidence: "high", agreeSources: ["coingecko", "defillama-list"], validationContext: USD_CONTEXT }), true, undefined],
    ["non-reference list quote", () => validatePrimaryPriceCandidate({ price: 0.999, source: "defillama-list", confidence: "single-source", agreeSources: ["defillama-list"], validationContext: USD_CONTEXT }), true, undefined],
    ["sole list fill default", () => validatePrimaryPriceCandidate({ price: FILL, source: "defillama-list", confidence: "single-source", agreeSources: ["defillama-list"], listFillDefault: LIST_FILL, validationContext: USD_CONTEXT }), false, "list_fill_default_requires_corroboration"],
    ["retained list fill default", () => validatePublishedAssetPrice({ asset: { price: FILL, priceSource: "defillama", priceConfidence: "single-source", agreeSources: ["defillama"], priceListFillDefault: LIST_FILL }, validationContext: USD_CONTEXT }), false, "list_fill_default_requires_corroboration"],
    ["cg-attributed list fill", () => validatePublishedAssetPrice({ asset: { price: FILL, priceSource: "coingecko", priceConfidence: "single-source", agreeSources: ["coingecko"], priceListFillDefault: { value: FILL, upstreamSource: "coingecko" } }, validationContext: USD_CONTEXT }), false, "list_fill_default_requires_corroboration"],
    ["contract at list fill default", () => validateFallbackPriceCandidate({ price: FILL, source: "defillama-contract", confidence: "fallback", agreeSources: ["defillama-contract"], listFillDefault: LIST_FILL, validationContext: USD_CONTEXT }), false, "list_fill_default_requires_corroboration"],
    ["corroborated list fill", () => validatePublishedAssetPrice({ asset: { price: FILL, priceSource: "coingecko+defillama-list", priceConfidence: "high", agreeSources: ["coingecko", "defillama-list"], priceListFillDefault: LIST_FILL }, validationContext: USD_CONTEXT }), true, undefined],
    ["unflagged list price", () => validatePrimaryPriceCandidate({ price: FILL, source: "defillama-list", confidence: "single-source", agreeSources: ["defillama-list"], validationContext: USD_CONTEXT }), true, undefined],
    ["uncorroborated contract fill", () => validateFallbackPriceCandidate({ price: CONTRACT_FILL, source: "defillama-contract", confidence: "fallback", agreeSources: ["defillama-contract"], contractFillDefault: { value: CONTRACT_FILL }, validationContext: USD_CONTEXT }), false, "contract_fill_default_requires_corroboration"],
    ["corroborated contract fill", () => validateFallbackPriceCandidate({ price: CONTRACT_FILL, source: "defillama-contract", confidence: "fallback", agreeSources: ["defillama-contract", "coinmarketcap"], contractFillDefault: { value: CONTRACT_FILL }, validationContext: USD_CONTEXT }), true, undefined],
  ])("evaluates %s", (_label, run, accepted, reason) => {
    const decision = run();
    expect(decision.accepted).toBe(accepted);
    if (reason) expect(decision.reason).toBe(reason);
  });

  it("applies exact-reference checks to non-USD pegs and detects list/contract fill defaults", () => {
    const phpContext: PriceValidationContext = { stablecoinId: "test-php", pegCurrency: "PHP", pegType: "peggedPHP", pegClass: "fiat_fx", navToken: false, tracked: true };
    const references = { rates: { peggedPHP: 0.01755 }, type: "fresh" as const, updatedAt: 1_800_000_000 };
    expect(validatePrimaryPriceCandidate({ price: 0.01755, source: "defillama-list", confidence: "single-source", agreeSources: ["defillama-list"], validationContext: phpContext, validationReferences: references })).toMatchObject({ accepted: false, reason: "exact_par_list_price_requires_corroboration" });
    expect(validatePrimaryPriceCandidate({ price: 0.0175, source: "defillama-list", confidence: "single-source", agreeSources: ["defillama-list"], validationContext: phpContext, validationReferences: references }).accepted).toBe(true);
    const listRows = (n: number, price: number) => Array.from({ length: n }, (_, i) => ({ id: `list-${i}`, price }));
    expect(detectDefiLlamaListFillDefaultPrices(listRows(5, FILL))).toEqual(new Set([FILL]));
    expect(detectDefiLlamaListFillDefaultPrices(listRows(4, 0.999520515794015)).size).toBe(0);
    const contractRows = (ids: string[], tokenKey?: string) => ids.map((id) => ({ id, price: CONTRACT_FILL, lineageGroup: resolveContractFillLineageGroup(id), tokenKey }));
    expect(detectDefiLlamaContractFillDefaultPrices(contractRows(["nusd-nexus", "usdu-usdu-finance"]))).toEqual(new Set([CONTRACT_FILL]));
    expect(detectDefiLlamaContractFillDefaultPrices(contractRows(["rwausdi-multipli", "m-m0", "nusd-nexus", "usdu-usdu-finance"]))).toEqual(new Set([CONTRACT_FILL]));
    for (const related of [
      contractRows(["ausd-agora", "iusd-initia"]),
      contractRows(["m-m0", "wm-m0", "mantrausd-mantra"]),
      contractRows(["pyusd-paypal", "pyusdx-moonpay"]),
      contractRows(["gho-aave", "stkgho-umbrella-aave"]),
      contractRows(["nusd-nexus", "usdu-usdu-finance"], "ethereum:0xshared"),
    ]) {
      expect(detectDefiLlamaContractFillDefaultPrices(related).size).toBe(0);
    }
  });
});

describe("validatePrimaryPriceCandidate — weak fallback fixed-peg depegs", () => {
  it("accepts a legacy exact-pool display route without granting depeg authority", () => {
    const decision = validatePrimaryPriceCandidate({
      price: 0.01621, source: "uniswap-v3-exact", confidence: "fallback", agreeSources: ["uniswap-v3-exact"],
      validationContext: { stablecoinId: "test-php", pegCurrency: "PHP", pegType: "peggedPHP", pegClass: "fiat_fx", navToken: false, tracked: true },
      validationReferences: { rates: { peggedPHP: 0.01755 }, type: "fresh", updatedAt: Math.floor(Date.now() / 1000) },
    });
    expect(decision.accepted).toBe(true);
    expect(hasDepegAuthoritativeSource(["uniswap-v3-exact"])).toBe(false);
    expect(isReplaySafePriceSource("uniswap-v3-exact")).toBe(false);
  });

  const weakCases: Array<[string, "primary" | "fallback", Omit<Parameters<typeof validatePrimaryPriceCandidate>[0], "validationContext">, boolean, string?]> = [
    ["rejects depeg-sized address-provider quote", "primary", { price: 0.9459920248, source: "coingecko-onchain-address", confidence: "single-source", agreeSources: ["coingecko-onchain-address"] }, false, "weak_fallback_depeg_requires_corroboration"],
    ["accepts near-peg address-provider quote", "primary", { price: 0.99967, source: "coingecko-onchain-address", confidence: "single-source", agreeSources: ["coingecko-onchain-address"] }, true],
    ["allows exact DefiLlama contract fallback", "primary", { price: 0.9459920248, source: "defillama-contract", confidence: "single-source", agreeSources: ["defillama-contract"] }, true],
    ["allows depeg-sized hard-source quotes", "primary", { price: 0.9459920248, source: "pyth", confidence: "single-source", agreeSources: ["pyth"] }, true],
    ["accepts severe exact-address fallback corroborated by independent quote", "fallback", { price: 0.3904, source: "dexscreener-exact", confidence: "fallback", agreeSources: ["dexscreener-exact"], candidatePrices: { coingecko: 0.390247, "dexscreener-exact": 0.3904 } }, true],
    ["rejects severe fallback evidence from list aggregators only", "fallback", { price: 0.3904, source: "coinmarketcap", confidence: "fallback", agreeSources: ["coinmarketcap"], candidatePrices: { coingecko: 0.390247, "defillama-list": 0.3903, coinmarketcap: 0.3904 } }, false, "severe_downside_requires_corroboration"],
    ["does not use severe candidate evidence to admit non-severe fallback", "fallback", { price: 0.94, source: "dexscreener-exact", confidence: "fallback", agreeSources: ["dexscreener-exact"], candidatePrices: { coingecko: 0.390247, pyth: 0.3904, "dexscreener-exact": 0.94 } }, false, "weak_fallback_depeg_requires_corroboration"],
  ];

  it.each(weakCases)("%s", (_name, mode, input, accepted, reason) => {
    const decision = (mode === "primary" ? validatePrimaryPriceCandidate : validateFallbackPriceCandidate)({ ...input, validationContext: USD_CONTEXT });
    expect(decision.accepted).toBe(accepted);
    if (reason) expect(decision.reason).toBe(reason);
  });
});

describe("open confirmed depeg continuity", () => {
  const prev = (price: number) => ({ price, source: "pyth", confidence: "high" as const, observedAt: null, agreeSources: ["pyth"] });
  type ContinuityExtra = Pick<Parameters<typeof validatePrimaryPriceCandidate>[0], "previousTrustedPrice" | "upstreamKeysBySource">;
  const cases: Array<[string, "primary" | "fallback", number, string, "high" | "single-source" | "fallback", Record<string, number>, "above" | "below" | null | undefined, boolean, string, boolean, ContinuityExtra?]> = [
    ["pmUSD-like primary list aggregators publish low", "primary", 0.40765, "coingecko+defillama-list", "single-source", { coingecko: 0.4078, "defillama-list": 0.4075 }, "below", true, "open_confirmed_depeg_continuity", true],
    ["pmUSD-like fallback list aggregators publish low", "fallback", 0.408, "defillama-contract", "fallback", { coingecko: 0.4078, "defillama-contract": 0.408 }, "below", true, "open_confirmed_depeg_continuity", true],
    ["weak-fallback 5-50% dead zone (below) publishes low", "fallback", 0.75, "dexscreener-exact", "fallback", { "dexscreener-exact": 0.75, coingecko: 0.76 }, "below", true, "open_confirmed_depeg_continuity", true],
    ["weak-fallback 5-50% dead zone (above) publishes low", "fallback", 1.1, "dexscreener-exact", "fallback", { "dexscreener-exact": 1.1, coingecko: 1.105 }, "above", true, "open_confirmed_depeg_continuity", true],
    ["deepening temporal jump from par publishes low", "primary", 0.408, "coingecko+defillama-list", "single-source", { coingecko: 0.408, "defillama-list": 0.4075 }, "below", true, "open_confirmed_depeg_continuity", true, { previousTrustedPrice: prev(1) }],
    ["already-corroborated hard severe downside keeps normal acceptance", "primary", 0.408, "coingecko+curve-onchain", "high", { coingecko: 0.408, "curve-onchain": 0.4075 }, "below", true, "within_reference_band", false],
    ["no open event keeps severe downside withheld", "primary", 0.408, "coingecko+defillama-list", "single-source", { coingecko: 0.408, "defillama-list": 0.4075 }, null, false, "severe_downside_requires_corroboration", false],
    ["unavailable open event state keeps dead zone withheld", "fallback", 0.75, "dexscreener-exact", "fallback", { "dexscreener-exact": 0.75, coingecko: 0.76 }, undefined, false, "weak_fallback_depeg_requires_corroboration", false],
    ["single family CG+CG-onchain stays withheld", "fallback", 0.408, "coingecko-onchain-address", "fallback", { coingecko: 0.408, "coingecko-onchain-address": 0.4075 }, "below", false, "severe_downside_requires_corroboration", false],
    ["single family DL list+contract stays withheld", "fallback", 0.408, "defillama-contract", "fallback", { "defillama-list": 0.408, "defillama-contract": 0.4075 }, "below", false, "severe_downside_requires_corroboration", false],
    ["shared upstream identity stays withheld", "primary", 0.408, "coingecko+defillama-list", "single-source", { coingecko: 0.408, "defillama-list": 0.4075 }, "below", false, "severe_downside_requires_corroboration", false, { upstreamKeysBySource: { coingecko: ["pool:shared"], "defillama-list": ["pool:shared"] } }],
    ["inter-family spread > 500 bps stays withheld", "primary", 0.4, "coingecko", "single-source", { coingecko: 0.4, "defillama-list": 0.43 }, "below", false, "severe_downside_requires_corroboration", false],
    ["direction mismatch stays withheld", "fallback", 1.1, "dexscreener-exact", "fallback", { "dexscreener-exact": 1.1, coingecko: 1.105 }, "below", false, "weak_fallback_depeg_requires_corroboration", false],
    ["recovery temporal jump toward peg stays withheld", "primary", 0.9, "coingecko+defillama-list", "single-source", { coingecko: 0.9, "defillama-list": 0.901 }, "below", false, "temporal_jump_requires_corroboration", false, { previousTrustedPrice: prev(0.4) }],
    ["recovery jump to par on open above stays withheld", "primary", 1, "coingecko+defillama-list", "single-source", { coingecko: 1, "defillama-list": 1 }, "above", false, "temporal_jump_requires_corroboration", false, { previousTrustedPrice: prev(1.3) }],
  ];

  it.each(cases)("%s", (_name, mode, price, source, confidence, candidatePrices, openDir, accepted, reason, lowCap, extra) => {
    const decision = (mode === "primary" ? validatePrimaryPriceCandidate : validateFallbackPriceCandidate)({
      price, source, confidence, agreeSources: source.split("+"), candidatePrices,
      openConfirmedDepeg: openDir ? { direction: openDir } : openDir,
      validationContext: USD_CONTEXT, ...extra,
    });
    expect(decision).toEqual({
      accepted, reason,
      ...(lowCap ? { confidenceCap: "low", publicationReason: "open-confirmed-depeg-continuity" } : {}),
    });
  });
});
