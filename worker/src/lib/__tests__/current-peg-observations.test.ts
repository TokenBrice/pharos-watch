import { getReferenceSessionState } from "@shared/lib/reference-market-hours";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { createCurrentPegReader, deriveCurrentPegObservationMap } from "../current-peg-observations";

const AS_OF = 1_700_000_000;

describe("current peg observations", () => {
  it.each([
    ["xaut-tether", "peggedUSD", 5_000], ["usdc-circle", "peggedJPY", 150],
  ])("withholds a registry/snapshot peg-unit mismatch (%s)", (id, pegType, price) => {
    const observation = deriveCurrentPegObservationMap({
      peggedAssets: [makeAsset({ id, pegType, price })], asOf: AS_OF,
    }).get(id);
    expect(observation).toMatchObject({
      currentDeviationBps: null, currentSignal: null, pegReference: null, pegReferenceUnavailable: true,
    });
  });

  it("withholds XAGm deviation when the quoted price has no dated entitlement", () => {
    const id = "xagm-matrixdock";
    const asOf = Date.parse("2026-10-01T12:00:00Z") / 1_000;
    const price = 30 * 0.998380822;
    const asset = makeAsset({ id, pegType: "peggedSILVER", price });
    const options = { peggedAssets: [asset], asOf, fxFallbackRates: { peggedSILVER: 30 } };
    const observation = deriveCurrentPegObservationMap(options).get(id)!;
    expect(createCurrentPegReader(options)({ ...asset, currentPeg: {
      ...observation, currentDeviationBps: 384, pegReferenceUnavailable: false,
    } })).toMatchObject({ currentDeviationBps: null, pegReference: null, pegReferenceUnavailable: true });
    expect(observation).toMatchObject({
      currentDeviationBps: null, currentSignal: null, pegReference: null, pegReferenceUnavailable: true,
    });
  });

  it.each([
    ["usdc-circle", "peggedUSD", "coingecko", undefined, 100],
    ["xagm-matrixdock", "peggedSILVER", "coingecko", undefined, null],
    ["susd-solayer", "peggedUSD", "protocol-redeem", undefined, null],
    ["susd-solayer", "peggedUSD", "protocol-redeem", "accrued-token", null],
    ["xofm-mento", "peggedXOF", "mento-broker", undefined, null],
  ] as const)("revalidates the unit of a stored %s peg block (%s, %s, %s)", (id, pegType, priceSource, parityQuoteUnit, expected) => {
    const asset = makeAsset({ id, pegType, priceSource, parityQuoteUnit, price: 1.01, currentPeg: {
      currentDeviationBps: 100, pegReference: { valueUsd: 1, source: "median", contributorCount: 3, asOf: AS_OF },
      pegReferenceUnavailable: false, currentPriceUnavailable: false, primaryTrust: "authoritative", dexPriceCheck: null,
    } });
    const readPeg = createCurrentPegReader({ peggedAssets: [asset], asOf: AS_OF });
    expect(readPeg(asset)).toMatchObject({
      currentDeviationBps: expected, pegReference: expected == null ? null : { valueUsd: 1 },
      pegReferenceUnavailable: expected == null,
    });
  });

  it("uses the pinned XAGm weight for the current silver reference", () => {
    const id = "xagm-matrixdock";
    const now = Date.parse("2026-10-01T12:00:00Z") / 1000;
    const usdPerUnit = 30;
    const ozPerToken = 0.998380822;
    const asset = makeAsset({ id, pegType: "peggedSILVER", price: usdPerUnit * ozPerToken, priceObservedAt: now,
      commodityEntitlement: { source: "matrixdock-frs", generation: "ethereum:123", ozPerToken, observedAtSec: now - 60, quoteObservedAtSec: now } });
    const observation = deriveCurrentPegObservationMap({
      peggedAssets: [asset], asOf: now, fxFallbackRates: { peggedSILVER: usdPerUnit },
      fxReferenceObservations: { peggedSILVER: { pegKey: "peggedSILVER", usdPerUnit, source: "gold-api.com",
        observedAtSec: now - 30, cadence: "intraday", repricing: {
          source: "gold-api.com", sessionOpenedAtSec: getReferenceSessionState("metal", now).sessionOpenedAtSec, preCloseUsdPerUnit: 29,
        } } },
    }).get(id);
    expect(observation).toMatchObject({ currentDeviationBps: 0, admittedDeviationBps: 0,
      referenceAdmission: { reason: "live-reference", quoteObservedAtSec: now, referenceObservedAtSec: now - 30 },
      pegReference: { valueUsd: asset.price, usdPerTroyOunce: 30, asOf: now - 30 } });
  });

  it("publishes the in-run gold median when the cohort has moved since the last spot quote", () => {
    const now = Date.UTC(2026, 10, 18, 15) / 1000;
    const price = 4165.6;
    const peggedAssets = ["xaut-tether", "paxg-paxos", "xaum-matrixdock"].map((id) =>
      makeAsset({ id, pegType: "peggedGOLD", price, priceSource: "coingecko", priceObservedAt: now }));
    const spot = { pegKey: "peggedGOLD", usdPerUnit: 4100, cadence: "intraday",
      source: "gold-api.com", observedAtSec: now - 35 * 60 };
    for (const fxReferenceObservations of [undefined, { peggedGOLD: spot }]) {
      const result = deriveCurrentPegObservationMap({ peggedAssets, fxReferenceObservations,
        fxFallbackRates: { peggedGOLD: spot.usdPerUnit }, asOf: now });
      expect(result.get("paxg-paxos")).toMatchObject({ currentDeviationBps: 0,
        pegReference: { source: "median", valueUsd: price, contributorCount: 3 } });
    }
  });

  it.each([
    ["DEX", 1.1, 0],
    ["primary", 1.15, -435],
  ] as const)("uses the %s quote's own clock across the FX reopen", (before, price, deviation) => {
    const reopen = Date.parse("2026-11-15T22:00:00Z") / 1000;
    const now = reopen + 300;
    const dexBefore = before === "DEX";
    const asset = makeAsset({ id: "eurc-circle", pegType: "peggedEUR", price, priceObservedAt: dexBefore ? now : reopen - 1 });
    const spot = { pegKey: "peggedEUR", source: "openExchangeRates", cadence: "intraday", observedAtSec: now - 10,
      usdPerUnit: 1.1, repricing: { sessionOpenedAtSec: reopen, preCloseUsdPerUnit: 1.09 } };
    const row = deriveCurrentPegObservationMap({
      peggedAssets: [asset], asOf: now, fxReferenceObservations: { peggedEUR: spot },
      dexPrices: new Map([[asset.id, { observedAtSec: dexBefore ? reopen - 1 : now, expiresAt: now + 60,
        source_pool_count: 4, source_total_tvl: 1e7, dex_price_usd: 1.1, deviation_from_primary_bps: deviation }]]),
    }).get(asset.id);
    const admitted = { status: "admitted", quoteObservedAtSec: now };
    expect(row).toMatchObject(dexBefore
      ? { admittedDeviationBps: 0, referenceAdmission: admitted, dexPriceCheck: null }
      : { currentDeviationBps: null, referenceAdmission: { reason: "quote-before-reopen" },
          dexPriceCheck: { dexDeviationBps: 0, agrees: false, referenceAdmission: admitted } });
  });

  it("keeps the DEX-to-NAV comparison for USD NAV assets in a clocked publication", () => {
    const id = "susde-ethena";
    const asset = makeAsset({ id, price: 1.12, priceObservedAt: AS_OF });
    const dex = { observedAtSec: AS_OF, expiresAt: AS_OF + 60, dex_price_usd: 1.074,
      source_pool_count: 2, source_total_tvl: 1e7, deviation_from_primary_bps: -411 };
    for (const fxReferenceObservations of [undefined, {}]) {
      const row = deriveCurrentPegObservationMap({ peggedAssets: [asset], asOf: AS_OF, fxReferenceObservations,
        dexPrices: new Map([[id, dex]]),
      }).get(id);
      expect(row?.dexPriceCheck?.dexDeviationBps).toBe(-411);
    }
  });

  it("withholds the peg projection for a locally fetched Kraken midpoint", () => {
    const now = Date.parse("2026-11-17T17:00:00Z") / 1000;
    const asset = makeAsset({ id: "eurc-circle", pegType: "peggedEUR", price: 1.1, priceSource: "kraken", priceObservedAt: now, priceObservedAtMode: "local_fetch" });
    const result = deriveCurrentPegObservationMap({ peggedAssets: [asset], asOf: now,
      fxReferenceObservations: { peggedEUR: { pegKey: "peggedEUR", source: "openExchangeRates", cadence: "intraday",
        observedAtSec: now, usdPerUnit: 1.1 } },
    }).get(asset.id);
    expect(result).toMatchObject({ admittedDeviationBps: null, referenceAdmission: { reason: "quote-clock-unavailable" } });
  });

  it("requires a comparable Solayer market quote", () => {
    const makeSolayer = (priceSource: string, parityQuoteUnit?: "accrued-token" | "raw-token") =>
      makeAsset({ id: "susd-solayer", pegType: "peggedUSD", price: 1, priceObservedAt: AS_OF, priceSource, parityQuoteUnit });
    const legacy = makeSolayer("protocol-redeem");
    const dexPrices = new Map([[legacy.id, { expiresAt: AS_OF + 60, dex_price_usd: 0.99,
      source_pool_count: 2, source_total_tvl: 1e7, deviation_from_primary_bps: -100 }]]);
    for (const fxReferenceObservations of [undefined, {}]) {
      expect(deriveCurrentPegObservationMap({ peggedAssets: [legacy], asOf: AS_OF, fxReferenceObservations, dexPrices }).get(legacy.id))
        .toMatchObject({ currentDeviationBps: null, dexPriceCheck: null });
    }
    for (const asset of [makeSolayer("protocol-redeem", "accrued-token"), makeSolayer("coinbase", "raw-token")]) {
      expect(deriveCurrentPegObservationMap({ peggedAssets: [asset], asOf: AS_OF, fxReferenceObservations: {} }).get(asset.id))
        .toMatchObject({ currentDeviationBps: null, admittedDeviationBps: null, currentPriceUnavailable: false });
    }
    const market = makeSolayer("coinbase", "accrued-token");
    expect(deriveCurrentPegObservationMap({ peggedAssets: [market], asOf: AS_OF, fxReferenceObservations: {}, dexPrices }).get(market.id))
      .toMatchObject({ currentDeviationBps: 0, admittedDeviationBps: 0, dexPriceCheck: null });
  });
});
