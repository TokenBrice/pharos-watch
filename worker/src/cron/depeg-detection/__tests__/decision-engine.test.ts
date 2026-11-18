import { describe, expect, it, vi } from "vitest";
import type { PegAssetBase } from "@shared/types/price";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { REFERENCE_CLOSURE_HOLD_BANDS_BPS } from "@shared/lib/depeg-config";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "@shared/lib/depeg-closure";
import { makeDepegRow } from "../../../test-helpers/__shared/fixtures";
import { decideDepegAsset } from "../decision-engine";
import type { DepegDetectionRow } from "../types";
import { attachDetectionReferenceContext } from "../reference-policy";
import { referenceState, tradedPair } from "./reference-fixtures";

const usdPeg = { pegRates: { peggedUSD: 1 }, pegRateSources: { peggedUSD: "median" as const }, pegRateCounts: { peggedUSD: 4 } };
const brlPeg = clockedBenchmark("peggedREAL", 0.191895, 1_750_259_140);

const usdMeta: StablecoinMeta = {
  id: "usdt-tether", name: "Tether", symbol: "USDT",
  flags: { backing: "rwa-backed", pegCurrency: "USD", governance: "centralized", yieldBearing: false, rwa: true, navToken: false },
  geckoId: "tether",
};
const brlMeta: StablecoinMeta = { id: "brz-transfero", name: "Brazilian Digital Token", symbol: "BRZ", flags: { ...usdMeta.flags, pegCurrency: "BRL" }, geckoId: "brz" };
const chfMeta: StablecoinMeta = { id: "vchf-vnx", name: "VNX Swiss Franc", symbol: "VCHF", flags: { ...usdMeta.flags, pegCurrency: "CHF" }, geckoId: "vnx-swiss-franc" };
const goldMeta: StablecoinMeta = {
  id: "vnxau-vnx", name: "VNX Gold", symbol: "VNXAU", flags: { ...usdMeta.flags, pegCurrency: "GOLD" }, geckoId: "vnx-gold", commodityOunces: 0.0321507466,
};

// Local copy of the ZARm metadata the native-domain recovery path reads; the
// catalog entry's PSI-eligible membership is guarded by
// sync-stablecoins/__tests__/supply-gap-reconciliation.test.ts.
const zarMeta: StablecoinMeta = {
  id: "zarm-mento", name: "Mento South African Rand", symbol: "ZARm",
  flags: { backing: "crypto-backed", pegCurrency: "ZAR", governance: "centralized-dependent", yieldBearing: false, rwa: false, navToken: false },
  geckoId: "celo-south-african-rand",
};
const usdInput = { now: 1_750_259_200, meta: usdMeta, ...usdPeg };

function clockedBenchmark(peg: string, value: number, observedAt: number, kind: "fx" | "fallback" = "fx") {
  const pegRates = { [peg]: value };
  const fx = referenceState(pegRates, observedAt);
  attachDetectionReferenceContext(pegRates, [], new Map(), new Set(), fx, fx.repricingByPeg);
  return { pegRates, pegRateSources: { [peg]: kind }, pegRateCounts: { [peg]: 0 } };
}

function makeAsset(overrides: Partial<PegAssetBase> = {}): PegAssetBase {
  return { id: "usdt-tether", symbol: "USDT", price: 0.98, priceSource: "pyth", priceConfidence: "single-source",
    priceUpdatedAt: 1_750_259_200 - 60, pegType: "peggedUSD", circulating: { ethereum: 50_000_000 }, ...overrides };
}

function makeExistingEvent(overrides: Partial<DepegDetectionRow> = {}): DepegDetectionRow {
  return {
    ...makeDepegRow({ id: 7, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", direction: "above", peak_deviation_bps: 180,
      started_at: 1_750_259_200 - 3600, start_price: 0.1909, peak_price: 0.191, peg_reference: 0.18765951 }),
    confirmation_sources: null, pending_reason: null, ...overrides,
  };
}

function makeDexRow(dex_price_usd: number, overrides = {}) {
  return { dex_price_usd, stablecoin_id: "usdt-tether", deviation_from_primary_bps: null, source_pool_count: 2,
    source_total_tvl: 5_000_000, updated_at: 1_750_260_040, aggregateObservedAt: 1_750_260_040, ...overrides };
}

function makeUsdEvent(overrides: Partial<DepegDetectionRow> = {}, pricing = true): DepegDetectionRow {
  return makeExistingEvent({ stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD", direction: "below",
    ...(pricing ? { peak_deviation_bps: -200, start_price: 0.98, peak_price: 0.98 } : {}), peg_reference: 1, ...overrides });
}

const brzAsset = (price: number, overrides: Partial<PegAssetBase> = {}) =>
  makeAsset({ id: "brz-transfero", symbol: "BRZ", price, pegType: "peggedREAL",
    priceObservedAt: 1_750_259_140, priceObservedAtMode: "upstream", ...overrides });
const brzQuote = (price: number) => ({ stablecoinId: "brz-transfero", geckoId: "brz", pegCurrency: "BRL", price, updatedAt: 1_750_259_200 - 60, derivation: tradedPair });
const withheldBrz = [{ level: "warn", message: "[depeg] Withheld implausible BRL native quote for BRZ: reason=native-quote-extreme-move" }];

function assertNativeOpening({ circulating, nativePrice, expectedBps, expectedReason, expectSeenEventIds = false, dexCorroboration, admitted = true }: {
  circulating: Record<string, number>; nativePrice: number; expectedBps: number; expectedReason: string; expectSeenEventIds?: boolean;
  dexCorroboration?: { price: number; tvl: number; aggregateObservedAt?: number }; admitted?: boolean;
}) {
  const updatedAt = 1_750_259_200 - 60;
  const decision = decideDepegAsset({
    now: 1_750_259_200, asset: brzAsset(0.191187, { priceSource: "coingecko", circulating }), meta: brlMeta, ...brlPeg,
    dexRow: dexCorroboration && makeDexRow(dexCorroboration.price, { stablecoin_id: "brz-transfero",
      source_total_tvl: dexCorroboration.tvl, updated_at: updatedAt, aggregateObservedAt: dexCorroboration.aggregateObservedAt }),
    protocolSources: dexCorroboration && ["curve", "uniswap-v3"].map((protocol) => ({
      protocol, chain: "ethereum", sourceFamily: protocol, price: dexCorroboration.price, tvl: dexCorroboration.tvl, observedAt: updatedAt, updatedAt })),
    nativePegQuote: brzQuote(nativePrice),
  });

  expect(decision.trackedCoinId).toBe("brz-transfero");
  if (expectSeenEventIds) expect(decision.seenEventIds).toEqual([]);
  if (!admitted) {
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual(withheldBrz);
    return;
  }
  expect(decision.commands).toHaveLength(1);
  expect(decision.commands[0]).toMatchObject({ type: "upsert-pending", payload: {
    stablecoinId: "brz-transfero", direction: "below", bps: expectedBps, price: nativePrice, pegReference: 1, reason: expectedReason,
  } });
  expect(decision.diagnostics).toEqual([
    { level: "log", message: `[depeg] Pending native-peg confirmation for BRZ: ${expectedBps}bps against BRL quote` },
  ]);
}

