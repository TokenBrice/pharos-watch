import { describe, expect, it } from "vitest";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import type { PriceCacheEntry } from "../../../lib/db-cache";
import { classifyPrimaryDepegTrust } from "../../../lib/depeg-trust-policy";
import { protocolParProvider } from "../../../lib/authoritative-price-sources/protocol-par";
import type { PriceValidationReferences } from "../../../lib/price-validation";
import {
  applyProtocolPriceOverrides,
  buildPreviousTrustedPriceLookup,
  createValidationContextResolver,
  getPostEnrichmentCandidatePricesForCurrentAsset,
  getPrimaryCandidatePricesForCurrentAsset,
  settleNominalPriceReferences,
  type ProtocolPriceOverride,
  type PreviousTrustedPrice,
} from "../pricing";
import type { PeggedAsset, PrimaryPriceResult } from "../enrich-prices";
import { normalizeStablecoinsPayload } from "../shared";
import { makePeggedAsset, makePrimaryPriceResultFixture } from "./_fixtures";

function makePrimaryPriceResult(overrides: Partial<PrimaryPriceResult> = {}): PrimaryPriceResult {
  return makePrimaryPriceResultFixture({
    confidence: "high",
    cgPrice: null,
    candidateSources: ["coingecko", "defillama-list"],
    agreeSources: ["coingecko", "defillama-list"],
    allPrices: { coingecko: 1.0, "defillama-list": 1.0005 },
    ...overrides,
  });
}

describe("getPrimaryCandidatePricesForCurrentAsset", () => {
  function makeAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
    return makePeggedAsset({
      price: 1.0,
      priceSource: "coingecko",
      priceConfidence: "high",
      ...overrides,
    });
  }

  it("returns undefined when the primary result is for a different asset id", () => {
    const asset = makeAsset({ id: "usdt-tether" });
    const results = new Map([["usdc-circle", makePrimaryPriceResult()]]);

    expect(getPrimaryCandidatePricesForCurrentAsset(asset, results)).toBeUndefined();
  });

  it("returns undefined when the current source differs from the primary result source", () => {
    const asset = makeAsset({ priceSource: "pyth" });
    const results = new Map([
      ["usdt-tether", makePrimaryPriceResult({ source: "coingecko" })],
    ]);

    expect(getPrimaryCandidatePricesForCurrentAsset(asset, results)).toBeUndefined();
  });

  it("returns undefined when the current confidence differs from the primary result confidence", () => {
    const asset = makeAsset({ priceConfidence: "single-source" });
    const results = new Map([
      ["usdt-tether", makePrimaryPriceResult({ confidence: "high" })],
    ]);

    expect(getPrimaryCandidatePricesForCurrentAsset(asset, results)).toBeUndefined();
  });

  it("returns allPrices when the current price matches the primary result within 1e-9 tolerance", () => {
    const allPrices = { coingecko: 1.001, "defillama-list": 1.0005, pyth: 0.9997 };
    // 1e-10 delta is within the 1.001 * 1e-9 ~= 1e-9 tolerance.
    const asset = makeAsset({ price: 1.001 + 1e-10 });
    const results = new Map([
      [
        "usdt-tether",
        makePrimaryPriceResult({ price: 1.001, allPrices }),
      ],
    ]);

    expect(getPrimaryCandidatePricesForCurrentAsset(asset, results)).toBe(allPrices);
  });

  it("returns undefined when the current price drifts outside the 1e-9 tolerance", () => {
    const asset = makeAsset({ price: 1.001 + 1e-5 });
    const results = new Map([
      [
        "usdt-tether",
        makePrimaryPriceResult({ price: 1.001 }),
      ],
    ]);

    expect(getPrimaryCandidatePricesForCurrentAsset(asset, results)).toBeUndefined();
  });
});

