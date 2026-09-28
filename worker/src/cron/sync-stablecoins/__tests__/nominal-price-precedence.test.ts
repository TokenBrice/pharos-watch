import { describe, expect, it } from "vitest";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { classifyPrimaryDepegTrust } from "../../../lib/depeg-trust-policy";
import { protocolParProvider } from "../../../lib/authoritative-price-sources/protocol-par";
import type { PriceValidationReferences } from "../../../lib/price-validation";
import {
  applyProtocolPriceOverrides,
  createValidationContextResolver,
  settleNominalPriceReferences,
  type ProtocolPriceOverride,
} from "../pricing";
import { normalizeStablecoinsPayload } from "../shared";
import type { PeggedAsset } from "../enrich-prices";

const NOW = 1_800_000_000;
const REFERENCES: PriceValidationReferences = {
  rates: { peggedCHF: 1.27, peggedCAD: 0.73, peggedJPY: 0.00628, peggedZAR: 0.0608, peggedXOF: 0.00172 },
  type: "fresh",
  updatedAt: NOW - 60,
  updatedAtByPeg: { peggedCHF: NOW - 120, peggedCAD: NOW - 120, peggedJPY: NOW - 120, peggedZAR: NOW - 120, peggedXOF: NOW - 120 },
  typeByPeg: { peggedCHF: "fresh", peggedCAD: "fresh", peggedJPY: "fresh", peggedZAR: "fresh", peggedXOF: "fresh" },
};
const NOMINAL_ROUTES = [
  ["sofid-sofi", "peggedUSD", 1],
  ["usbd-bima", "peggedUSD", 1],
  ["usdq-quill", "peggedUSD", 1],
  ["chfau-allunity", "peggedCHF", 1.27],
  ["cadd-cad-digital", "peggedCAD", 0.73],
  ["jpym-mento", "peggedJPY", 0.00628],
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

describe("nominal par precedence (DEC-02 / CR-43)", () => {
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

  it("publishes no nominal reference when non-USD par has no usable FX reference, and drops a carried one", async () => {
    const carried = makeAsset("chfau-allunity", "peggedCHF", {
      price: 1.27,
      priceSource: "protocol-par",
      priceObservedAtMode: "nominal_reference",
      priceSyncedAt: NOW - 600,
      nominalPriceReference: { price: 1.27, source: "protocol-par", mode: "nominal_reference" },
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