describe("decideDepegAsset", () => {
  it("keeps legacy fiat detection closed until Sunday 23:00 UTC", () => {
    const pegRates = { peggedEUR: 1.10 };
    const fx = referenceState(pegRates, Date.UTC(2026, 10, 20, 18, 30) / 1000, false);
    fx.sources = { frankfurter: "ok" };
    const meta = { ...usdMeta, id: "eurc-circle", symbol: "EURC", flags: { ...usdMeta.flags, pegCurrency: "EUR" as const } };
    const referenceContext = attachDetectionReferenceContext(pegRates, [], new Map(), new Set(), fx);
    for (const [hour, minute, expected] of [[22, 15, false], [23, 1, true]] as const) {
      const now = Date.UTC(2026, 10, 22, hour, minute) / 1000;
      const asset = makeAsset({ id: meta.id, symbol: meta.symbol, pegType: "peggedEUR", price: 1.067,
        priceSource: "coingecko", priceObservedAt: now - 60, priceUpdatedAt: now - 60, priceObservedAtMode: "upstream" });
      const decision = decideDepegAsset({ now, asset, meta, pegRates, pegRateSources: { peggedEUR: "fx" },
        pegRateCounts: {}, referenceContext });
      expect(decision.commands).toMatchObject(expected ? [{ type: "upsert-pending", payload: { bps: -300 } }] : []);
    }
  });

  it("retains a dated reference hold only while the same market closure explains the coverage gap", () => {
    const close = Date.UTC(2026, 10, 13, 22) / 1000;
    const existing = makeExistingEvent({ started_at: close - 2000, direction: "below", peak_deviation_bps: -360,
      last_trusted_price_at: close - 60, price_coverage_gap_started_at: null,
      price_coverage_json: JSON.stringify({ intervals: [[close - 900, close - 60]], lastObservationKind: "trusted-off-peg" }) });
    const now = close + 120;
    const input = { now, existing, meta: brlMeta, ...clockedBenchmark("peggedREAL", 0.19, close - 60),
      asset: brzAsset(0.19, { priceSource: "coinbase", priceObservedAt: now - 10 }) };
    const decision = decideDepegAsset(input);
    expect(decision.referenceHold?.hold).toEqual({ reason: "reference-market-closed", declaredAtSec: now,
      lastTrustedAtSec: close - 60, lastTrustedPeakBps: -360 });
    const held = { ...existing, reference_hold_json: JSON.stringify(decision.referenceHold),
      price_coverage_gap_started_at: now, price_coverage_json: JSON.stringify({ intervals: [[close - 900, close - 60]], lastObservationKind: "blind" }) };
    expect(decideDepegAsset({ ...input, existing: held, now: now + 300 }).referenceHold?.hold)
      .toEqual({ ...decision.referenceHold!.hold, refreshedAtSec: now + 300 });
    expect(decideDepegAsset({ ...input, existing: { ...held, peak_deviation_bps: -400 }, now: now + 300 }).referenceHold).toBeUndefined();
    const reopened = Date.UTC(2026, 10, 15, 22, 2) / 1000;
    const reopening = { ...input, now: reopened, asset: { ...input.asset, priceObservedAt: reopened - 10 } };
    expect(decideDepegAsset({ ...reopening, existing: held }).referenceHold).toBeUndefined();
    const rechecked = { ...held, reference_hold_json: JSON.stringify({ ...decision.referenceHold,
      hold: { ...decision.referenceHold!.hold, refreshedAtSec: reopened - 900 } }) };
    expect(decideDepegAsset({ ...reopening, existing: rechecked }).referenceHold?.hold)
      .toEqual({ ...decision.referenceHold!.hold, refreshedAtSec: reopened });
    expect(decideDepegAsset({ ...input, existing: held, asset: { ...input.asset, priceObservedAt: null } }).referenceHold).toBeUndefined();
  });

  it("recovers native cNGN event 90738 from two dated USD/NGN observations", () => {
    const meta: StablecoinMeta = { ...usdMeta, id: "cngn-compliant-naira", symbol: "cNGN",
      flags: { ...usdMeta.flags, pegCurrency: "NGN" } };
    const now = Date.UTC(2026, 10, 18, 13) / 1000;
    const existing = makeExistingEvent({ id: 90738, stablecoin_id: meta.id, symbol: meta.symbol,
      peg_type: "peggedNGN", peg_reference: 1, direction: "below", start_price: 0.94, started_at: now - 86400 });
    const observation = (at: number, priceSource: string) => ({
      ...clockedBenchmark("peggedNGN", 0.0007, at - 120), meta, now: at, existing,
      asset: makeAsset({ id: meta.id, symbol: meta.symbol, pegType: "peggedNGN", price: 0.0007,
        priceSource, priceObservedAtMode: "upstream", priceObservedAt: at - 30, priceUpdatedAt: at - 30 }),
      dexRow: { ...makeDexRow(0.0007, { updated_at: at }), stablecoin_id: meta.id, aggregateObservedAt: at - 30,
        pricePoolKeys: ["ethereum:0x0000000000000000000000000000000000000001"],
        upstreamKeys: ["ethereum:0x0000000000000000000000000000000000000001", "venue:bitstamp"] },
      nativePegQuote: { stablecoinId: meta.id, geckoId: "compliant-naira", pegCurrency: "NGN",
        price: 1, updatedAt: at - 10, derivation: { kind: "conversion" as const, lineage: {} } },
    });
    expect(decideDepegAsset(observation(now, "coingecko-native-implied")).commands).toEqual([]);
    const undatedPool = observation(now, "dex-promoted");
    expect(decideDepegAsset({ ...undatedPool, dexRow: { ...undatedPool.dexRow, upstreamKeys: [] } }).commands).toEqual([]);
    const start = decideDepegAsset(observation(now, "dex-promoted")).commands;
    expect(start).toMatchObject([{ type: "begin-recovery", firstSeenAt: now - 120, lastSeenAt: now - 120,
      source: "native", usdObservedAt: now - 30 }]);
    const next = observation(now + 900, "dex-promoted");
    const prior = { ...existing, recovery_evidence_source: "native" as const,
      recovery_first_seen_at: now - 120, recovery_last_seen_at: now - 120,
      recovery_usd_first_seen_at: now - 30, recovery_usd_observed_at: now - 30 };
    expect(decideDepegAsset({ ...next, existing: prior }).commands).toMatchObject([
      { type: "close-event", closeReason: "recovered-native", recoveryPrice: 1, recoveryPegReference: 1 },
    ]);
    // The FX clock can advance the older of the two legs while the USD trade stays fixed.
    const earlierFx = { ...prior, recovery_first_seen_at: now - 1000, recovery_last_seen_at: now - 1000,
      last_trusted_price_at: now - 1000, price_coverage_gap_started_at: now - 1000,
      price_coverage_json: JSON.stringify({ intervals: [], atParIntervals: [[now - 1000, now - 1000]], lastObservationKind: "trusted-at-par" }) };
    const repeat = decideDepegAsset({ ...next, existing: earlierFx, dexRow: { ...next.dexRow, aggregateObservedAt: now - 30 },
      asset: { ...next.asset, priceObservedAt: now - 30 } });
    expect(repeat.commands).toEqual([]);
    expect(repeat.priceCoverage?.lastTrustedObservationAt).toBe(now - 1000);
    expect(decideDepegAsset({ ...next, existing: earlierFx, dexRow: { ...next.dexRow, aggregateObservedAt: now - 20 },
      asset: { ...next.asset, priceObservedAt: now - 20 } }).commands)
      .toMatchObject([{ type: "continue-recovery", lastSeenAt: now - 20, usdObservedAt: now - 20 }]);
    expect(decideDepegAsset({ ...next, existing: { ...prior, recovery_usd_first_seen_at: null, recovery_usd_observed_at: null } }).commands)
      .toMatchObject([{ type: "begin-recovery", usdObservedAt: now + 870 }]);
    expect(decideDepegAsset({ ...next, existing: prior, nativePegQuote: { ...next.nativePegQuote, derivation: tradedPair } }).commands)
      .toEqual([{ type: "begin-recovery", id: 90738, firstSeenAt: now + 890, lastSeenAt: now + 890, source: "native" }]);
  });

  it.each([
    ["peer-divergence", 0.93, 1, true],
    ["cohort-wide", 0.70, 0.70, false],
    ["conversion", 0.93, 1, false],
    ["mirrored-pool", 0.93, 1, false],
    ["legacy-pool", 0.93, 1, false],
    ["outvoted-pool", 0.93, 1, false],
    ["open-benchmark-event", 0.93, 1, true],
  ] as const)("uses independent weekend evidence for %s", (scenario, price, peerPrice, pending) => {
    const now = Date.UTC(2026, 10, 14, 12) / 1_000;
    const asset = brzAsset(price, { priceSource: "coingecko", priceObservedAt: now - 60 });
    const peers = ["binance", "coinbase", "kraken"].map((priceSource) =>
      brzAsset(peerPrice, { id: priceSource, priceSource, priceObservedAt: now - 60 }));
    const pegRates = { peggedREAL: 1 };
    const metas = new Map(peers.map((peer) => [peer.id, brlMeta]));
    metas.set(asset.id, brlMeta);
    attachDetectionReferenceContext(pegRates, [asset, ...peers], metas, new Set(), null).rollbackSupportsPeerEvents = true;
    const decision = decideDepegAsset({
      ...brlPeg, pegRates, asset, now, meta: brlMeta,
      existing: scenario === "open-benchmark-event" ? makeExistingEvent({ direction: "below", peak_deviation_bps: -250,
        started_at: now - 86_400, peg_reference: 1.02, pending_reason: "confirmation-window" }) : undefined,
      nativePegQuote: scenario === "conversion" ? { ...brzQuote(0.93), updatedAt: now - 60,
        derivation: { kind: "conversion", lineage: {} } } : undefined,
      challengerPools: scenario === "conversion" ? undefined : [
        { protocol: scenario === "legacy-pool" ? "unknown" : "curve", chain: "ethereum",
          sourceFamily: scenario === "legacy-pool" ? "legacy-challenger-pools" : scenario === "mirrored-pool" ? "coingecko" : "curve",
          tvlUsd: 210_000, price, observedAt: now - 30 },
        ...(scenario === "outvoted-pool" ? ["uniswap", "aerodrome"].map((protocol, index) => ({
          protocol, sourceFamily: protocol, chain: "ethereum", tvlUsd: index ? 25_000_000 : 5_000_000, price: 1, observedAt: now - 30,
        })) : []),
      ],
    });
    if (scenario === "open-benchmark-event") {
      expect(decision.commands).toMatchObject([{ type: "update-peak", peakDeviationBps: -700, peakPrice: 0.93,
        peakPegReference: 1, peakQuoteDomain: "usd", peakReceipt: expect.stringContaining('"basis":"peer-relative"') }]);
    } else if (pending) expect(decision.commands).toMatchObject([{ type: "upsert-pending", payload: {
      pegReference: 1, reason: expect.stringContaining("low-confidence+peer-relative"),
      peerBasis: expect.stringContaining("coinbase"),
    } }]);
    else expect(decision.commands).toEqual([]);
  });

  it("opens on the calibrated BRL benchmark with a stable cohort and a separate native trade", () => {
    const now = Date.UTC(2026, 10, 14, 12) / 1_000;
    const at = now - 60;
    const asset = brzAsset(0.81, { priceSource: "coingecko", priceObservedAt: at, priceUpdatedAt: at });
    const peers = ["binance", "coinbase", "kraken"].map((priceSource) =>
      brzAsset(1, { id: priceSource, priceSource, priceObservedAt: at, priceUpdatedAt: at }));
    const rates = clockedBenchmark("peggedREAL", 1, Date.UTC(2026, 10, 13, 21, 55) / 1_000);
    const fx = referenceState(rates.pegRates, Date.UTC(2026, 10, 13, 21, 55) / 1_000);
    attachDetectionReferenceContext(rates.pegRates, [asset, ...peers], new Map([asset, ...peers].map((row) => [row.id, brlMeta])),
      new Set(), fx);
    const decision = decideDepegAsset({ ...rates, asset, now, meta: brlMeta, nativePegQuote: { ...brzQuote(0.97), updatedAt: at } });
    expect(decision.commands).toMatchObject([{ type: "upsert-pending", payload: {
      direction: "below", price: 0.81, pegReference: 1, reason: expect.not.stringContaining("peer-relative"),
    } }]);
  });

  it("keeps the severe benchmark band for a thin cohort when calibration is lower", () => {
    const now = Date.UTC(2026, 10, 14, 12) / 1_000;
    const config = REFERENCE_CLOSURE_HOLD_BANDS_BPS.BRL;
    const previous = config.weekend;
    Reflect.set(config, "weekend", 600);
    try {
      const decision = decideDepegAsset({
        ...clockedBenchmark("peggedREAL", 1, Date.UTC(2026, 10, 13, 21, 55) / 1_000),
        now, meta: brlMeta, asset: brzAsset(0.90, { priceObservedAt: now - 60 }),
        nativePegQuote: { ...brzQuote(0.90), updatedAt: now - 60 },
      });
      expect(decision.commands).toMatchObject([{ type: "upsert-pending", payload: {
        reason: expect.stringContaining("native-origin"), seenAt: now, quoteObservedAt: now - 60,
      } }]);
    } finally {
      Reflect.set(config, "weekend", previous);
    }
  });

  it.each(["sub-floor", "pre-reopen", "local-fetch", "in-session"])("orders lifecycle admission for %s", (scenario) => {
    const reopen = Date.UTC(2026, 10, 15, 23) / 1_000;
    const now = scenario === "sub-floor" ? reopen - 3_600 : reopen + 60;
    const pegRates = { peggedGOLD: 100 };
    const asset = makeAsset({ pegType: "peggedGOLD", price: 97.8, priceObservedAt: scenario === "pre-reopen" ? reopen - 60 : now - 10,
      priceObservedAtMode: scenario === "local-fetch" ? "local_fetch" : "upstream", priceUpdatedAt: now - 10, circulating: { ethereum: scenario === "sub-floor" ? 991_742 : 50_000_000 } });
    const meta = { ...goldMeta, commodityOunces: 1 };
    const fx = referenceState(pegRates, now - 30);
    attachDetectionReferenceContext(pegRates, [], new Map(), new Set(), fx, fx.repricingByPeg);
    const nativePegQuote = scenario === "sub-floor" ? { stablecoinId: asset.id, geckoId: "test-gold",
      pegCurrency: "GOLD", price: 0.96, updatedAt: now - 10, derivation: tradedPair } : undefined;
    const decision = decideDepegAsset({ now, asset, meta, pegRates, pegRateSources: { peggedGOLD: "fallback" }, pegRateCounts: {}, nativePegQuote,
      existing: makeExistingEvent({ peg_type: "peggedGOLD", direction: "below", peak_deviation_bps: -170, peg_reference: 99 }) });
    if (scenario === "in-session") expect(decision.commands).toMatchObject([
      { type: "update-peak", peakDeviationBps: -220, peakPegReference: 100, peakQuoteDomain: "usd" },
    ]);
    else expect(decision.commands).toEqual([]);
    if (scenario === "sub-floor") expect(decision.observation).toEqual({ kind: "below-floor" });
  });

  it.each([
    ["xofm-mento", "XOF", "peggedXOF", "mento-broker", 0.98],
    ["susd-solayer", "USD", "peggedUSD", "protocol-redeem", 1.181399598224652],
    ["susd-solayer", "USD", "peggedUSD", "protocol-redeem-cached-rate", 1.181399598224652],
  ] as const)("withholds the %s %s valuation as an event quote above the supply floor", (id, pegCurrency, pegType, source, ratio) => {
    const now = usdInput.now;
    const meta = { ...usdMeta, id, flags: { ...usdMeta.flags, pegCurrency } };
    const pegReference = pegCurrency === "USD" ? 1 : 0.0018;
    const pricing = pegCurrency === "USD" ? usdPeg : clockedBenchmark(pegType, pegReference, now - 60);
    const coin = { ...makeAsset({ id, pegType, price: pegReference * ratio, priceSource: source,
      priceObservedAtMode: "upstream", priceObservedAt: now - 30, priceUpdatedAt: now - 30 }),
      ...(id === "susd-solayer" ? { parityQuoteUnit: "accrued-token" as const } : {}) };
    for (const priceSource of [source, "cached"]) {
      const decision = decideDepegAsset({ ...pricing, meta, now, asset: { ...coin, priceSource, agreeSources: [source] } });
      expect(decision.commands).toEqual([]);
      expect(decision.observation?.kind).toBe("unavailable");
    }
    const traded = decideDepegAsset({ ...pricing, meta, now, asset: coin,
      nativePegQuote: { stablecoinId: id, geckoId: id, pegCurrency, price: 0.97, updatedAt: now - 30,
        derivation: { kind: "traded-pair", lineage: { venue: "kraken", pair: `${coin.symbol}/${pegCurrency}` } } },
    });
    expect(traded.commands).toMatchObject([{ type: "upsert-pending", payload: { price: 0.97, pegReference: 1, nativeVenue: "kraken" } }]);
  });

  it.each(["peggedGBP", "peggedUSD"])("withholds EURC at parity when the provider labels it %s", (pegType) => {
    const meta = { ...usdMeta, id: "eurc-circle", flags: { ...usdMeta.flags, pegCurrency: "EUR" as const } };
    const asset = makeAsset({ id: meta.id, price: 1.1, pegType, priceObservedAtMode: "upstream", priceObservedAt: usdInput.now });
    const decision = decideDepegAsset({ ...clockedBenchmark("peggedGBP", 1.3, usdInput.now), now: usdInput.now, asset, meta });
    expect(decision.commands).toEqual([]);
    expect(decision.observation).toEqual({ kind: "unavailable", reason: "invalid-reference" });
  });

  it.each(["matched", "missing", "wrong-quote", "future-block", "wrong-generation", "prior-day"] as const)("uses the %s XAGm entitlement for event and peer pricing", (mode) => {
    const now = usdInput.now;
    const meta = { ...goldMeta, id: "xagm-matrixdock", commodityOunces: 1, flags: { ...goldMeta.flags, pegCurrency: "SILVER" as const } };
    const pegRates = { peggedSILVER: 30 };
    const observedAt = now - 30;
    const asset = { ...makeAsset({ id: meta.id, pegType: "peggedSILVER", price: 29.95142466, priceSource: "kraken",
      priceObservedAtMode: "upstream", priceObservedAt: observedAt }),
      commodityEntitlement: mode === "missing" ? undefined : { source: "matrixdock-frs" as const, generation: mode === "wrong-generation" ? "other:123" : "ethereum:123",
        ozPerToken: 0.998380822, observedAtSec: mode === "future-block" ? now : mode === "prior-day" ? observedAt - 86_400 : observedAt - 60,
        quoteObservedAtSec: mode === "wrong-quote" ? observedAt - 60 : observedAt },
    };
    const fx = referenceState(pegRates, now - 60);
    const context = attachDetectionReferenceContext(pegRates, [asset], new Map([[asset.id, meta]]), new Set(), fx, fx.repricingByPeg);
    const decision = decideDepegAsset({ now, meta, asset, pegRates, pegRateSources: { peggedSILVER: "fallback" },
      pegRateCounts: {}, referenceContext: context });
    const peer = context.groups.get("peggedSILVER")?.peers[0];
    if (mode === "matched") {
      expect(peer?.priceUsd).toBeCloseTo(30, 10);
      expect(decision.observation).toEqual({ kind: "observed" });
      expect(decision.commands).toEqual([]);
      const offPeg = decideDepegAsset({ now, meta, asset: { ...asset, price: 29 }, pegRates,
        pegRateSources: { peggedSILVER: "fallback" }, pegRateCounts: {}, referenceContext: context });
      expect(offPeg.commands).toMatchObject([{ type: "upsert-pending", payload: { pegReference: 29.95142466 } }]);
    } else {
      expect(peer).toBeUndefined();
      expect(decision.observation).toEqual({ kind: "unavailable", reason: "invalid-reference" });
    }
  });

  it.each([[-60, 0.90], [-60, 1.10], [0, 1.10], [30, 1.10], [60, 1.10]])("orders native peak and reversal against onset at %s/%s", (offset, price) => {
    const startedAt = 1_750_259_000;
    const observedAt = startedAt + offset;
    const decision = decideDepegAsset({
      now: usdInput.now, meta: brlMeta, ...brlPeg, asset: brzAsset(0.19),
      existing: makeExistingEvent({ quote_mode: "native-peg", direction: "below", peg_reference: 1,
        peak_deviation_bps: -200, started_at: startedAt, last_trusted_price_at: offset === 30 ? startedAt + 40 : null }),
      nativePegQuote: { ...brzQuote(price), updatedAt: observedAt },
    });
    if (offset !== 60) expect(decision.commands).toEqual([]);
    else expect(decision.commands).toMatchObject([
      { type: "close-event", endedAt: observedAt }, { type: "upsert-pending", payload: { seenAt: usdInput.now, quoteObservedAt: observedAt } },
    ]);
  });

  it.each([97, 100])("adopts an independently traded closed metal median for price %s", (price) => {
    const now = Date.UTC(2026, 10, 14, 12) / 1_000;
    const meta = { ...goldMeta, commodityOunces: 1 };
    const pegRates = { peggedGOLD: 100 };
    const sample = (id: string, priceSource: string, value: number) => makeAsset({
      id, priceSource, price: value, pegType: "peggedGOLD", priceUpdatedAt: now - 30,
      priceObservedAt: now - 30, priceObservedAtMode: "upstream",
    });
    const asset = sample(meta.id, "pyth", price);
    const quotes = [asset, ...["coinbase", "binance", "kraken"].map((source) => sample(source, source, 100))];
    attachDetectionReferenceContext(pegRates, quotes, new Map(quotes.map((quote) => [quote.id, meta])), new Set(), null, undefined,
      { peggedGOLD: 4 });
    const decision = decideDepegAsset({ now, asset, meta, pegRates, pegRateSources: { peggedGOLD: "median" },
      pegRateCounts: { peggedGOLD: 4 }, existing: price === 100 ? makeExistingEvent({
        stablecoin_id: meta.id, peg_type: "peggedGOLD", direction: "below", started_at: now - 3_600, peg_reference: 100,
      }) : undefined });
    expect(decision.commands.map(({ type }) => type)).toEqual([price === 97 ? "upsert-pending" : "begin-recovery"]);
  });

  it.each([0, 60, 900, 1201])("uses two original DEX clocks to advance recovery by %s seconds", (advance) => {
    const firstSeenAt = usdInput.now;
    const observedAt = firstSeenAt + advance;
    const observe = (at: number, existing: DepegDetectionRow) => decideDepegAsset({
      ...usdInput, now: at + 60, asset: makeAsset({ price: 1, priceSource: "coingecko", priceUpdatedAt: at,
        priceObservedAt: at, priceObservedAtMode: "upstream" }),
      existing, dexRow: makeDexRow(1, { updated_at: at, aggregateObservedAt: at }),
      protocolSources: ["curve", "uniswap"].map((protocol) => ({ protocol, chain: "ethereum", sourceFamily: protocol,
        price: 1, tvl: 2_500_000, updatedAt: at, observedAt: at })),
    });
    const start = observe(firstSeenAt, makeUsdEvent()).commands[0];
    expect(start).toMatchObject({ type: "begin-recovery", source: "dex", firstSeenAt });
    if (start.type !== "begin-recovery") throw new Error("Missing initial DEX observation");
    const decision = observe(observedAt, makeUsdEvent({ recovery_first_seen_at: start.firstSeenAt,
      recovery_last_seen_at: start.lastSeenAt, recovery_evidence_source: start.source }));
    expect(decision.commands).toMatchObject(advance === 0 ? [] : advance === 60
      ? [{ type: "continue-recovery", lastSeenAt: observedAt }]
      : advance === 900 ? [{ type: "close-event", closeReason: "recovered-dex", recoveryPegReference: 1 }]
        : [{ type: "begin-recovery", firstSeenAt: observedAt, lastSeenAt: observedAt, source: "dex" }]);
  });

  describe("original aggregate clocks", () => {
    const now = 1_750_259_200;
    it.each([null, now - 6 * 3600, now - 60])("separates affirmative evidence from vetoes at %s", (aggregateObservedAt) => {
      const fresh = aggregateObservedAt === now - 60;
      const sample = (price: number, dexPrice: number, authoritative = false) => ({
        now, meta: usdMeta, ...usdPeg,
        asset: makeAsset({ price, priceSource: authoritative ? "pyth" : "coingecko" }),
        existing: makeExistingEvent({ stablecoin_id: usdMeta.id, symbol: usdMeta.symbol, peg_type: "peggedUSD",
          direction: "below", peg_reference: 1, peak_deviation_bps: -200 }),
        dexRow: { stablecoin_id: usdMeta.id, dex_price_usd: dexPrice, deviation_from_primary_bps: null,
          source_pool_count: 2, source_total_tvl: 5_000_000, updated_at: now - 30, aggregateObservedAt },
        protocolSources: ["curve", "uniswap"].map((protocol) => ({
          protocol, sourceFamily: protocol, chain: "ethereum", price: dexPrice, tvl: 2_500_000, updatedAt: now - 30,
          observedAt: now - 30, aggregateObservedAt: now - 30,
        })),
      });
      for (const price of [0.992, null]) {
        const input = sample(0.992, 0.992);
        input.asset.price = price;
        input.dexRow.aggregateObservedAt = now - 30;
        expect(decideDepegAsset(input).deadBandNotice?.eventId).toBe(7);
      }
      const zarp = { ...sample(0.985106, 0.991964),
        meta: { ...usdMeta, flags: { ...usdMeta.flags, pegCurrency: "ZAR" as const } },
        asset: makeAsset({ price: 0.985106, priceSource: "coingecko", pegType: "peggedZAR",
          priceObservedAt: now - 60, priceObservedAtMode: "upstream" }),
        ...clockedBenchmark("peggedZAR", 1, now - 60) };
      zarp.dexRow.aggregateObservedAt = now - 30;
      zarp.dexRow.source_total_tvl = 1605155;
      zarp.protocolSources.forEach((source, i) => { source.price = i ? 1.022914 : 0.984958; });
      expect(decideDepegAsset(zarp).deadBandNotice?.price).toBe(0.991964);
      for (const [dex_price_usd, notice] of [
        [1.007, false], [1.0075, false], [1.007501, true], [1.014999, true], [1.015, false], [1.016, false],
      ] as const) {
        expect(Boolean(decideDepegAsset({ ...zarp, dexRow: { ...zarp.dexRow, dex_price_usd } }).deadBandNotice)).toBe(notice);
      }
      for (const [price, families, age, tvl] of [[0.992, 2, 30, 5e6], [0.992, 1, 30, 5e6],
        [0.992, 2, 2101, 5e6], [0.992, 2, 30, 999999], [1, 2, 30, 5e6], [0.98, 2, 30, 5e6]]) {
        const input = sample(price, price);
        input.protocolSources = input.protocolSources.slice(0, families).map((source, index) => ({ ...source,
          price: price === 0.992 ? [0.98, 1.02][index] : price, observedAt: now - age }));
        input.dexRow.source_total_tvl = tvl;
        const decision = decideDepegAsset(input);
        const notice = fresh && price === 0.992 && families === 2 && age === 30 && tvl === 5e6;
        expect(Boolean(decision.deadBandNotice)).toBe(notice);
        if (notice) expect(decision).toMatchObject({ commands: [], seenEventIds: [7],
          priceCoverage: { lastObservationKind: "blind" }, deadBandNotice: { eventId: 7, price,
            contributors: input.protocolSources.map(({ price, observedAt }) => expect.objectContaining({ price, observedAt })) } });
      }
      const recovery = decideDepegAsset(sample(1, 1));
      expect(recovery.observation).toEqual({ kind: "observed" });
      expect(recovery.commands.map((command) => command.type)).toEqual(fresh ? ["begin-recovery"] : []);
      expect(recovery.priceCoverage?.lastObservationKind).toBe(fresh ? "trusted-at-par" : "blind");
      const reversal = decideDepegAsset(sample(1.02, 1.02));
      expect(reversal.commands.map((command) => command.type)).toEqual(fresh ? ["close-event", "upsert-pending"] : []);
      expect(decideDepegAsset(sample(0.98, 0.98)).priceCoverage?.lastObservationKind)
        .toBe(fresh ? "trusted-off-peg" : "blind");
      const veto = decideDepegAsset(sample(1, 0.98, true));
      expect(veto.commands).toEqual([]);
      expect(veto.priceCoverage?.lastObservationKind).toBe("blind");
      expect(decideDepegAsset({ ...sample(0.98, 1), existing: undefined }).commands).toEqual([]);
    });
  });

  it.each([
    { priceSource: "pyth", priceObservedAtMode: "nominal_reference" as const },
    { priceSource: "protocol-par" },
  ])("does not open or recover an event from nominal evidence: %j", (provenance) => {
    for (const price of [0.98, 1]) {
      for (const existing of [undefined, makeExistingEvent({
        stablecoin_id: usdMeta.id, symbol: usdMeta.symbol, peg_type: "peggedUSD", peg_reference: 1,
      })]) {
        const decision = decideDepegAsset({ now: 1_750_259_200, asset: makeAsset({ price, priceConfidence: "high", ...provenance }), meta: usdMeta, existing, ...usdPeg });
        expect(decision.commands).toEqual([]);
      }
    }
  });

  describe("observation outcome", () => {
    const usdEvent = () => makeExistingEvent({ stablecoin_id: usdMeta.id, symbol: usdMeta.symbol, peg_type: "peggedUSD", peg_reference: 1, direction: "below" });

    it.each([
      ["missing price", { price: null }],
      ["nominal price", { priceSource: "protocol-par", price: 1 }],
    ] as const)("records %s as primary-unusable", (_label, overrides) => {
      for (const existing of [undefined, usdEvent()]) {
        for (const circulating of [{ ethereum: 0 }, {}] as Record<string, number>[]) {
          const decision = decideDepegAsset({ ...usdInput, asset: makeAsset({ ...overrides, circulating }), existing });
          expect(decision.observation).toEqual({ kind: "unavailable", reason: "primary-unusable" });
          expect(decision.commands).toEqual([]);
        }
      }
    });

    it.each([false, true])("records unavailable supply without inventing zero (open event: %s)", (withEvent) => {
      const existing = withEvent ? usdEvent() : undefined;
      const decision = decideDepegAsset({ ...usdInput, existing, asset: makeAsset({ circulating: {} }) });
      expect(decision.observation).toEqual({ kind: "unavailable", reason: "supply-unavailable" });
      expect(decision.commands).toEqual([]);
      expect(decision.seenEventIds).toEqual(withEvent ? [existing!.id] : []);
    });

    it("separates observed zero supply as below-floor", () => {
      const decision = decideDepegAsset({ ...usdInput, existing: usdEvent(), asset: makeAsset({ circulating: { ethereum: 0 } }) });
      expect(decision.observation).toEqual({ kind: "below-floor" });
      expect(decision.commands).toMatchObject([{ type: "close-event", closeReason: "coverage-lost-supply" }]);
    });

    it.each([
      ["non-authoritative-reference", { peggedREAL: "median" as const }, { peggedREAL: 1 }, { peggedREAL: 0.19 }],
      ["invalid-reference", { peggedREAL: "median" as const }, { peggedREAL: 4 }, { peggedREAL: 0 }],
    ])("records the %s peg-signal rejection", (reason, pegRateSources, pegRateCounts, pegRates) => {
      const decision = decideDepegAsset({ now: 1_750_259_200, asset: brzAsset(0.19), meta: brlMeta, pegRates, pegRateSources, pegRateCounts });
      expect(decision.observation).toEqual({ kind: "unavailable", reason });
    });

    it("records a native-domain event without a native quote as native-quote-unavailable", () => {
      const decision = decideDepegAsset({
        now: 1_750_259_200, asset: brzAsset(0.1876), meta: brlMeta, existing: makeExistingEvent({ peg_reference: 1, source: "live" }),
        pegRates: { peggedREAL: 0.18765951 }, pegRateSources: { peggedREAL: "median" }, pegRateCounts: { peggedREAL: 3 },
      });
      expect(decision.observation).toEqual({ kind: "unavailable", reason: "native-quote-unavailable" });
    });

    it.each([
      ["at par", { price: 1 }],
      ["confirmation-required depeg", {}],
      ["stale (confirmation-required) price", { priceUpdatedAt: 1_750_259_200 - 30 * 86400 }],
    ])("counts a usable %s context as observed", (_label, overrides) => {
      const decision = decideDepegAsset({ ...usdInput, asset: makeAsset(overrides) });
      expect(decision.observation).toEqual({ kind: "observed" });
    });

    it("leaves untracked and NAV rows outside the census", () => {
      expect(decideDepegAsset({ ...usdInput, meta: undefined, asset: makeAsset() }).observation).toBeUndefined();
      expect(decideDepegAsset({
        ...usdInput, meta: { ...usdMeta, flags: { ...usdMeta.flags, navToken: true } }, asset: makeAsset(),
      }).observation).toBeUndefined();
    });
  });

  it("routes an authoritative small-cap depeg through pending confirmation", () => {
    const decision = decideDepegAsset({ ...usdInput, asset: makeAsset() });

    expect(decision.trackedCoinId).toBe("usdt-tether");
    expect(decision.commands).toHaveLength(1);
    expect(decision.commands[0]).toMatchObject({ type: "upsert-pending", payload: {
      stablecoinId: "usdt-tether", direction: "below", bps: -200, price: 0.98, pegReference: 1, reason: "confirmation-window",
    } });
    expect(decision.diagnostics).toEqual([{ level: "log", message: "[depeg] Pending confirmation for USDT: -200bps (confirmation-window)" }]);

    const directionFlip = decideDepegAsset({ ...usdInput, asset: makeAsset({ price: 1.02 }), existing: makeUsdEvent({}, false) });
    expect(directionFlip.commands[0]).toMatchObject({ type: "close-event", recoveryPrice: null, closeReason: "superseded-direction" });
  });

  it("uses run ordering for an unclocked USD primary and rejects a repeated upstream quote", () => {
    const now = usdInput.now;
    for (const clocked of [false, true]) {
      const sourceClock = clocked ? { priceObservedAt: now, priceObservedAtMode: "upstream" as const } : {};
      const reverse = decideDepegAsset({ ...usdInput, asset: makeAsset({ price: 1.02, ...sourceClock }),
        existing: makeUsdEvent({ started_at: now }) });
      expect(reverse.commands.map(({ type }) => type)).toEqual(clocked ? [] : ["close-event", "upsert-pending"]);
      const recovery = decideDepegAsset({ ...usdInput, asset: makeAsset({ price: 1, ...sourceClock }),
        existing: makeUsdEvent({ recovery_first_seen_at: now - 900, recovery_last_seen_at: now }) });
      expect(recovery.commands.map(({ type }) => type)).toEqual(clocked ? [] : ["close-event"]);
    }
  });

  it("returns pending command diagnostics without logging as a side effect", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const decision = decideDepegAsset({ ...usdInput, asset: makeAsset({ circulating: { ethereum: 2_000_000_000 } }) });

      expect(decision.commands).toHaveLength(1);
      expect(decision.commands[0]).toMatchObject({
        type: "upsert-pending", payload: { stablecoinId: "usdt-tether", direction: "below", bps: -200, reason: "confirmation-window+large-cap" },
      });
      expect(decision.diagnostics).toEqual([{ level: "log", message: "[depeg] Pending confirmation for USDT: -200bps (confirmation-window+large-cap)" }]);
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it.each<[string, Partial<PegAssetBase>, number, string]>([
    ["routes near-threshold market-cap weak-source severe moves to pending",
      { price: 0.975, circulating: { ethereum: 999_000_000 }, agreeSources: ["pyth"] }, -250, "confirmation-window+large-cap"],
    ["requires the confirmation window even with strong primary evidence", { price: 0.985, priceSource: "binance+pyth", priceConfidence: "high",
      agreeSources: ["binance", "pyth"], circulating: { ethereum: 999_000_000 } }, -150, "confirmation-window"],
    ["keeps same-family extreme moves pending even when two source labels agree", { price: 0.2, priceSource: "coingecko+coingecko-low-volume",
      priceConfidence: "high", agreeSources: ["coingecko", "coingecko-low-volume"], circulating: { ethereum: 20_000_000 } },
      -8000, "confirmation-window+extreme-move+low-confidence"],
  ])("%s", (_title, asset, bps, reason) => {
    const decision = decideDepegAsset({ ...usdInput, asset: makeAsset(asset) });

    expect(decision.commands).toHaveLength(1);
    expect(decision.commands[0]).toMatchObject({ type: "upsert-pending", payload: { stablecoinId: "usdt-tether", direction: "below", bps, reason } });
  });

  it("does not start confirmation when only the rounded value reaches the threshold", () => {
    expect(decideDepegAsset({ ...usdInput, asset: makeAsset({ price: 0.99005 }) }).commands).toEqual([]);
  });

  it("requires the confirmation window for independent multi-source extreme moves", () => {
    const decision = decideDepegAsset({
      ...usdInput,
      asset: makeAsset({ id: "msusd-main-street", symbol: "msUSD", price: 0.2, priceSource: "coingecko+defillama-list", priceConfidence: "high",
        agreeSources: ["coingecko", "defillama-list"], circulating: { ethereum: 20_000_000 } }),
      meta: { ...usdMeta, id: "msusd-main-street", name: "Main Street USD", symbol: "msUSD", geckoId: "main-street-usd" },
    });

    expect(decision.trackedCoinId).toBe("msusd-main-street");
    expect(decision.commands).toHaveLength(1);
    expect(decision.commands[0]).toMatchObject({ type: "upsert-pending", payload: {
      stablecoinId: "msusd-main-street", direction: "below", bps: -8000, price: 0.2, reason: "confirmation-window+extreme-move+low-confidence",
    } });
    expect(decision.diagnostics).toHaveLength(1);
  });

  it("suppresses a live mutation when the native quote shows recovery", () => {
    const decision = decideDepegAsset({
      now: 1_750_259_200, asset: brzAsset(0.190587), meta: brlMeta, nativePegQuote: brzQuote(0.995),
      ...clockedBenchmark("peggedREAL", 0.18765951, 1_750_259_140),
    });

    expect(decision.trackedCoinId).toBe("brz-transfero");
    expect(decision.commands).toHaveLength(0);
    expect(decision.diagnostics).toEqual([{ level: "warn", message: "[depeg] Suppressed live depeg mutation for BRZ: primary=156bps but BRL quote=-50bps" }]);
  });

  it.each([
    ["a supported native-peg depeg through pending confirmation", 22_000_000, "confirmation-window+native-origin", false],
    ["large-cap native-peg openings to pending confirmation", 2_000_000_000, "confirmation-window+large-cap+native-origin", true],
  ])("routes %s", (_label, gnosis, expectedReason, expectSeenEventIds) => {
    assertNativeOpening({ circulating: { gnosis }, nativePrice: 0.9758, expectedBps: -242, expectedReason, expectSeenEventIds });
  });

  it.each([60, 21_600, undefined])("routes extreme native-peg openings only with fresh original DEX clocks (%s)", (age) => {
    assertNativeOpening({
      circulating: { gnosis: 22_000_000 }, nativePrice: 0.2, expectedBps: -8000, expectedReason: "confirmation-window+extreme-move+native-origin",
      expectSeenEventIds: true, dexCorroboration: { price: 0.038379, tvl: 2_500_000, aggregateObservedAt: age == null ? undefined : 1_750_259_200 - age },
      admitted: age === 60,
    });
  });

  it.each([60, 21_600, undefined])("requires fresh DEX support for an extreme native-quote veto at age %s", (age) => {
    const now = 1_750_259_200;
    const decision = decideDepegAsset({ now, meta: brlMeta, ...brlPeg, asset: brzAsset(0.191895 * 1.03), nativePegQuote: brzQuote(0.2),
      dexRow: makeDexRow(0.038379, { stablecoin_id: brlMeta.id, updated_at: now - 60, aggregateObservedAt: age == null ? undefined : now - age }),
      protocolSources: ["curve", "uniswap-v3"].map((protocol) => ({
        protocol, sourceFamily: protocol, chain: "ethereum", price: 0.038379, tvl: 2_500_000, observedAt: now - 60, updatedAt: now - 60,
      })),
    });
    expect(decision.commands.map(({ type }) => type)).toEqual(age === 60 ? [] : ["upsert-pending"]);
    expect(decision.diagnostics.some(({ message }) => message.includes("Suppressed live depeg mutation"))).toBe(age === 60);
  });

  it.each([
    ["an uncorroborated extreme native-peg opening as unavailable evidence", undefined],
    ["an extreme native quote when a trusted DEX aggregate stays at peg",
      makeDexRow(0.1919, { stablecoin_id: "brz-transfero", updated_at: 1_750_259_200 - 60, aggregateObservedAt: 1_750_259_200 - 60 })],
  ])("withholds %s", (_label, dexRow) => {
    const decision = decideDepegAsset({
      now: 1_750_259_200, asset: brzAsset(0.191187, { priceSource: "coingecko", circulating: { gnosis: 22_000_000 } }), meta: brlMeta, ...brlPeg,
      dexRow, nativePegQuote: brzQuote(0.2),
    });

    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual(withheldBrz);
  });

  it("withholds an above-peg native quote instead of opening a pending row", () => {
    const eurMeta: StablecoinMeta = { id: "ceur-celo", name: "Celo EUR", symbol: "EURm", flags: { ...usdMeta.flags, pegCurrency: "EUR" }, geckoId: "celo-euro" };
    const decision = decideDepegAsset({
      now: 1_750_259_200,
      asset: makeAsset({ id: "ceur-celo", symbol: "EURm", price: 1.16, priceSource: "coingecko", priceObservedAt: 1_750_259_140, priceObservedAtMode: "upstream", pegType: "peggedEUR", circulating: { celo: 22_000_000 } }),
      meta: eurMeta, ...clockedBenchmark("peggedEUR", 1.16, 1_750_259_140),
      nativePegQuote: { stablecoinId: "ceur-celo", geckoId: "celo-euro", pegCurrency: "EUR", price: 2.598389348610164, updatedAt: 1_750_259_200 - 60, derivation: tradedPair },
    });

    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([{ level: "warn", message: "[depeg] Withheld implausible EUR native quote for EURm: reason=native-quote-above-peg-reference-band" }]);
  });

  it("keeps an existing event open when the native quote still supports it", () => {
    const decision = decideDepegAsset({
      now: 1_750_259_200, asset: brzAsset(0.18765951), meta: brlMeta, existing: makeExistingEvent(), nativePegQuote: brzQuote(1.02),
      ...clockedBenchmark("peggedREAL", 0.18765951, 1_750_259_140),
    });

    expect(decision.trackedCoinId).toBe("brz-transfero");
    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toHaveLength(0);
    expect(decision.diagnostics).toEqual([{ level: "warn", message: "[depeg] Kept BRZ open despite primary recovery: primary=0bps but BRL quote=200bps" }]);
  });

  it("recovers a native-domain row from its native quote under a nominal USD primary", () => {
    const meta = zarMeta;

    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset({
        id: "zarm-mento",
        symbol: "ZARm",
        pegType: "peggedZAR",
        price: 0.0552,
        priceSource: "protocol-par",
        priceConfidence: null,
        priceObservedAt: null,
        priceUpdatedAt: null,
        priceObservedAtMode: "nominal_reference",
        circulating: { celo: 2_000_000 },
      }),
      meta,
      existing: makeExistingEvent({
        id: 7,
        stablecoin_id: "zarm-mento",
        symbol: "ZARm",
        peg_type: "peggedZAR",
        direction: "below",
        peak_deviation_bps: -400,
        started_at: 1_750_260_100 - 3_600,
        start_price: 0.96,
        peak_price: 0.96,
        peg_reference: 1,
        recovery_evidence_source: "native", recovery_first_seen_at: 1_750_260_100 - 1_000,
        recovery_last_seen_at: 1_750_260_100 - 450,
      }),
      pegRates: { peggedZAR: 0.0552 },
      pegRateSources: { peggedZAR: "fx" },
      pegRateCounts: { peggedZAR: 4 },
      nativePegQuote: { stablecoinId: "zarm-mento", geckoId: "celo-south-african-rand", pegCurrency: "ZAR", price: 0.999, updatedAt: 1_750_260_040, derivation: tradedPair },
    });

    expect(decision.commands).toEqual([{ type: "close-event", id: 7, endedAt: 1_750_260_100, recoveryPrice: 0.999, recoveryPegReference: 1, closeReason: "recovered-native" }]);
  });

  it("closes a native-peg event after sustained recovery in native units", () => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset({ id: "brz-transfero", symbol: "BRZ", price: 0.1919, pegType: "peggedREAL" }),
      meta: brlMeta,
      existing: makeExistingEvent({
        direction: "below",
        peak_deviation_bps: -242,
        start_price: 0.9758,
        peak_price: 0.9758,
        peg_reference: 1,
        recovery_evidence_source: "native", recovery_first_seen_at: 1_750_259_140,
        recovery_last_seen_at: 1_750_259_200,
      }),
      ...brlPeg,
      nativePegQuote: { stablecoinId: "brz-transfero", geckoId: "brz", pegCurrency: "BRL", price: 0.997, updatedAt: 1_750_260_040, derivation: tradedPair },
    });

    expect(decision.commands).toEqual([{ type: "close-event", id: 7, endedAt: 1_750_260_100, recoveryPrice: 0.997, recoveryPegReference: 1, closeReason: "recovered-native" }]);
  });

  it.each(["pyth", "coingecko"])("closes a USD-domain row from native-only recovery without inventing a USD price (%s)", (priceSource) => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset({
        id: "brz-transfero", symbol: "BRZ", price: 0.18, pegType: "peggedREAL",
        priceSource, priceUpdatedAt: 1_750_260_040, priceObservedAtMode: "upstream", priceObservedAt: 1_750_260_040,
      }),
      meta: brlMeta,
      existing: makeExistingEvent({ quote_mode: "usd", direction: "below", peg_reference: 0.19, recovery_evidence_source: "native", recovery_first_seen_at: 1_750_259_140, recovery_last_seen_at: 1_750_259_200 }),
      ...clockedBenchmark("peggedREAL", 0.19, 1_750_260_040),
      nativePegQuote: { stablecoinId: "brz-transfero", geckoId: "brz", pegCurrency: "BRL", price: 1, updatedAt: 1_750_260_040, derivation: tradedPair },
    });
    expect(decision.commands).toEqual([{
      type: "close-event", id: 7, endedAt: 1_750_260_100,
      recoveryPrice: null, recoveryPegReference: null, closeReason: "recovered-native",
    }]);
  });

  it("holds a native-peg event open when the native quote is missing", () => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset({ id: "brz-transfero", symbol: "BRZ", price: 0.1919, pegType: "peggedREAL" }),
      meta: brlMeta,
      existing: makeExistingEvent({ direction: "below", peak_deviation_bps: -242, start_price: 0.9758, peak_price: 0.9758, peg_reference: 1 }),
      ...brlPeg,
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([]);
  });

  it("does not supersede a native event from an opposite USD-domain signal", () => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset({ id: "brz-transfero", symbol: "BRZ", price: 0.195, pegType: "peggedREAL" }),
      meta: brlMeta,
      existing: makeExistingEvent({ direction: "below", peak_deviation_bps: -242, start_price: 0.9758, peak_price: 0.9758, peg_reference: 1 }),
      ...brlPeg,
      nativePegQuote: { stablecoinId: "brz-transfero", geckoId: "brz", pegCurrency: "BRL", price: 0.9758, updatedAt: 1_750_260_040, derivation: tradedPair },
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).not.toContainEqual(expect.objectContaining({ type: "close-event", closeReason: "superseded-direction" }));
  });

  it("supersedes a native-peg event when the native quote reverses direction", () => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset({ id: "brz-transfero", symbol: "BRZ", price: 0.1919, pegType: "peggedREAL" }),
      meta: brlMeta,
      existing: makeExistingEvent({ direction: "below", peak_deviation_bps: -242, start_price: 0.9758, peak_price: 0.9758, peg_reference: 1 }),
      ...brlPeg,
      nativePegQuote: { stablecoinId: "brz-transfero", geckoId: "brz", pegCurrency: "BRL", price: 1.03, updatedAt: 1_750_260_040, derivation: tradedPair },
    });

    expect(decision.seenEventIds).toEqual([]);
    expect(decision.commands).toEqual([
      { type: "close-event", id: 7, endedAt: 1_750_260_040, recoveryPrice: null, closeReason: "superseded-direction" },
      expect.objectContaining({
        type: "upsert-pending",
        payload: expect.objectContaining({ stablecoinId: "brz-transfero", direction: "above", bps: 300, price: 1.03, pegReference: 1, reason: expect.stringContaining("native-origin") }),
      }),
    ]);
  });

  it("keeps a live event when an untrusted primary reading reverses direction", () => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset({ price: 1.02, priceSource: "cached", priceConfidence: "low" }),
      meta: usdMeta,
      existing: makeUsdEvent({}),
      ...usdPeg,
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Kept live event for USDT (id=7) through confirm-required opposite reading: existing=below, primary=above (200bps)",
      },
    ]);
  });

  it("closes a live event when circulating coverage falls below the event floor", () => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset({ circulating: { ethereum: 1 } }),
      meta: usdMeta,
      existing: makeUsdEvent({}, false),
      ...usdPeg,
    });

    expect(decision.seenEventIds).toEqual([]);
    expect(decision.commands).toEqual([{ type: "close-event", id: 7, endedAt: 1_750_260_100, recoveryPrice: null, closeReason: "coverage-lost-supply" }]);
    expect(decision.diagnostics).toEqual([
      {
        level: "log",
        message: "[depeg] Closing live event for USDT: supply $1 is below the live-event floor",
      },
    ]);
  });

  it.each<{ label: string; circulating: Record<string, number> }>([
    { label: "absent buckets", circulating: {} },
    { label: "wholly invalid buckets", circulating: { ethereum: Number.NaN } },
  ])("keeps a live event open when current supply is unavailable ($label)", ({ circulating }) => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset({ circulating }),
      meta: usdMeta,
      existing: makeUsdEvent({}, false),
      ...usdPeg,
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Kept live event for USDT open: current supply is unavailable, so the live-event floor cannot be assessed",
      },
    ]);
  });

  it("still closes a live event on an explicit observed zero supply", () => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset({ circulating: { ethereum: 0 } }),
      meta: usdMeta,
      existing: makeUsdEvent({}, false),
      ...usdPeg,
    });

    expect(decision.commands).toEqual([{ type: "close-event", id: 7, endedAt: 1_750_260_100, recoveryPrice: null, closeReason: "coverage-lost-supply" }]);
  });

  it("preserves a live event when a thin fiat peg reference is not authoritative", () => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset({ id: "brz-transfero", symbol: "BRZ", price: 0.1919, pegType: "peggedREAL" }),
      meta: brlMeta,
      existing: makeExistingEvent(),
      pegRates: { peggedREAL: 0.191895 },
      pegRateSources: { peggedREAL: "median" },
      pegRateCounts: { peggedREAL: 2 },
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Skipped live-state mutation for BRZ: thin BRL peg reference lacks FX fallback",
      },
    ]);
  });

  it("keeps an ongoing event open when only the aggregate DEX price disagrees", () => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset(),
      meta: usdMeta,
      existing: makeUsdEvent({ started_at: 1_750_256_500 }),
      ...usdPeg,
      dexRow: makeDexRow(1.001, { source_pool_count: 5, }),
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] DEX disagrees with ongoing event for USDT: primary=-200bps vs DEX=10bps (event age 60min); keeping event open until the recovery path confirms resolution",
      },
    ]);
  });

  it("suppresses a new event when legacy USD rows have a confirming DEX protocol quorum", () => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset({ priceSource: "dex-promoted" }),
      meta: usdMeta,
      ...usdPeg,
      dexRow: makeDexRow(0.999),
      protocolSources: [
        { protocol: "curve", chain: "ethereum", sourceFamily: "curve", price: 0.999, tvl: 2_500_000, observedAt: 1_750_260_040, updatedAt: 1_750_260_040 },
        { protocol: "uniswap-v3", chain: "ethereum", sourceFamily: "uniswap-v3", price: 1.001, tvl: 2_500_000, observedAt: 1_750_260_040, updatedAt: 1_750_260_040 },
      ],
    });

    expect(decision.seenEventIds).toEqual([]);
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([
      {
        level: "log",
        message: "[depeg] Suppressed new event for USDT: primary=-200bps but DEX=10bps (2 pools, $5.0M TVL)",
      },
    ]);
  });

  it("clears recovery progress when independent DEX protocols still show the depeg", () => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset({ price: 1.001 }),
      meta: usdMeta,
      existing: makeUsdEvent({ recovery_first_seen_at: 1_750_259_500, recovery_last_seen_at: 1_750_260_040 }),
      ...usdPeg,
      dexRow: makeDexRow(0.98),
      protocolSources: [
        { protocol: "curve", chain: "ethereum", sourceFamily: "curve", price: 0.98, tvl: 2_500_000, observedAt: 1_750_260_040, updatedAt: 1_750_260_040 },
        { protocol: "uniswap-v3", chain: "ethereum", sourceFamily: "uniswap-v3", price: 0.981, tvl: 2_500_000, observedAt: 1_750_260_040, updatedAt: 1_750_260_040 },
      ],
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([{ type: "clear-recovery", id: 7 }]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Kept USDT open despite primary recovery: primary recovery is contradicted by 2 DEX protocol group(s) still showing the below depeg",
      },
    ]);
  });

  it("keeps a recovered reading open when DEX recovery lacks independent support", () => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset({ price: 1.001, priceSource: "cached", priceConfidence: "low" }),
      meta: usdMeta,
      existing: makeUsdEvent({}),
      ...usdPeg,
      dexRow: makeDexRow(0.999, { source_pool_count: 1, }),
      protocolSources: [{ protocol: "curve", chain: "ethereum", sourceFamily: "curve", price: 0.999, tvl: 5_000_000, observedAt: 1_750_260_040, updatedAt: 1_750_260_040 }],
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Ignored aggregate DEX recovery for USDT: 1 corroborating protocol group(s), challenged=false; keeping event open until corroborated recovery appears",
      },
    ]);
  });

  it("continues recovery after a recent confirming observation", () => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset({ price: 1.001 }),
      meta: usdMeta,
      existing: makeUsdEvent({ recovery_first_seen_at: 1_750_259_800, recovery_last_seen_at: 1_750_260_040 }),
      ...usdPeg,
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([{ type: "continue-recovery", id: 7, lastSeenAt: 1_750_260_100 }]);
  });

  it("clears recovery progress when the primary price returns to the depeg", () => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset(),
      meta: usdMeta,
      existing: makeUsdEvent({ peak_deviation_bps: -300, peak_price: 0.97, recovery_first_seen_at: 1_750_259_800, recovery_last_seen_at: 1_750_260_040 }),
      ...usdPeg,
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([{ type: "clear-recovery", id: 7 }]);
  });

  it("keeps an event open until the full recovery window elapses", () => {
    const now = 1_750_260_100;
    const tolerance = DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC;
    const decisions = [tolerance - 1, tolerance, tolerance + 1].map((gap) => decideDepegAsset({
      now,
      asset: makeAsset({ price: 1.001 }),
      meta: usdMeta,
      existing: makeUsdEvent({ recovery_first_seen_at: now - gap - 900, recovery_last_seen_at: now - gap }),
      ...usdPeg,
    }));

    expect(decisions[0]?.commands[0]?.type).toBe("close-event");
    expect(decisions[1]?.commands[0]?.type).toBe("close-event");
    expect(decisions[2]?.commands).toEqual([{
      type: "begin-recovery",
      id: 7,
      firstSeenAt: now,
      lastSeenAt: now,
    }]);
  });

  it("clears a partial recovery when price returns to the deadband", () => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset({ price: 0.993 }),
      meta: usdMeta,
      existing: makeUsdEvent({ recovery_first_seen_at: 1_750_259_500 }),
      ...usdPeg,
    });

    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toEqual([{ type: "clear-recovery", id: 7 }]);
  });

  it("updates a native-peg event peak from the native quote domain", () => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset({ id: "brz-transfero", symbol: "BRZ", price: 0.1879, pegType: "peggedREAL" }),
      meta: brlMeta,
      existing: makeExistingEvent({ direction: "below", peak_deviation_bps: -242, start_price: 0.9758, peak_price: 0.9758, peg_reference: 1 }),
      ...brlPeg,
      nativePegQuote: { stablecoinId: "brz-transfero", geckoId: "brz", pegCurrency: "BRL", price: 0.97, updatedAt: 1_750_260_040, derivation: tradedPair },
    });

    expect(decision.commands).toMatchObject([{ type: "update-peak", id: 7, peakDeviationBps: -300, peakPrice: 0.97,
      peakPegReference: 1, peakQuoteDomain: "native-peg", peakReceipt: expect.stringContaining('"venue":"bitso"') }]);
  });

  it("updates a native-peg event peak when the USD primary is inside the trigger threshold", () => {
    const decision = decideDepegAsset({
      now: 1_750_260_100,
      asset: makeAsset({ id: "brz-transfero", symbol: "BRZ", price: 0.19, pegType: "peggedREAL" }),
      meta: brlMeta,
      existing: makeExistingEvent({ direction: "below", peak_deviation_bps: -242, start_price: 0.9758, peak_price: 0.9758, peg_reference: 1 }),
      ...brlPeg,
      nativePegQuote: { stablecoinId: "brz-transfero", geckoId: "brz", pegCurrency: "BRL", price: 0.95, updatedAt: 1_750_260_040, derivation: tradedPair },
    });

    expect(decision.observation).toEqual({ kind: "observed" });
    expect(decision.seenEventIds).toEqual([7]);
    expect(decision.commands).toContainEqual(expect.objectContaining({ type: "update-peak", id: 7, peakDeviationBps: -500,
      peakPrice: 0.95, peakPegReference: 1, peakQuoteDomain: "native-peg" }));
  });

  it("keeps an existing event open when a high-TVL pool challenger contradicts primary recovery", () => {
    const decision = decideDepegAsset({
      now: 1_780_630_000,
      asset: makeAsset({
        id: "apxusd-apyx",
        symbol: "apxUSD",
        price: 1.0006461557,
        priceSource: "coingecko+defillama-list",
        priceConfidence: "high",
        agreeSources: ["coingecko", "defillama-list"],
        priceUpdatedAt: 1_780_629_940,
        circulating: { ethereum: 353_000_000 },
      }),
      meta: { ...usdMeta, id: "apxusd-apyx", name: "apxUSD", symbol: "apxUSD", geckoId: "apxusd" },
      existing: makeExistingEvent({
        id: 90089,
        stablecoin_id: "apxusd-apyx",
        symbol: "apxUSD",
        peg_type: "peggedUSD",
        direction: "below",
        peak_deviation_bps: -1059,
        started_at: 1_780_437_028,
        start_price: 0.9892624763,
        peak_price: 0.8938719491,
        peg_reference: 1,
      }),
      ...usdPeg,
      challengerPools: [{ price: 0.952866583, tvlUsd: 52_000_000, protocol: "curve", chain: "ethereum", sourceFamily: "geckoterminal" }],
    });

    expect(decision.trackedCoinId).toBe("apxusd-apyx");
    expect(decision.seenEventIds).toEqual([90089]);
    expect(decision.commands).toHaveLength(0);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Kept apxUSD open despite primary recovery: pool challengers still show the below depeg (groups=1, corroborating=0, highTvl=true)",
      },
    ]);
  });

  it("allows authoritative primary recovery when only one small pool challenger disagrees", () => {
    const decision = decideDepegAsset({
      now: 1_780_630_000,
      asset: makeAsset({
        price: 1.0006,
        priceSource: "coingecko+defillama-list",
        priceConfidence: "high",
        agreeSources: ["coingecko", "defillama-list"],
        priceUpdatedAt: 1_780_629_940,
        circulating: { ethereum: 353_000_000 },
      }),
      meta: usdMeta,
      existing: makeUsdEvent({ id: 42, peak_deviation_bps: -250, started_at: 1_780_600_000 }),
      ...usdPeg,
      challengerPools: [{ price: 0.985, tvlUsd: 250_000, protocol: "curve", chain: "ethereum", sourceFamily: "geckoterminal" }],
    });

    expect(decision.seenEventIds).toEqual([42]);
    expect(decision.commands).toEqual([{ type: "begin-recovery", id: 42, firstSeenAt: 1_780_630_000, lastSeenAt: 1_780_630_000 }]);
  });

  it("allows primary recovery when two dormant diverging pools are outvoted by four at-peg pools", () => {
    const now = 1_790_226_624;
    const decision = decideDepegAsset({
      now,
      asset: makeAsset({
        id: "vchf-vnx",
        symbol: "VCHF",
        price: 1.2130161427,
        priceSource: "coingecko+defillama-list",
        priceConfidence: "high",
        agreeSources: ["coingecko", "defillama-list"],
        priceUpdatedAt: now - 60, priceObservedAt: now - 60, priceObservedAtMode: "upstream",
        pegType: "peggedCHF",
        circulating: { ethereum: 5_000_000 },
      }),
      meta: chfMeta,
      existing: makeExistingEvent({
        id: 90792,
        stablecoin_id: "vchf-vnx",
        symbol: "VCHF",
        peg_type: "peggedCHF",
        direction: "above",
        peak_deviation_bps: 640,
        started_at: now - 6 * 86_400,
        start_price: 1.2887194119,
        peak_price: 1.2887194119,
        peg_reference: 1.2128709869131222,
      }),
      ...clockedBenchmark("peggedCHF", 1.2128709869131222, now - 60, "fx"),
      // Reproduced 2026-09-24 from dex_price_challengers for vchf-vnx: the two
      // diverging venues are the dormant Celo Uniswap v3 pool (24h volume 0,
      // provider-reported $4.7M reserve, last trade 2026-03-15) and the
      // zero-volume ICP kongswap pool; four live protocols sat at the reference.
      challengerPools: [
        { price: 1.2887194119, tvlUsd: 4_712_969.3671, protocol: "uniswap-v3", chain: "celo", sourceFamily: "cg_onchain" },
        { price: 1.2745982598, tvlUsd: 380_730.3996, protocol: "kongswap", chain: "icp", sourceFamily: "cg_onchain" },
        { price: 1.2130161427, tvlUsd: 524_244.1538, protocol: "icpswap", chain: "icp", sourceFamily: "cg_onchain" },
        { price: 1.2211210441, tvlUsd: 414_750.15, protocol: "raydium", chain: "solana", sourceFamily: "direct_api" },
        { price: 1.2180939432, tvlUsd: 184_761.4457, protocol: "aerodrome", chain: "base", sourceFamily: "direct_api" },
        { price: 1.2000335351, tvlUsd: 130_340.6422, protocol: "meteora", chain: "solana", sourceFamily: "cg_onchain" },
      ],
    });

    expect(decision.trackedCoinId).toBe("vchf-vnx");
    expect(decision.seenEventIds).toEqual([90792]);
    expect(decision.commands).toEqual([{ type: "begin-recovery", id: 90792, firstSeenAt: now - 60, lastSeenAt: now - 60 }]);
    expect(decision.diagnostics).toEqual([]);
  });

  it.each(["clockless", "pre-reopen", "current"])("requires the %s challenger quote to pass its own FX admission for a recovery veto", (clock) => {
    const reopen = Date.UTC(2026, 10, 15, 22) / 1_000;
    const now = reopen + 120;
    const at = now - 30;
    const decision = decideDepegAsset({
      ...clockedBenchmark("peggedREAL", 1, now - 60), now, meta: brlMeta,
      asset: brzAsset(1, { priceObservedAt: at, priceUpdatedAt: at }),
      existing: makeExistingEvent({ started_at: reopen - 86_400, direction: "below", peak_deviation_bps: -300, peg_reference: 1, quote_mode: "usd" }),
      challengerPools: [{ price: 0.97, tvlUsd: 6_000_000, protocol: "curve", chain: "ethereum", sourceFamily: "dl",
        observedAt: clock === "current" ? at : clock === "pre-reopen" ? reopen - 15 : undefined }],
    });
    expect(decision.commands.map((command) => command.type)).toEqual(clock === "current" ? [] : ["begin-recovery"]);
  });

  it("keeps an event open when the diverging pools are the majority against the recovered price", () => {
    const now = 1_780_630_000;
    const decision = decideDepegAsset({
      now,
      asset: makeAsset({
        price: 1.0004,
        priceSource: "coingecko+defillama-list",
        priceConfidence: "high",
        agreeSources: ["coingecko", "defillama-list"],
        priceUpdatedAt: now - 60,
        circulating: { ethereum: 353_000_000 },
      }),
      meta: usdMeta,
      existing: makeUsdEvent({ id: 42, direction: "above", peak_deviation_bps: 250, started_at: now - 3_600, start_price: 1.025, peak_price: 1.025 }),
      ...usdPeg,
      challengerPools: [
        { price: 1.02, tvlUsd: 1_000_000, protocol: "curve", chain: "ethereum", sourceFamily: "geckoterminal" },
        { price: 1.021, tvlUsd: 1_000_000, protocol: "uniswap-v3", chain: "ethereum", sourceFamily: "cg_onchain" },
        { price: 1.0005, tvlUsd: 1_000_000, protocol: "raydium", chain: "solana", sourceFamily: "direct_api" },
      ],
    });

    expect(decision.seenEventIds).toEqual([42]);
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Kept USDT open despite primary recovery: pool challengers still show the above depeg (groups=2, corroborating=1, highTvl=false)",
      },
    ]);
  });

  it("keeps the diverging set decisive on a tie against corroborating pools", () => {
    const now = 1_780_630_000;
    const decision = decideDepegAsset({
      now,
      asset: makeAsset({
        price: 1.0004,
        priceSource: "coingecko+defillama-list",
        priceConfidence: "high",
        agreeSources: ["coingecko", "defillama-list"],
        priceUpdatedAt: now - 60,
        circulating: { ethereum: 353_000_000 },
      }),
      meta: usdMeta,
      existing: makeUsdEvent({ id: 42, direction: "above", peak_deviation_bps: 250, started_at: now - 3_600, start_price: 1.025, peak_price: 1.025 }),
      ...usdPeg,
      challengerPools: [
        { price: 1.02, tvlUsd: 1_000_000, protocol: "curve", chain: "ethereum", sourceFamily: "geckoterminal" },
        { price: 1.021, tvlUsd: 1_000_000, protocol: "uniswap-v3", chain: "ethereum", sourceFamily: "cg_onchain" },
        { price: 1.0005, tvlUsd: 1_000_000, protocol: "raydium", chain: "solana", sourceFamily: "direct_api" },
        { price: 0.9995, tvlUsd: 1_000_000, protocol: "orca", chain: "solana", sourceFamily: "cg_onchain" },
      ],
    });

    expect(decision.seenEventIds).toEqual([42]);
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Kept USDT open despite primary recovery: pool challengers still show the above depeg (groups=2, corroborating=2, highTvl=false)",
      },
    ]);
  });

  it.each([undefined, 1_790_231_400])("keeps soft-source recovery open with publication-only challenger time %s", (observedAt) => {
    // Reproduced 2026-09-24 from live D1 (event 90781, usdb-blast). The coin's
    // only primary lane is a fresh CoinGecko single-source print, and
    // computeDexPrices withholds its aggregate dex_prices row because
    // loadTrackedStablecoinMaps preloads only prices that already clear the
    // primary trust gates — so the aggregate-DEX recovery lane was structurally
    // unreachable. All five published challenger pools (thruster-v3,
    // monoswap-v3-blast, blasterswap) sat inside the 50 bps recovery band.
    const now = 1_790_231_427;
    const decision = decideDepegAsset({
      now,
      asset: makeAsset({
        id: "usdb-blast",
        symbol: "USDB",
        price: 0.9998628369821569,
        priceSource: "coingecko",
        agreeSources: ["coingecko"],
        priceUpdatedAt: now - 107,
        priceObservedAt: now - 107,
        priceObservedAtMode: "upstream",
        circulating: { blast: 11_348_078.487122247 },
      }),
      meta: { ...usdMeta, id: "usdb-blast", name: "USDB Blast", symbol: "USDB", geckoId: "usdb" },
      existing: makeExistingEvent({
        id: 90781,
        stablecoin_id: "usdb-blast",
        symbol: "USDB",
        peg_type: "peggedUSD",
        direction: "above",
        peak_deviation_bps: 129,
        started_at: 1_787_295_709,
        start_price: 1.0102326760456513,
        peak_price: 1.0129092357526068,
        peg_reference: 0.999963,
        recovery_first_seen_at: now - 1_000,
        recovery_last_seen_at: now - 450,
      }),
      ...usdPeg,
      challengerPools: [
        { price: 0.995936075327477, tvlUsd: 1_047_212.8546, protocol: "thruster-v3", chain: "blast", sourceFamily: "cg_onchain", observedAt },
        { price: 0.997280614842842, tvlUsd: 290_687.4629, protocol: "thruster-v3", chain: "blast", sourceFamily: "cg_onchain", observedAt },
        { price: 0.999821125971321, tvlUsd: 157_208.1985, protocol: "thruster-v3", chain: "blast", sourceFamily: "cg_onchain", observedAt },
        { price: 1.0007739191, tvlUsd: 108_478.947, protocol: "monoswap-v3-blast", chain: "blast", sourceFamily: "cg_onchain", observedAt },
        { price: 0.996110886724201, tvlUsd: 103_778.0611, protocol: "blasterswap", chain: "blast", sourceFamily: "cg_onchain", observedAt },
      ],
    });

    expect(decision.seenEventIds).toEqual([90781]);
    expect(decision.commands).toEqual([{ type: "continue-recovery", id: 90781, lastSeenAt: now - 107 }]);
    expect(decision.diagnostics).toEqual([]);
  });

  it("keeps gold-peg recovery open without original challenger observation times", () => {
    const now = 1_790_231_427;
    const decision = decideDepegAsset({
      now,
      asset: makeAsset({
        id: "vnxau-vnx",
        symbol: "VNXAU",
        price: 137.80559627497053,
        priceSource: "coingecko",
        agreeSources: ["coingecko"],
        priceUpdatedAt: now - 77,
        priceObservedAt: now - 77,
        priceObservedAtMode: "upstream",
        pegType: "peggedGOLD",
        circulating: { ethereum: 6_063_570.880773928 },
      }),
      meta: goldMeta,
      existing: makeExistingEvent({
        id: 90760,
        stablecoin_id: "vnxau-vnx",
        symbol: "VNXAU",
        peg_type: "peggedGOLD",
        direction: "below",
        peak_deviation_bps: -178,
        started_at: 1_785_939_393,
        start_price: 133.18916240810498,
        peak_price: 133.36101778049144,
        peg_reference: 135.77096114706222,
        recovery_first_seen_at: now - 1_000,
        recovery_last_seen_at: now - 450,
      }),
      ...clockedBenchmark("peggedGOLD", 4285, now - 60, "fallback"),
      challengerPools: [
        { price: 137.508294070839, tvlUsd: 263_932, protocol: "raydium", chain: "solana", sourceFamily: "direct_api" },
        { price: 138.145893, tvlUsd: 103_282, protocol: "aerodrome", chain: "base", sourceFamily: "direct_api" },
      ],
    });

    expect(decision.seenEventIds).toEqual([90760]);
    expect(decision.commands).toEqual([{ type: "continue-recovery", id: 90760, lastSeenAt: now - 77 }]);
    expect(decision.diagnostics).toEqual([]);
  });

  it.each([
    ["begins", null, null, false, ["begin-recovery"]],
    ["continues under 24 h", 3_600, 600, false, ["continue-recovery"]],
    ["closes at 24 h", 86_460, 600, false, ["close-event"]],
    ["begins DEX recovery with agreeing primary", null, null, "agreeing-dex", ["begin-recovery"]],
    ["continues primary recovery with only one fresh DEX family", 3_600, 600, "one-family", ["continue-recovery"]],
    ["finishes primary recovery with agreeing DEX", 86_460, 900, "agreeing-dex", ["close-event"]],
    ["stops on a pool veto", 3_600, 600, "pool", ["clear-recovery"]],
    ["stops on a stale liquid DEX lane", 3_600, 600, "dex", ["clear-recovery"]],
    ["stops on a fresh DEX outside the band", 3_600, 600, "band", ["clear-recovery"]],
    ["stops on a raw 50.4 bps DEX reading", 86_460, 600, "raw", ["clear-recovery"]],
    ["stops on an unclocked liquid FX DEX row", 86_460, 600, "unclocked-fx", ["clear-recovery"]],
    ["needs an upstream-dated quote", 3_600, 600, "local", ["clear-recovery"]],
  ] as const)("sustained single-source recovery %s", (_label, firstSeenAge, lastSeenAge, veto, expected) => {
    const now = 1_790_231_427; // Thursday
    const fx = veto === "unclocked-fx";
    const decision = decideDepegAsset({
      now, meta: fx ? brlMeta : usdMeta, ...(fx ? clockedBenchmark("peggedREAL", 0.191, now - 60) : usdPeg),
      asset: makeAsset({ price: fx ? 0.1909 : 0.999, pegType: fx ? "peggedREAL" : "peggedUSD", priceSource: "coingecko", priceConfidence: "single-source", priceObservedAtMode: veto === "local" ? "local_fetch" : "upstream",
        priceObservedAt: now - 60, circulating: { ethereum: 5_000_000 } }),
      existing: makeUsdEvent(firstSeenAge == null ? {} : { recovery_first_seen_at: now - firstSeenAge, recovery_last_seen_at: now - (lastSeenAge ?? 0) }),
      challengerPools: veto === "pool"
        ? [{ price: 0.98, tvlUsd: 6_000_000, protocol: "curve", chain: "ethereum", sourceFamily: "cg_onchain" }]
        : undefined,
      protocolSources: veto === "agreeing-dex" || veto === "one-family" ? (veto === "one-family" ? ["curve"] : ["curve", "uniswap"]).map((protocol) => ({
        protocol, sourceFamily: protocol, chain: "ethereum", price: 0.999, tvl: 2_500_000, observedAt: now - 120, updatedAt: now - 60,
      })) : undefined,
      ...(veto === "dex" || veto === "band" || veto === "raw" || veto === "agreeing-dex" || veto === "one-family" || fx ? { dexRow: makeDexRow(fx ? 0.1909 : veto === "raw" ? 0.99496 : veto === "dex" || veto === "agreeing-dex" || veto === "one-family" ? 0.999 : 0.992,
        { updated_at: now - (veto === "dex" ? 7_200 : 60), aggregateObservedAt: fx ? null : now - (veto === "dex" ? 7_200 : 60) }) } : {}),
    });
    expect(decision.commands.map(({ type }) => type)).toEqual(expected);
    if (veto === "agreeing-dex" && expected[0] === "begin-recovery") {
      expect(decision.commands[0]).toEqual({ type: "begin-recovery", id: 7, firstSeenAt: now - 60, lastSeenAt: now - 60, source: "dex" });
    }
    if (expected[0] === "close-event") {
      expect(decision.commands[0]).toMatchObject({ recoveryPrice: 0.999, recoveryPegReference: 1, closeReason: "recovered-primary" });
      expect(decision.diagnostics).toEqual([{ level: "log", message: "[depeg] Closing live event for USDT after 24 h of sustained single-source recovery" }]);
    }
  });

  it.each([
    [134, goldMeta, { peggedGOLD: 4285 }, { kind: "unavailable", reason: "reference-market-closed" }, []],
    [100, goldMeta, { peggedGOLD: 4285 }, { kind: "observed" }, ["upsert-pending"]],
    [0.1919, brlMeta, brlPeg.pegRates, { kind: "unavailable", reason: "invalid-reference" }, []],
  ] as const)(
    "uses legacy closure policy only for benchmarks without reference evidence (price %s)",
    (price, meta, pegRates, observation, commands) => {
      const now = 1_794_758_400; // Sunday 16:00 UTC
      const decision = decideDepegAsset({
        now, asset: makeAsset({ id: meta.id, symbol: meta.symbol, price, priceUpdatedAt: now, pegType: `pegged${meta.flags.pegCurrency}` }), meta,
        pegRates, pegRateSources: { peggedGOLD: "median", peggedREAL: "median" }, pegRateCounts: { peggedGOLD: 4, peggedREAL: 3 },
      });
      expect(decision.observation).toEqual(observation);
      expect(decision.commands.map((command) => command.type)).toEqual(commands);
    },
  );

  it("keeps an in-band soft-source event open when a high-TVL challenger pool still shows the depeg", () => {
    // Reproduced 2026-09-24 from live D1 (event 90786, hollar-hydrated): the
    // low-confidence CoinGecko print sat at -18 bps while every published
    // hydration-dex pool still printed ~-526 bps, one of them above the $5M
    // single-pool challenge carve-out.
    const now = 1_790_231_427;
    const decision = decideDepegAsset({
      now,
      asset: makeAsset({
        id: "hollar-hydrated",
        symbol: "HOLLAR",
        price: 0.9981523059225438,
        priceSource: "coingecko",
        priceConfidence: "low",
        agreeSources: ["coingecko"],
        priceUpdatedAt: now - 77,
        priceObservedAt: now - 77,
        priceObservedAtMode: "upstream",
        circulating: { hydration: 12_833_596.24937689 },
      }),
      meta: { ...usdMeta, id: "hollar-hydrated", name: "Hydrated Dollar", symbol: "HOLLAR", geckoId: "hydrated-dollar" },
      existing: makeExistingEvent({
        id: 90786,
        stablecoin_id: "hollar-hydrated",
        symbol: "HOLLAR",
        peg_type: "peggedUSD",
        direction: "below",
        peak_deviation_bps: -525,
        started_at: 1_787_695_308,
        start_price: 0.947458,
        peak_price: 0.947458,
        peg_reference: 1,
        recovery_first_seen_at: now - 1_000,
        recovery_last_seen_at: now - 450,
      }),
      ...usdPeg,
      challengerPools: [
        { price: 0.9474579112, tvlUsd: 11_916_235.7742, protocol: "hydration-dex", chain: "hydration", sourceFamily: "cg_onchain" },
        { price: 0.9474396418, tvlUsd: 2_460_799.2408, protocol: "hydration-dex", chain: "hydration", sourceFamily: "cg_onchain" },
        { price: 0.9474579112, tvlUsd: 2_255_904.79, protocol: "hydration-dex", chain: "hydration", sourceFamily: "cg_onchain" },
        { price: 0.947411, tvlUsd: 746_895.7, protocol: "hydration-dex", chain: "hydration", sourceFamily: "cg_onchain" },
      ],
    });

    expect(decision.seenEventIds).toEqual([90786]);
    expect(decision.commands).toEqual([{ type: "clear-recovery", id: 90786 }]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Kept HOLLAR open despite primary recovery: pool challengers still show the below depeg (groups=1, corroborating=0, highTvl=true)",
      },
    ]);
  });

  it("keeps an in-band soft-source event open when only one challenger group corroborates the band", () => {
    // Reproduced 2026-09-24 from live D1 (event 90777, audf-forte): the single
    // published curve pool (-24 bps) is corroboration, but one group is below
    // the POOL_CHALLENGE_CONFIRM_MIN bar for carrying a recovery.
    const now = 1_790_231_427;
    const decision = decideDepegAsset({
      now,
      asset: makeAsset({
        id: "audf-forte",
        symbol: "AUDF",
        price: 0.7030877342041957,
        priceSource: "coingecko",
        agreeSources: ["coingecko"],
        priceUpdatedAt: now - 77,
        priceObservedAt: now - 77,
        priceObservedAtMode: "upstream",
        pegType: "peggedAUD",
        circulating: { ethereum: 3_566_436.4980290816 },
      }),
      meta: {
        ...usdMeta,
        id: "audf-forte",
        name: "Forte AUD",
        symbol: "AUDF",
        geckoId: "forte-aud",
        flags: { ...usdMeta.flags, pegCurrency: "AUD" },
      },
      existing: makeExistingEvent({
        id: 90777,
        stablecoin_id: "audf-forte",
        symbol: "AUDF",
        peg_type: "peggedAUD",
        direction: "below",
        peak_deviation_bps: -287,
        started_at: 1_786_944_681,
        start_price: 0.9849393364193147,
        peak_price: 0.699732524541874,
        peg_reference: 0.71128258,
      }),
      ...clockedBenchmark("peggedAUD", 0.7067137809187279, now - 60, "fx"),
      challengerPools: [{ price: 0.704981734354013, tvlUsd: 111_651.66302719248, protocol: "curve", chain: "ethereum", sourceFamily: "dl" }],
    });

    expect(decision.seenEventIds).toEqual([90777]);
    expect(decision.commands).toEqual([{ type: "begin-recovery", id: 90777, firstSeenAt: now - 77, lastSeenAt: now - 77 }]);
    expect(decision.diagnostics).toEqual([]);
  });

  it("requires the challenger corroborating groups to outvote the diverging set", () => {
    const now = 1_780_630_000;
    const makeDecision = (corroboratingPools: Array<{ price: number; tvlUsd: number; protocol: string; chain: string; sourceFamily: string }>) =>
      decideDepegAsset({
        now,
        asset: makeAsset({
          id: "dusd-test",
          symbol: "DUSD",
          price: 0.9995,
          priceSource: "coingecko",
          agreeSources: ["coingecko"],
          priceUpdatedAt: now - 60,
          priceObservedAt: now - 60,
          priceObservedAtMode: "upstream",
          circulating: { ethereum: 5_000_000 },
        }),
        meta: { ...usdMeta, id: "dusd-test", name: "DUSD", symbol: "DUSD", geckoId: "dusd" },
        existing: makeExistingEvent({
          id: 55,
          stablecoin_id: "dusd-test",
          symbol: "DUSD",
          peg_type: "peggedUSD",
          direction: "below",
          peak_deviation_bps: -300,
          started_at: now - 86_400,
          start_price: 0.97,
          peak_price: 0.97,
          peg_reference: 1,
          recovery_first_seen_at: now - 1_000,
          recovery_last_seen_at: now - 450,
        }),
        ...usdPeg,
        challengerPools: [
          { price: 0.985, tvlUsd: 1_000_000, protocol: "curve", chain: "ethereum", sourceFamily: "cg_onchain" },
          { price: 0.986, tvlUsd: 1_000_000, protocol: "uniswap-v3", chain: "ethereum", sourceFamily: "cg_onchain" },
          ...corroboratingPools,
        ],
      });

    const tie = makeDecision([
      { price: 0.9985, tvlUsd: 1_000_000, protocol: "raydium", chain: "solana", sourceFamily: "direct_api" },
      { price: 0.999, tvlUsd: 1_000_000, protocol: "orca", chain: "solana", sourceFamily: "cg_onchain" },
    ]);
    expect(tie.commands).toEqual([{ type: "clear-recovery", id: 55 }]);
    expect(tie.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Kept DUSD open despite primary recovery: pool challengers still show the below depeg (groups=2, corroborating=2, highTvl=false)",
      },
    ]);

    const outvoted = makeDecision([
      { price: 0.9985, tvlUsd: 1_000_000, protocol: "raydium", chain: "solana", sourceFamily: "direct_api" },
      { price: 0.999, tvlUsd: 1_000_000, protocol: "orca", chain: "solana", sourceFamily: "cg_onchain" },
      { price: 0.9975, tvlUsd: 1_000_000, protocol: "meteora", chain: "solana", sourceFamily: "cg_onchain" },
    ]);
    expect(outvoted.commands).toEqual([{ type: "clear-recovery", id: 55 }]);
    expect(outvoted.diagnostics).toEqual([]);
  });

  it("does not bypass a challenged aggregate DEX lane with the pool-challenger majority", () => {
    const now = 1_780_630_000;
    const decision = decideDepegAsset({
      now,
      asset: makeAsset({
        id: "dusd-test",
        symbol: "DUSD",
        price: 1.0005,
        priceSource: "coingecko",
        agreeSources: ["coingecko"],
        priceUpdatedAt: now - 60,
        priceObservedAt: now - 60,
        priceObservedAtMode: "upstream",
        circulating: { ethereum: 5_000_000 },
      }),
      meta: { ...usdMeta, id: "dusd-test", name: "DUSD", symbol: "DUSD", geckoId: "dusd" },
      existing: makeExistingEvent({
        id: 55,
        stablecoin_id: "dusd-test",
        symbol: "DUSD",
        peg_type: "peggedUSD",
        direction: "above",
        peak_deviation_bps: 250,
        started_at: now - 86_400,
        start_price: 1.025,
        peak_price: 1.025,
        peg_reference: 1,
      }),
      ...usdPeg,
      dexRow: {
        stablecoin_id: "dusd-test",
        dex_price_usd: 1.0005,
        deviation_from_primary_bps: 5,
        source_pool_count: 3,
        source_total_tvl: 6_000_000,
        updated_at: now - 60,
        aggregateObservedAt: now - 60,
      },
      protocolSources: [
        { protocol: "curve", chain: "ethereum", sourceFamily: "dl", price: 1.0005, tvl: 3_000_000, updatedAt: now - 60, observedAt: now - 60 },
        { protocol: "uniswap-v3", chain: "ethereum", sourceFamily: "cg_onchain", price: 1.0006, tvl: 3_000_000, updatedAt: now - 60, observedAt: now - 60 },
      ],
      challengerPools: [
        { price: 1.02, tvlUsd: 200_000, protocol: "curve", chain: "ethereum", sourceFamily: "dl" },
        { price: 1.0004, tvlUsd: 150_000, protocol: "uniswap-v3", chain: "ethereum", sourceFamily: "cg_onchain" },
      ],
    });

    expect(decision.seenEventIds).toEqual([55]);
    expect(decision.commands).toEqual([]);
    expect(decision.diagnostics).toEqual([
      {
        level: "warn",
        message: "[depeg] Ignored aggregate DEX recovery for DUSD: 2 corroborating protocol group(s), challenged=true; keeping event open until corroborated recovery appears",
      },
    ]);
  });
});