describe("getPostEnrichmentCandidatePricesForCurrentAsset", () => {
  function makeAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
    return makePeggedAsset({
      price: 1.0,
      priceSource: "coingecko",
      priceConfidence: "high",
      ...overrides,
    });
  }

  it.each([
    {
      name: "merges a same-run primary quote with the current fallback quote",
      price: 0.390247, source: "coingecko", confidence: "single-source",
    },
    {
      name: "adds the current fallback even when primary metadata already matches it",
      price: 0.3904, source: "dexscreener-exact", confidence: "fallback",
    },
  ] as const)("$name", ({ price, source, confidence }) => {
    const asset = makeAsset({
      id: "usx-dforce",
      price: 0.3904,
      priceSource: "dexscreener-exact",
      priceConfidence: "fallback",
    });
    const results = new Map([
      [
        "usx-dforce",
        makePrimaryPriceResult({
          price, source, confidence,
          allPrices: { coingecko: 0.390247 },
        }),
      ],
    ]);

    expect(getPostEnrichmentCandidatePricesForCurrentAsset(asset, results)).toEqual({
      coingecko: 0.390247,
      "dexscreener-exact": 0.3904,
    });
  });

  it("does not merge same-run evidence into a non-fallback replacement", () => {
    const asset = makeAsset({
      price: 0.3904,
      priceSource: "protocol-redeem",
      priceConfidence: "single-source",
    });

    expect(
      getPostEnrichmentCandidatePricesForCurrentAsset(
        asset,
        new Map([[asset.id, makePrimaryPriceResult({ allPrices: { coingecko: 0.390247 } })]]),
      ),
    ).toBeUndefined();
  });
});

describe("buildPreviousTrustedPriceLookup", () => {
  const NOW_SEC = 1_700_000_000;

  function makeAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
    return makePeggedAsset({
      price: 1.0,
      priceSource: "pyth",
      priceConfidence: "single-source",
      priceObservedAt: NOW_SEC - 60,
      priceObservedAtMode: "upstream",
      priceUpdatedAt: NOW_SEC - 60,
      agreeSources: ["pyth"],
      ...overrides,
    });
  }

  function makeCacheEntry(overrides: Partial<PriceCacheEntry> = {}): PriceCacheEntry {
    return {
      price: 1.0,
      updatedAt: NOW_SEC - 60,
      source: "pyth",
      confidence: "single-source",
      observedAt: NOW_SEC - 60,
      observedAtMode: "upstream",
      syncedAt: NOW_SEC - 60,
      agreeSources: ["pyth"],
      ...overrides,
    };
  }

  it("rejects a newer low-confidence replay in favor of trusted publication", () => {
    const lookup = buildPreviousTrustedPriceLookup(
      new Map([["coin", makeAsset({ price: 1.001 })]]), NOW_SEC,
      new Map([["coin", makeCacheEntry({ price: 0.9, confidence: "low", observedAt: NOW_SEC - 1 })]]),
    );
    expect(lookup.get("coin")).toMatchObject({ price: 1.001, observedAt: NOW_SEC - 60 });
  });

  it("rejects non-positive and nonfinite replay prices", () => {
    const replay = new Map([0, -1, NaN, Infinity].map((price, index) => [
      `invalid-${index}`, makeCacheEntry({ price }),
    ]));
    expect([...buildPreviousTrustedPriceLookup(new Map(), NOW_SEC, replay)]).toEqual([]);
  });

  it("omits an asset when neither publication nor replay is trusted", () => {
    expect([...buildPreviousTrustedPriceLookup(
      new Map([["coin", makeAsset({ priceConfidence: "low" })]]), NOW_SEC,
      new Map([["coin", makeCacheEntry({ confidence: "low" })]]),
    )]).toEqual([]);
  });

  it("uses replay update time when its observation timestamp is missing", () => {
    const lookup = buildPreviousTrustedPriceLookup(
      new Map([["coin", makeAsset()]]), NOW_SEC,
      new Map([["coin", makeCacheEntry({ price: 0.998, observedAt: null, updatedAt: NOW_SEC - 10 })]]),
    );
    expect(lookup.get("coin")).toMatchObject({ price: 0.998, observedAt: NOW_SEC - 10 });
  });

  it("returns previous-cache row when replay cache has no matching entry", () => {
    const previous = new Map<string, PeggedAsset>([["usdt-tether", makeAsset({ price: 1.0 })]]);
    const replay = new Map<string, PriceCacheEntry>();

    const lookup = buildPreviousTrustedPriceLookup(previous, NOW_SEC, replay);

    const entry = lookup.get("usdt-tether");
    expect(entry).toBeDefined();
    expect(entry?.price).toBe(1.0);
    expect(entry?.source).toBe("pyth");
  });

  it("returns replay-cache row when previous-cache has no matching entry", () => {
    const previous = new Map<string, PeggedAsset>();
    const replay = new Map<string, PriceCacheEntry>([
      ["usdt-tether", makeCacheEntry({ price: 0.998 })],
    ]);

    const lookup = buildPreviousTrustedPriceLookup(previous, NOW_SEC, replay);

    const entry = lookup.get("usdt-tether");
    expect(entry).toBeDefined();
    expect(entry?.price).toBe(0.998);
    expect(entry?.source).toBe("pyth");
  });

  it.each([
    {
      name: "prefers replay-cache row when its observedAt is later than previous-cache",
      publication: { price: 1.0, priceObservedAt: NOW_SEC - 300, priceUpdatedAt: NOW_SEC - 300 },
      replay: { price: 0.9987, observedAt: NOW_SEC - 30, updatedAt: NOW_SEC - 30 },
      assertEntry: (entry: PreviousTrustedPrice | undefined) => {
        expect(entry?.price).toBe(0.9987);
        expect(entry?.observedAt).toBe(NOW_SEC - 30);
      },
    },
    {
      name: "keeps previous-cache row when its observedAt is later than replay-cache",
      publication: { price: 1.0003, priceObservedAt: NOW_SEC - 30, priceUpdatedAt: NOW_SEC - 30 },
      replay: { price: 0.9987, observedAt: NOW_SEC - 300, updatedAt: NOW_SEC - 300 },
      assertEntry: (entry: PreviousTrustedPrice | undefined) => {
        expect(entry?.price).toBe(1.0003);
        expect(entry?.observedAt).toBe(NOW_SEC - 30);
      },
    },
    {
      name: "uses replay-cache row regardless of observedAt when previous-cache is non-authoritative (low confidence)",
      publication: { price: 1.02, priceConfidence: "low", priceObservedAt: NOW_SEC - 30, priceUpdatedAt: NOW_SEC - 30 },
      replay: { price: 0.9987, observedAt: NOW_SEC - 300, updatedAt: NOW_SEC - 300 },
      assertEntry: (entry: PreviousTrustedPrice | undefined) => {
        // Previous is filtered out (non-authoritative); replay wins despite older observedAt.
        expect(entry?.price).toBe(0.9987);
        expect(entry?.source).toBe("pyth");
      },
    },
    {
      name: "keeps previous-cache row when both have equal observedAt (first-writer wins; previousAssetsById is iterated before replay)",
      // previousAssetsById is iterated first, then replayPriceCache. On ties, the
      // existing-lookup strict-gte short-circuit prevents replay from overwriting.
      publication: { price: 1.0, priceObservedAt: NOW_SEC - 60, priceUpdatedAt: NOW_SEC - 60 },
      replay: { price: 0.997, observedAt: NOW_SEC - 60, updatedAt: NOW_SEC - 60 },
      assertEntry: (entry: PreviousTrustedPrice | undefined) => {
        // previousAssetsById is inserted first; equal observedAt means replay does NOT overwrite.
        expect(entry?.price).toBe(1.0);
      },
    },
  ] as const)("$name", ({ publication, replay, assertEntry }) => {
    const previous = new Map<string, PeggedAsset>([["usdt-tether", makeAsset(publication)]]);
    const replayCache = new Map<string, PriceCacheEntry>([["usdt-tether", makeCacheEntry(replay)]]);

    const lookup = buildPreviousTrustedPriceLookup(previous, NOW_SEC, replayCache);

    assertEntry(lookup.get("usdt-tether"));
  });
});

describe("nominal par precedence (DEC-02 / CR-43)", () => {
  const NOW = 1_800_000_000;
  const REFERENCES: PriceValidationReferences = {
    rates: { peggedZAR: 0.0608, peggedXOF: 0.00172 },
    type: "fresh",
    updatedAt: NOW - 60,
    updatedAtByPeg: { peggedZAR: NOW - 120, peggedXOF: NOW - 120 },
    typeByPeg: { peggedZAR: "fresh", peggedXOF: "fresh" },
  };
  const NOMINAL_ROUTES = [
    ["usbd-bima", "peggedUSD", 1],
    ["usdq-quill", "peggedUSD", 1],
    ["usdk-kast", "peggedUSD", 1],
    ["usdn-noble", "peggedUSD", 1],
    ["zarm-mento", "peggedZAR", 0.0608],
    ["xofm-mento", "peggedXOF", 0.00172],
  ] as const;

  type MarketState = Partial<PeggedAsset>;

  function market(par: number, overrides: MarketState): MarketState {
    return {
      price: par * 0.97,
      priceSource: "binance+kraken",
      priceConfidence: "high",
      agreeSources: ["binance", "kraken"],
      consensusSources: ["binance", "kraken"],
      priceObservedAt: NOW - 30,
      priceObservedAtMode: "upstream",
      priceUpdatedAt: NOW - 30,
      ...overrides,
    };
  }

  const UNTRUSTED_MARKETS: Array<[string, (par: number) => MarketState]> = [
    ["thin single-source CoinGecko mark", (par) => market(par, {
      price: par * 0.9, priceSource: "coingecko", priceConfidence: "single-source",
      agreeSources: ["coingecko"], consensusSources: ["coingecko"],
    })],
    ["fresh high-confidence CoinGecko + DefiLlama soft-aggregator agreement", (par) => market(par, {
      price: par * 0.9, priceSource: "coingecko+defillama-list", priceConfidence: "high",
      agreeSources: ["coingecko", "defillama-list"], consensusSources: ["coingecko", "defillama-list"],
    })],
    ["stale multi-source quote", (par) => market(par, { priceObservedAt: NOW - 86_400, priceUpdatedAt: NOW - 86_400 })],
    ["cached fallback quote", (par) => market(par, { priceSource: "cached", priceConfidence: "fallback" })],
    ["legacy protocol-redeem par row", (par) => market(par, {
      price: par, priceSource: "protocol-redeem", agreeSources: ["protocol-redeem"], consensusSources: ["protocol-redeem"],
      priceObservedAtMode: "local_fetch",
    })],
  ];

  function makeAsset(id: string, pegType: string, state: MarketState = {}): PeggedAsset {
    return { id, name: id, symbol: id.toUpperCase(), pegType, circulating: { [pegType]: 1_000_000 }, ...state };
  }

  async function parOverride(asset: PeggedAsset, references: PriceValidationReferences | undefined) {
    const result = await protocolParProvider.fetchLivePrice!(asset, { assetsById: new Map(), validationReferences: references });
    return result && !("kind" in result) ? result : null;
  }

  async function runPrecedence(asset: PeggedAsset, references: PriceValidationReferences | undefined = REFERENCES) {
    const override = await parOverride(asset, references);
    const overrides = new Map<string, ProtocolPriceOverride>(override ? [[asset.id, override]] : []);
    applyProtocolPriceOverrides({
      assets: [asset],
      overrides,
      validationContexts: createValidationContextResolver(),
      validationReferences: references,
      syncStartSec: NOW,
    });
    settleNominalPriceReferences([asset], NOW);
    return normalizeStablecoinsPayload({ peggedAssets: [asset] } as never).peggedAssets[0] as PeggedAsset;
  }

  /** USD par has no FX leg; non-USD par records the fresh FX reference's own per-peg clock. */
  function expectedReference(pegType: string, par: number) {
    return {
      price: par,
      source: "protocol-par",
      mode: "nominal_reference",
      ...(pegType === "peggedUSD" ? {} : { fxReferenceType: "fresh", fxObservedAt: NOW - 120 }),
    };
  }

  function expectPublishedNominal(published: PeggedAsset, pegType: string, par: number) {
    expect(published).toMatchObject({
      price: par,
      priceSource: "protocol-par",
      priceConfidence: null,
      priceObservedAt: null,
      priceObservedAtMode: "nominal_reference",
      priceUpdatedAt: null,
      priceSyncedAt: NOW,
      agreeSources: [],
      consensusSources: [],
    });
    expect(published.nominalPriceReference).toEqual(expectedReference(pegType, par));
    expect(isObservedPrice(published)).toBe(false);
    expect(classifyPrimaryDepegTrust(published, NOW)).toBe("unusable");
  }

  it.each(NOMINAL_ROUTES)("%s without a market quote publishes par only as an explicit nominal reference", async (id, pegType, par) => {
    expectPublishedNominal(await runPrecedence(makeAsset(id, pegType)), pegType, par);
  });

  it.each(NOMINAL_ROUTES)("%s keeps a fresh trusted market discount and carries par separately", async (id, pegType, par) => {
    const published = await runPrecedence(makeAsset(id, pegType, market(par, {})));

    expect(published).toMatchObject({
      price: par * 0.97,
      priceSource: "binance+kraken",
      priceConfidence: "high",
      priceObservedAt: NOW - 30,
      priceObservedAtMode: "upstream",
    });
    expect(published.nominalPriceReference).toEqual(expectedReference(pegType, par));
    expect(isObservedPrice(published)).toBe(true);
    expect(classifyPrimaryDepegTrust(published, NOW)).toBe("authoritative");
  });

  describe.each(UNTRUSTED_MARKETS)("%s", (_label, buildMarket) => {
    it.each(NOMINAL_ROUTES)("does not displace par for %s", async (id, pegType, par) => {
      expectPublishedNominal(await runPrecedence(makeAsset(id, pegType, buildMarket(par))), pegType, par);
    });
  });

  it.each([
    ["sofid-sofi", "peggedUSD", 1],
  ] as const)("retires %s nominal publication without weakening observed-source trust", async (id, pegType, par) => {
    expect(protocolParProvider.matches(id)).toBe(false);
    const quote = market(par, {
      priceSource: "coingecko+kraken", priceConfidence: "high",
      agreeSources: ["coingecko", "kraken"], consensusSources: ["coingecko", "kraken"],
      priceObservedAtMode: "local_fetch",
    });
    const published = await runPrecedence(makeAsset(id, pegType, quote));
    expect(published.price).toBe(quote.price);
    expect(published.priceSource).toBe("coingecko+kraken");
    expect(published.priceObservedAt).toBe(NOW - 30);
    expect(published.nominalPriceReference).toBeUndefined();
    expect(isObservedPrice(published)).toBe(true);
    expect(classifyPrimaryDepegTrust(published, NOW)).toBe("confirm_required");

    const carried = await runPrecedence(makeAsset(id, pegType, {
      price: par, priceSource: "protocol-par", priceObservedAtMode: "nominal_reference",
      nominalPriceReference: { price: par, source: "protocol-par", mode: "nominal_reference" },
    }));
    expect(carried.price).toBeNull();
    expect(carried.nominalPriceReference).toBeUndefined();
    const absent = await runPrecedence(makeAsset(id, pegType));
    expect(absent.price).toBeNull();
    expect(absent.nominalPriceReference).toBeUndefined();
  });

  it("publishes no nominal reference when non-USD par has no usable FX reference, and drops a carried one", async () => {
    const carried = makeAsset("zarm-mento", "peggedZAR", {
      price: 0.0608,
      priceSource: "protocol-par",
      priceObservedAtMode: "nominal_reference",
      priceSyncedAt: NOW - 600,
      nominalPriceReference: { price: 0.0608, source: "protocol-par", mode: "nominal_reference" },
    });
    // Explicit references object: passing `undefined` would fall back to the fresh default references.
    const published = await runPrecedence(carried, { rates: {}, type: "none", updatedAt: null });

    expect(published.price).toBeNull();
    expect(published.priceObservedAtMode).toBeNull();
    expect(published.nominalPriceReference).toBeUndefined();
  });

  it("republishes par when the admitted market quote is later rejected and backfilled by a fallback", async () => {
    const asset = makeAsset("usbd-bima", "peggedUSD", market(1, {}));
    const override = await parOverride(asset, REFERENCES);
    applyProtocolPriceOverrides({
      assets: [asset],
      overrides: new Map([[asset.id, override!]]),
      validationContexts: createValidationContextResolver(),
      syncStartSec: NOW,
    });
    expect(asset.priceSource).toBe("binance+kraken");

    Object.assign(asset, { price: 0.8, priceSource: "cached", priceConfidence: "fallback", agreeSources: ["coingecko"] });
    settleNominalPriceReferences([asset], NOW);

    expectPublishedNominal(asset, "peggedUSD", 1);
  });
});
