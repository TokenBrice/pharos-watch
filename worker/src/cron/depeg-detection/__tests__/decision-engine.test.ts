import { describe, expect, it, vi } from "vitest";
import type { PegAssetBase } from "@shared/types/price";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { REFERENCE_CLOSURE_HOLD_BANDS_BPS } from "@shared/lib/depeg-config";
import { DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC } from "@shared/lib/depeg-closure";
import { makeDepegRow } from "../../../test-helpers/__shared/fixtures";
import { decideDepegAsset, emitDepegDiagnostics } from "../decision-engine";
import type { DepegDetectionRow } from "../types";
import { attachDetectionReferenceContext } from "../reference-policy";
import { referenceState, tradedPair } from "./reference-fixtures";

const T0 = 1_750_259_200, T0_60 = T0 - 60, T1 = 1_750_260_100, T1_60 = T1 - 60, T2 = 1_780_630_000, T3 = 1_790_231_427;
const USDT = "usdt-tether", BRZ = "brz-transfero", D = 86_400;
const usdPeg = { pegRates: { peggedUSD: 1 }, pegRateSources: { peggedUSD: "median" as const }, pegRateCounts: { peggedUSD: 4 } };
const brlPeg = clockedBenchmark("peggedREAL", 0.191895, T0_60);

const usdMeta: StablecoinMeta = {
  id: USDT, name: "Tether", symbol: "USDT", geckoId: "tether",
  flags: { backing: "rwa-backed", pegCurrency: "USD", governance: "centralized", yieldBearing: false, rwa: true, navToken: false },
};
const makeMeta = (id: string, symbol: string, pegCurrency: StablecoinMeta["flags"]["pegCurrency"] = "USD", extra: Partial<StablecoinMeta> = {}): StablecoinMeta => ({
  ...usdMeta, id, name: symbol, symbol, geckoId: symbol.toLowerCase(), flags: { ...usdMeta.flags, pegCurrency }, ...extra,
});
const brlMeta = makeMeta(BRZ, "BRZ", "BRL", { name: "Brazilian Digital Token" });
const chfMeta = makeMeta("vchf-vnx", "VCHF", "CHF", { name: "VNX Swiss Franc", geckoId: "vnx-swiss-franc" });
const goldMeta = makeMeta("vnxau-vnx", "VNXAU", "GOLD", { name: "VNX Gold", geckoId: "vnx-gold", commodityOunces: 0.0321507466 });
// Local copy of ZARm metadata; PSI membership guarded by sync-stablecoins/__tests__/supply-gap-reconciliation.test.ts.
const zarMeta: StablecoinMeta = {
  id: "zarm-mento", name: "Mento South African Rand", symbol: "ZARm", geckoId: "celo-south-african-rand",
  flags: { backing: "crypto-backed", pegCurrency: "ZAR", governance: "centralized-dependent", yieldBearing: false, rwa: false, navToken: false },
};
const silverMeta: StablecoinMeta = { ...goldMeta, id: "xagm-matrixdock", commodityOunces: 1, flags: { ...goldMeta.flags, pegCurrency: "SILVER" } };

const usdInput = { now: T0, meta: usdMeta, ...usdPeg };
const weekend = Date.UTC(2026, 10, 14, 12) / 1_000;
const fridayBrlClose = Date.UTC(2026, 10, 13, 21, 55) / 1_000;
const peerVenues = ["binance", "coinbase", "kraken"];

function clockedBenchmark(peg: string, value: number, observedAt: number, kind: "fx" | "fallback" = "fx") {
  const pegRates = { [peg]: value };
  const fx = referenceState(pegRates, observedAt);
  attachDetectionReferenceContext(pegRates, [], new Map(), new Set(), fx, fx.repricingByPeg);
  return { pegRates, pegRateSources: { [peg]: kind }, pegRateCounts: { [peg]: 0 } };
}
const peerMetadata = (peers: PegAssetBase[], meta: StablecoinMeta) => new Map(peers.map(({ id }) => [id, meta]));

function makeAsset(overrides: Partial<PegAssetBase> = {}): PegAssetBase {
  return { id: USDT, symbol: "USDT", price: 0.98, priceSource: "pyth", priceConfidence: "single-source", priceUpdatedAt: T0_60, pegType: "peggedUSD", circulating: { ethereum: 50_000_000 }, ...overrides };
}
function makeExistingEvent(overrides: Partial<DepegDetectionRow> = {}): DepegDetectionRow {
  return {
    ...makeDepegRow({ id: 7, stablecoin_id: BRZ, symbol: "BRZ", peg_type: "peggedREAL", direction: "above", peak_deviation_bps: 180, started_at: T0 - 3600, start_price: 0.1909, peak_price: 0.191, peg_reference: 0.18765951 }),
    confirmation_sources: null, pending_reason: null, ...overrides,
  };
}
const makeDexRow = (dex_price_usd: number, overrides = {}) => ({
  dex_price_usd, stablecoin_id: USDT, deviation_from_primary_bps: null, source_pool_count: 2, source_total_tvl: 5_000_000, updated_at: T1_60, aggregateObservedAt: T1_60, ...overrides,
});
const makeUsdEvent = (overrides: Partial<DepegDetectionRow> = {}, pricing = true): DepegDetectionRow =>
  makeExistingEvent({ stablecoin_id: USDT, symbol: "USDT", peg_type: "peggedUSD", direction: "below", ...(pricing ? { peak_deviation_bps: -200, start_price: 0.98, peak_price: 0.98 } : {}), peg_reference: 1, ...overrides });

type DecIn = Parameters<typeof decideDepegAsset>[0];
const decide = decideDepegAsset;
const runUsd0 = (asset: Partial<PegAssetBase> = {}, extra: Partial<DecIn> = {}) => decide({ ...usdInput, asset: makeAsset(asset), ...extra });
const runUsd = (asset: Partial<PegAssetBase> = {}, extra: Partial<DecIn> = {}) => decide({ ...usdInput, now: T1, asset: makeAsset(asset), ...extra });
const runBrl = (price: number, extra: Partial<DecIn> = {}, assetExtra: Partial<PegAssetBase> = {}) =>
  decide({ now: T1, asset: makeAsset({ ...brzAssetFields, price, ...assetExtra }), meta: brlMeta, ...brlPeg, ...extra });

const upAt = (at: number) => ({ priceObservedAt: at, priceUpdatedAt: at, priceObservedAtMode: "upstream" as const });
const cgDlAsset = (price: number, at: number, extra: Partial<PegAssetBase> = {}) =>
  makeAsset({ price, priceSource: "coingecko+defillama-list", priceConfidence: "high", agreeSources: ["coingecko", "defillama-list"], priceUpdatedAt: at, circulating: { ethereum: 353_000_000 }, ...extra });
const cgUpAsset = (price: number, at: number, extra: Partial<PegAssetBase> = {}) =>
  makeAsset({ price, priceSource: "coingecko", agreeSources: ["coingecko"], ...upAt(at), ...extra });
const pool = (price: number, tvlUsd: number, protocol: string, chain = "ethereum", sourceFamily = "cg_onchain", observedAt?: number) =>
  ({ price, tvlUsd, protocol, chain, sourceFamily, ...(observedAt !== undefined ? { observedAt } : {}) });
const proto = (protocol: string, price: number, tvl = 2_500_000, at = T1_60, sourceFamily = protocol, extra: Record<string, unknown> = {}) =>
  ({ protocol, chain: "ethereum", sourceFamily, price, tvl, observedAt: at, updatedAt: at, ...extra });
const twoProtos = (p1: number, p2 = p1, tvl = 2_500_000, at = T1_60, second = "uniswap-v3") => [proto("curve", p1, tvl, at), proto(second, p2, tvl, at)];
const recWin = (now: number) => ({ recovery_first_seen_at: now - 1_000, recovery_last_seen_at: now - 450 });
const diag = (message: string, level: "warn" | "log" = "warn") => [{ level, message }];
const keptOpen = (sym: string, dir: "below" | "above", g: number, c: number, highTvl = false) =>
  diag(`[depeg] Kept ${sym} open despite primary recovery: pool challengers still show the ${dir} depeg (groups=${g}, corroborating=${c}, highTvl=${highTvl})`);
const closeCmd = (id: number, endedAt: number, closeReason: string, extra: Record<string, unknown> = {}) =>
  ({ type: "close-event", id, endedAt, recoveryPrice: null, closeReason, ...extra });

const brzAssetFields = { id: BRZ, symbol: "BRZ", pegType: "peggedREAL" } as const;
const brzNativeEvent = () => makeExistingEvent({ direction: "below", peak_deviation_bps: -242, start_price: 0.9758, peak_price: 0.9758, peg_reference: 1 });
const brzAsset = (price: number, overrides: Partial<PegAssetBase> = {}) => makeAsset({ ...brzAssetFields, price, priceObservedAt: T0_60, priceObservedAtMode: "upstream", ...overrides });
const brzQuote = (price: number, updatedAt = T0_60) => ({ stablecoinId: BRZ, geckoId: "brz", pegCurrency: "BRL", price, updatedAt, derivation: tradedPair });
const withheldBrz = diag("[depeg] Withheld implausible BRL native quote for BRZ: reason=native-quote-extreme-move");

function assertNativeOpening({ circulating, nativePrice, expectedBps, expectedReason, expectSeenEventIds = false, dexCorroboration, admitted = true }: {
  circulating: Record<string, number>; nativePrice: number; expectedBps: number; expectedReason: string; expectSeenEventIds?: boolean;
  dexCorroboration?: { price: number; tvl: number; aggregateObservedAt?: number }; admitted?: boolean;
}) {
  const d = decide({
    now: T0, asset: brzAsset(0.191187, { priceSource: "coingecko", circulating }), meta: brlMeta, ...brlPeg,
    dexRow: dexCorroboration && makeDexRow(dexCorroboration.price, { stablecoin_id: BRZ, source_total_tvl: dexCorroboration.tvl, updated_at: T0_60, aggregateObservedAt: dexCorroboration.aggregateObservedAt }),
    protocolSources: dexCorroboration && twoProtos(dexCorroboration.price, dexCorroboration.price, dexCorroboration.tvl, T0_60),
    nativePegQuote: brzQuote(nativePrice),
  });
  expect(d.trackedCoinId).toBe(BRZ);
  if (expectSeenEventIds) expect(d.seenEventIds).toEqual([]);
  if (!admitted) {
    expect(d.commands).toEqual([]);
    expect(d.diagnostics).toEqual(withheldBrz);
    return;
  }
  expect(d.commands).toHaveLength(1);
  expect(d.commands[0]).toMatchObject({ type: "upsert-pending", payload: { stablecoinId: BRZ, direction: "below", bps: expectedBps, price: nativePrice, pegReference: 1, reason: expectedReason } });
  expect(d.diagnostics).toEqual(diag(`[depeg] Pending native-peg confirmation for BRZ: ${expectedBps}bps against BRL quote`, "log"));
}

describe("decideDepegAsset", () => {
  it("does not build persistence from repeated polls of the same explicitly undated Kraken trade", () => {
    const asset = makeAsset({ price: 0.987, priceSource: "kraken", agreeSources: ["kraken"], priceObservedAt: null, priceUpdatedAt: null, priceObservedAtMode: "unknown" });
    for (const now of [T0, T0 + 900]) {
      const d = decide({ ...usdInput, now, asset: { ...asset, priceQuoteBasis: "last-trade" } });
      expect(d.observation).toEqual({ kind: "unavailable", reason: "primary-unusable" });
      expect(d.commands).toEqual([]);
    }
    expect(decide({ ...usdInput, asset }).commands).toMatchObject([{ type: "upsert-pending", payload: { price: 0.987, bps: -130 } }]);
  });

  it("keeps legacy fiat detection closed until Sunday 23:00 UTC", () => {
    const pegRates = { peggedEUR: 1.10 }, fx = referenceState(pegRates, Date.UTC(2026, 10, 20, 18, 30) / 1000, false);
    fx.sources = { frankfurter: "ok" };
    const meta = makeMeta("eurc-circle", "EURC", "EUR"), referenceContext = attachDetectionReferenceContext(pegRates, [], new Map(), new Set(), fx);
    for (const [hour, minute, expected] of [[22, 15, false], [23, 1, true]] as const) {
      const now = Date.UTC(2026, 10, 22, hour, minute) / 1000;
      const asset = makeAsset({ id: meta.id, symbol: meta.symbol, pegType: "peggedEUR", price: 1.067, priceSource: "coingecko", ...upAt(now - 60) });
      const d = decide({ now, asset, meta, pegRates, pegRateSources: { peggedEUR: "fx" }, pegRateCounts: {}, referenceContext });
      expect(d.commands).toMatchObject(expected ? [{ type: "upsert-pending", payload: { bps: -300 } }] : []);
    }
  });

  it("retains a dated reference hold only while the same market closure explains the coverage gap", () => {
    const close = Date.UTC(2026, 10, 13, 22) / 1000, now = close + 120;
    const existing = makeExistingEvent({
      started_at: close - 2000, direction: "below", peak_deviation_bps: -360, recovery_first_seen_at: close - 120, recovery_last_seen_at: close - 60,
      last_trusted_price_at: close - 60, price_coverage_gap_started_at: null,
      price_coverage_json: JSON.stringify({ intervals: [[close - 900, close - 60]], lastObservationKind: "trusted-off-peg" }),
    });
    const input = { now, existing, meta: brlMeta, ...clockedBenchmark("peggedREAL", 0.19, close - 60), asset: brzAsset(0.19, { priceSource: "coinbase", priceObservedAt: now - 10 }) };
    const d = decide(input);
    expect(d.commands).toEqual([{ type: "clear-recovery", id: existing.id }]);
    expect(d.referenceHold?.hold).toEqual({ reason: "reference-market-closed", declaredAtSec: now, lastTrustedAtSec: close - 60, lastTrustedPeakBps: -360 });
    const held = { ...existing, reference_hold_json: JSON.stringify(d.referenceHold), price_coverage_gap_started_at: now, price_coverage_json: JSON.stringify({ intervals: [[close - 900, close - 60]], lastObservationKind: "blind" }) };
    expect(decide({ ...input, existing: held, now: now + 300 }).referenceHold?.hold).toEqual({ ...d.referenceHold!.hold, refreshedAtSec: now + 300 });
    expect(decide({ ...input, existing: { ...held, peak_deviation_bps: -400 }, now: now + 300 }).referenceHold).toBeUndefined();
    const reopened = Date.UTC(2026, 10, 15, 22, 2) / 1000;
    const reopening = { ...input, now: reopened, asset: { ...input.asset, priceObservedAt: reopened - 10 } };
    expect(decide({ ...reopening, existing: held }).referenceHold).toBeUndefined();
    const rechecked = { ...held, reference_hold_json: JSON.stringify({ ...d.referenceHold, hold: { ...d.referenceHold!.hold, refreshedAtSec: reopened - 900 } }) };
    expect(decide({ ...reopening, existing: rechecked }).referenceHold?.hold).toEqual({ ...d.referenceHold!.hold, refreshedAtSec: reopened });
    expect(decide({ ...input, existing: held, asset: { ...input.asset, priceObservedAt: null } }).referenceHold).toBeUndefined();
  });

  it("recovers native cNGN event 90738 from two dated USD/NGN observations", () => {
    const meta = makeMeta("cngn-compliant-naira", "cNGN", "NGN"), now = Date.UTC(2026, 10, 18, 13) / 1000;
    const existing = makeExistingEvent({ id: 90738, stablecoin_id: meta.id, symbol: meta.symbol, peg_type: "peggedNGN", peg_reference: 1, direction: "below", start_price: 0.94, started_at: now - D });
    const poolKey = "ethereum:0x0000000000000000000000000000000000000001";
    const obs = (at: number, priceSource: string) => ({
      ...clockedBenchmark("peggedNGN", 0.0007, at - 120), meta, now: at, existing,
      asset: makeAsset({ id: meta.id, symbol: meta.symbol, pegType: "peggedNGN", price: 0.0007, priceSource, ...upAt(at - 30) }),
      dexRow: { ...makeDexRow(0.0007, { updated_at: at }), stablecoin_id: meta.id, aggregateObservedAt: at - 30, pricePoolKeys: [poolKey], upstreamKeys: [poolKey, "venue:bitstamp"] },
      nativePegQuote: { stablecoinId: meta.id, geckoId: "compliant-naira", pegCurrency: "NGN", price: 1, updatedAt: at - 10, derivation: { kind: "conversion" as const, lineage: {} } },
    });
    expect(decide(obs(now, "coingecko-native-implied")).commands).toEqual([]);
    const undated = obs(now, "dex-promoted");
    expect(decide({ ...undated, dexRow: { ...undated.dexRow, upstreamKeys: [] } }).commands).toEqual([]);
    expect(decide(obs(now, "dex-promoted")).commands).toMatchObject([{ type: "begin-recovery", firstSeenAt: now - 120, lastSeenAt: now - 120, source: "native", usdObservedAt: now - 30 }]);
    const next = obs(now + 900, "dex-promoted");
    const prior = { ...existing, recovery_evidence_source: "native" as const, recovery_first_seen_at: now - 120, recovery_last_seen_at: now - 120, recovery_usd_first_seen_at: now - 30, recovery_usd_observed_at: now - 30 };
    expect(decide({ ...next, existing: prior }).commands).toMatchObject([{ type: "close-event", closeReason: "recovered-native", recoveryPrice: 1, recoveryPegReference: 1 }]);
    // FX clock can advance min leg while USD trade stays fixed.
    const earlierFx = { ...prior, recovery_first_seen_at: now - 1000, recovery_last_seen_at: now - 1000, last_trusted_price_at: now - 1000, price_coverage_gap_started_at: now - 1000, price_coverage_json: JSON.stringify({ intervals: [], atParIntervals: [[now - 1000, now - 1000]], lastObservationKind: "trusted-at-par" }) };
    const repeatWithUsdAt = (at: number) => decide({ ...next, existing: earlierFx, dexRow: { ...next.dexRow, aggregateObservedAt: at }, asset: { ...next.asset, priceObservedAt: at } });
    const repeat = repeatWithUsdAt(now - 30);
    expect(repeat.commands).toEqual([]);
    expect(repeat.priceCoverage?.lastTrustedObservationAt).toBe(now - 1000);
    expect(repeatWithUsdAt(now - 20).commands).toMatchObject([{ type: "continue-recovery", lastSeenAt: now - 20, usdObservedAt: now - 20 }]);
    expect(decide({ ...next, existing: { ...prior, recovery_usd_first_seen_at: null, recovery_usd_observed_at: null } }).commands).toMatchObject([{ type: "begin-recovery", usdObservedAt: now + 870 }]);
    expect(decide({ ...next, existing: prior, nativePegQuote: { ...next.nativePegQuote, derivation: tradedPair } }).commands).toEqual([{ type: "begin-recovery", id: 90738, firstSeenAt: now + 890, lastSeenAt: now + 890, source: "native" }]);
  });

  it.each([
    ["peer-divergence", 0.93, 1, true], ["cohort-wide", 0.70, 0.70, false], ["conversion", 0.93, 1, false],
    ["mirrored-pool", 0.93, 1, false], ["legacy-pool", 0.93, 1, false], ["outvoted-pool", 0.93, 1, false], ["open-benchmark-event", 0.93, 1, true],
  ] as const)("uses independent weekend evidence for %s", (scenario, price, peerPrice, pending) => {
    const now = weekend, asset = brzAsset(price, { priceSource: "coingecko", priceObservedAt: now - 60 });
    const peers = peerVenues.map((priceSource) => brzAsset(peerPrice, { id: priceSource, priceSource, priceObservedAt: now - 60 }));
    const pegRates = { peggedREAL: 1 };
    attachDetectionReferenceContext(pegRates, [asset, ...peers], peerMetadata([...peers, asset], brlMeta), new Set(), null).rollbackSupportsPeerEvents = true;
    const d = decide({
      ...brlPeg, pegRates, asset, now, meta: brlMeta,
      existing: scenario === "open-benchmark-event" ? makeExistingEvent({ direction: "below", peak_deviation_bps: -250, started_at: now - D, peg_reference: 1.02, pending_reason: "confirmation-window" }) : undefined,
      nativePegQuote: scenario === "conversion" ? { ...brzQuote(0.93, now - 60), derivation: { kind: "conversion", lineage: {} } } : undefined,
      challengerPools: scenario === "conversion" ? undefined : [
        pool(price, 210_000, scenario === "legacy-pool" ? "unknown" : "curve", "ethereum", scenario === "legacy-pool" ? "legacy-challenger-pools" : scenario === "mirrored-pool" ? "coingecko" : "curve", now - 30),
        ...(scenario === "outvoted-pool" ? ["uniswap", "aerodrome"].map((p, i) => pool(1, i ? 25_000_000 : 5_000_000, p, "ethereum", p, now - 30)) : []),
      ],
    });
    if (scenario === "open-benchmark-event") {
      expect(d.commands).toMatchObject([{ type: "update-peak", peakDeviationBps: -700, peakPrice: 0.93, peakPegReference: 1, peakQuoteDomain: "usd", peakReceipt: expect.stringContaining('"basis":"peer-relative"') }]);
    } else if (pending) expect(d.commands).toMatchObject([{ type: "upsert-pending", payload: { pegReference: 1, reason: expect.stringContaining("low-confidence+peer-relative"), peerBasis: expect.stringContaining("coinbase") } }]);
    else expect(d.commands).toEqual([]);
  });

  it("opens on the calibrated BRL benchmark with a stable cohort and a separate native trade", () => {
    const now = weekend, at = now - 60, asset = brzAsset(0.81, { priceSource: "coingecko", priceObservedAt: at, priceUpdatedAt: at });
    const peers = peerVenues.map((priceSource) => brzAsset(1, { id: priceSource, priceSource, priceObservedAt: at, priceUpdatedAt: at }));
    const rates = clockedBenchmark("peggedREAL", 1, fridayBrlClose), cohort = [asset, ...peers];
    attachDetectionReferenceContext(rates.pegRates, cohort, peerMetadata(cohort, brlMeta), new Set(), referenceState(rates.pegRates, fridayBrlClose));
    const d = decide({ ...rates, asset, now, meta: brlMeta, nativePegQuote: brzQuote(0.97, at) });
    expect(d.commands).toMatchObject([{ type: "upsert-pending", payload: { direction: "below", price: 0.81, pegReference: 1, reason: expect.not.stringContaining("peer-relative") } }]);
  });

  it("keeps the severe benchmark band for a thin cohort when calibration is lower", () => {
    const now = weekend, config = REFERENCE_CLOSURE_HOLD_BANDS_BPS.BRL, prev = config.weekend;
    Reflect.set(config, "weekend", 600);
    try {
      const d = decide({ ...clockedBenchmark("peggedREAL", 1, fridayBrlClose), now, meta: brlMeta, asset: brzAsset(0.90, { priceObservedAt: now - 60 }), nativePegQuote: brzQuote(0.90, now - 60) });
      expect(d.commands).toMatchObject([{ type: "upsert-pending", payload: { reason: expect.stringContaining("native-origin"), seenAt: now, quoteObservedAt: now - 60 } }]);
    } finally { Reflect.set(config, "weekend", prev); }
  });

  it.each(["sub-floor", "pre-reopen", "local-fetch", "in-session"])("orders lifecycle admission for %s", (scenario) => {
    const reopen = Date.UTC(2026, 10, 15, 23) / 1_000, now = scenario === "sub-floor" ? reopen - 3_600 : reopen + 60, pegRates = { peggedGOLD: 100 };
    const asset = makeAsset({ pegType: "peggedGOLD", price: 97.8, priceObservedAt: scenario === "pre-reopen" ? reopen - 60 : now - 10, priceObservedAtMode: scenario === "local-fetch" ? "local_fetch" : "upstream", priceUpdatedAt: now - 10, circulating: { ethereum: scenario === "sub-floor" ? 991_742 : 50_000_000 } });
    const meta = { ...goldMeta, commodityOunces: 1 }, fx = referenceState(pegRates, now - 30);
    attachDetectionReferenceContext(pegRates, [], new Map(), new Set(), fx, fx.repricingByPeg);
    const nativePegQuote = scenario === "sub-floor" ? { stablecoinId: asset.id, geckoId: "test-gold", pegCurrency: "GOLD", price: 0.96, updatedAt: now - 10, derivation: tradedPair } : undefined;
    const d = decide({ now, asset, meta, pegRates, pegRateSources: { peggedGOLD: "fallback" }, pegRateCounts: {}, nativePegQuote, existing: makeExistingEvent({ peg_type: "peggedGOLD", direction: "below", peak_deviation_bps: -170, peg_reference: 99 }) });
    if (scenario === "in-session") expect(d.commands).toMatchObject([{ type: "update-peak", peakDeviationBps: -220, peakPegReference: 100, peakQuoteDomain: "usd" }, { type: "update-escalation", peakEscalatedAt: null, peakEscalationAnchorBps: 220, peakEscalationCandidateAt: null }]);
    else expect(d.commands).toEqual([]);
    if (scenario === "sub-floor") expect(d.observation).toEqual({ kind: "below-floor" });
  });

  it.each([
    ["mento-broker", undefined], ["protocol-redeem", "accrued-token"], ["protocol-redeem-cached-rate", "accrued-token"], ["protocol-redeem", undefined],
  ] as const)("withholds %s valuation (%s)", (source, parityQuoteUnit) => {
    const solayer = source !== "mento-broker", id = solayer ? "susd-solayer" : "xofm-mento", pegCurrency = solayer ? "USD" : "XOF", pegType = solayer ? "peggedUSD" : "peggedXOF";
    const meta: typeof usdMeta = { ...usdMeta, id, flags: { ...usdMeta.flags, pegCurrency } };
    const pricing = solayer ? usdPeg : clockedBenchmark(pegType, 0.0018, T0_60);
    const coin = { ...makeAsset({ id, pegType, price: solayer ? 1.181399598224652 : 0.0018 * 0.98, priceSource: source, ...upAt(T0 - 30) }), parityQuoteUnit };
    const input = { ...pricing, meta, now: T0 };
    for (const priceSource of [source, "cached"]) {
      const d = decide({ ...input, asset: { ...coin, priceSource, agreeSources: [source] } });
      expect(d.commands).toEqual([]);
      expect(d.observation?.kind).toBe("unavailable");
    }
    const traded = decide({ ...input, asset: coin, nativePegQuote: { stablecoinId: id, geckoId: id, pegCurrency, price: 0.97, updatedAt: T0 - 30, derivation: { kind: "traded-pair", lineage: { venue: "kraken", pair: `${coin.symbol}/${pegCurrency}` } } } });
    expect(traded.commands).toMatchObject([{ type: "upsert-pending", payload: { price: 0.97, pegReference: 1, nativeVenue: "kraken" } }]);
  });

  it.each(["peggedGBP", "peggedUSD"])("withholds EURC at parity when the provider labels it %s", (pegType) => {
    const meta = makeMeta("eurc-circle", "USDT", "EUR");
    const asset = makeAsset({ id: meta.id, price: 1.1, pegType, priceObservedAtMode: "upstream", priceObservedAt: T0 });
    const d = decide({ ...clockedBenchmark("peggedGBP", 1.3, T0), now: T0, asset, meta });
    expect(d.commands).toEqual([]);
    expect(d.observation).toEqual({ kind: "unavailable", reason: "invalid-reference" });
  });

  it.each(["matched", "missing", "wrong-quote", "future-block", "wrong-generation", "prior-day"] as const)("uses the %s XAGm entitlement for event and peer pricing", (mode) => {
    const meta = silverMeta, pegRates = { peggedSILVER: 30 }, observedAt = T0 - 30;
    const asset = {
      ...makeAsset({ id: meta.id, pegType: "peggedSILVER", price: 29.95142466, priceSource: "kraken", priceObservedAtMode: "upstream", priceObservedAt: observedAt }),
      commodityEntitlement: mode === "missing" ? undefined : {
        source: "matrixdock-frs" as const, generation: mode === "wrong-generation" ? "other:123" : "ethereum:123", ozPerToken: 0.998380822,
        observedAtSec: mode === "future-block" ? T0 : mode === "prior-day" ? observedAt - D : observedAt - 60, quoteObservedAtSec: mode === "wrong-quote" ? observedAt - 60 : observedAt,
      },
    };
    const fx = referenceState(pegRates, T0_60), ctx = attachDetectionReferenceContext(pegRates, [asset], new Map([[asset.id, meta]]), new Set(), fx, fx.repricingByPeg);
    const input = { now: T0, meta, asset, pegRates, pegRateSources: { peggedSILVER: "fallback" as const }, pegRateCounts: {}, referenceContext: ctx };
    const d = decide(input), peer = ctx.groups.get("peggedSILVER")?.peers[0];
    if (mode === "matched") {
      expect(peer?.priceUsd).toBeCloseTo(30, 10);
      expect(d.observation).toEqual({ kind: "observed" });
      expect(d.commands).toEqual([]);
      expect(decide({ ...input, asset: { ...asset, price: 29 } }).commands).toMatchObject([{ type: "upsert-pending", payload: { pegReference: 29.95142466 } }]);
    } else {
      expect(peer).toBeUndefined();
      expect(d.observation).toEqual({ kind: "unavailable", reason: "invalid-reference" });
    }
  });

  it("requires quote-matched XAGm DEX evidence for legacy FX detection and peaks", () => {
    const now = Date.UTC(2026, 10, 18, 0, 3) / 1_000, quoteAt = now - 30, ozPerToken = 0.998380822, pegReference = 30 * ozPerToken, pegRates = { peggedSILVER: 30 };
    const fx = referenceState(pegRates, now - 1_000, false);
    fx.sources = { "gold-api.com": "ok" };
    const meta = { ...silverMeta, symbol: "XAGm" };
    const asset = {
      ...makeAsset({ id: meta.id, symbol: meta.symbol, pegType: "peggedSILVER", price: pegReference * 0.95, priceSource: "coingecko", ...upAt(quoteAt) }),
      commodityEntitlement: { source: "matrixdock-frs" as const, generation: "ethereum:1250", ozPerToken, quoteObservedAtSec: quoteAt, observedAtSec: quoteAt - 60 },
    };
    const referenceContext = attachDetectionReferenceContext(pegRates, [asset], new Map([[asset.id, meta]]), new Set(), fx);
    const input = { now, meta, asset, pegRates, pegRateSources: { peggedSILVER: "fallback" as const }, pegRateCounts: {}, referenceContext };
    const existing = makeExistingEvent({ stablecoin_id: asset.id, symbol: asset.symbol, peg_type: "peggedSILVER", direction: "below", started_at: now - 3_600, last_trusted_price_at: now - 300, peak_deviation_bps: -200, start_price: pegReference * 0.98, peak_price: pegReference * 0.98, peg_reference: pegReference });
    for (const poolAt of [now - 240, quoteAt]) {
      const ev = (price: number) => ({
        dexRow: makeDexRow(price, { stablecoin_id: asset.id, source_total_tvl: 8_000_000, updated_at: now - 10, aggregateObservedAt: poolAt }),
        protocolSources: ["curve", "uniswap"].map((p) => proto(p, price, 4_000_000, poolAt, p, { updatedAt: now - 10, aggregateObservedAt: poolAt })),
      });
      const matched = poolAt === quoteAt;
      expect(decide({ ...input, ...ev(pegReference) }).commands).toMatchObject(matched ? [] : [{ type: "upsert-pending", payload: { bps: -500, pegReference } }]);
      expect(decide({ ...input, existing, ...ev(pegReference * 0.95) }).commands).toMatchObject(matched ? [{ type: "update-peak", peakDeviationBps: -500 }] : []);
    }
  });

  it.each([[-60, 0.90], [-60, 1.10], [0, 1.10], [30, 1.10], [60, 1.10]])("orders native peak and reversal against onset at %s/%s", (offset, price) => {
    const startedAt = 1_750_259_000, observedAt = startedAt + offset;
    const d = decide({
      now: T0, meta: brlMeta, ...brlPeg, asset: brzAsset(0.19),
      existing: makeExistingEvent({ quote_mode: "native-peg", direction: "below", peg_reference: 1, peak_deviation_bps: -200, started_at: startedAt, last_trusted_price_at: offset === 30 ? startedAt + 40 : null }),
      nativePegQuote: brzQuote(price, observedAt),
    });
    if (offset !== 60) expect(d.commands).toEqual([]);
    else expect(d.commands).toMatchObject([{ type: "close-event", endedAt: observedAt }, { type: "upsert-pending", payload: { seenAt: T0, quoteObservedAt: observedAt } }]);
  });

  it.each([97, 100])("adopts an independently traded closed metal median for price %s", (price) => {
    const now = weekend, meta = { ...goldMeta, commodityOunces: 1 }, pegRates = { peggedGOLD: 100 };
    const sample = (id: string, priceSource: string, v: number) => makeAsset({ id, priceSource, price: v, pegType: "peggedGOLD", ...upAt(now - 30) });
    const asset = sample(meta.id, "pyth", price), quotes = [asset, ...peerVenues.map((s) => sample(s, s, 100))];
    attachDetectionReferenceContext(pegRates, quotes, peerMetadata(quotes, meta), new Set(), null, undefined, { peggedGOLD: 4 });
    const d = decide({ now, asset, meta, pegRates, pegRateSources: { peggedGOLD: "median" }, pegRateCounts: { peggedGOLD: 4 }, existing: price === 100 ? makeExistingEvent({ stablecoin_id: meta.id, peg_type: "peggedGOLD", direction: "below", started_at: now - 3_600, peg_reference: 100 }) : undefined });
    expect(d.commands.map(({ type }) => type)).toEqual([price === 97 ? "upsert-pending" : "begin-recovery"]);
  });

  it.each([0, 60, 900, 1201])("uses two original DEX clocks to advance recovery by %s seconds", (advance) => {
    const firstSeenAt = T0, observedAt = firstSeenAt + advance;
    const observe = (at: number, existing: DepegDetectionRow) => decide({
      ...usdInput, now: at + 60, asset: makeAsset({ price: 1, priceSource: "coingecko", ...upAt(at) }),
      existing, dexRow: makeDexRow(1, { updated_at: at, aggregateObservedAt: at }), protocolSources: twoProtos(1, 1, 2_500_000, at, "uniswap"),
    });
    const start = observe(firstSeenAt, makeUsdEvent()).commands[0];
    expect(start).toMatchObject({ type: "begin-recovery", source: "dex", firstSeenAt });
    if (start.type !== "begin-recovery") throw new Error("Missing initial DEX observation");
    const d = observe(observedAt, makeUsdEvent({ recovery_first_seen_at: start.firstSeenAt, recovery_last_seen_at: start.lastSeenAt, recovery_evidence_source: start.source }));
    expect(d.commands).toMatchObject(advance === 0 ? [] : advance === 60 ? [{ type: "continue-recovery", lastSeenAt: observedAt }]
      : advance === 900 ? [{ type: "close-event", closeReason: "recovered-dex", recoveryPegReference: 1 }]
        : [{ type: "begin-recovery", firstSeenAt: observedAt, lastSeenAt: observedAt, source: "dex" }]);
  });

  describe("original aggregate clocks", () => {
    const now = T0;
    it.each([null, now - 6 * 3600, now - 60])("separates affirmative evidence from vetoes at %s", (aggregateObservedAt) => {
      const fresh = aggregateObservedAt === now - 60;
      const sample = (price: number, dexPrice: number, authoritative = false) => ({
        ...usdInput, asset: makeAsset({ price, priceSource: authoritative ? "pyth" : "coingecko" }), existing: makeUsdEvent(),
        dexRow: makeDexRow(dexPrice, { updated_at: now - 30, aggregateObservedAt }),
        protocolSources: ["curve", "uniswap"].map((p) => proto(p, dexPrice, 2_500_000, now - 30, p, { aggregateObservedAt: now - 30 })),
      });
      for (const price of [0.992, null]) {
        const input = sample(0.992, 0.992);
        input.asset.price = price;
        input.dexRow.aggregateObservedAt = now - 30;
        expect(decide(input).deadBandNotice?.eventId).toBe(7);
      }
      const zarp = { ...sample(0.985106, 0.991964), meta: makeMeta(USDT, "USDT", "ZAR"), asset: makeAsset({ price: 0.985106, priceSource: "coingecko", pegType: "peggedZAR", priceObservedAt: now - 60, priceObservedAtMode: "upstream" }), ...clockedBenchmark("peggedZAR", 1, now - 60) };
      zarp.dexRow.aggregateObservedAt = now - 30;
      zarp.dexRow.source_total_tvl = 1605155;
      zarp.protocolSources.forEach((s, i) => { s.price = i ? 1.022914 : 0.984958; });
      expect(decide(zarp).deadBandNotice?.price).toBe(0.991964);
      for (const [dex_price_usd, notice] of [[1.007, false], [1.0075, false], [1.007501, true], [1.014999, true], [1.015, false], [1.016, false]] as const) {
        expect(Boolean(decide({ ...zarp, dexRow: { ...zarp.dexRow, dex_price_usd } }).deadBandNotice)).toBe(notice);
      }
      for (const [price, families, age, tvl] of [[0.992, 2, 30, 5e6], [0.992, 1, 30, 5e6], [0.992, 2, 2101, 5e6], [0.992, 2, 30, 999999], [1, 2, 30, 5e6], [0.98, 2, 30, 5e6]]) {
        const input = sample(price, price);
        input.protocolSources = input.protocolSources.slice(0, families).map((s, i) => ({ ...s, price: price === 0.992 ? [0.98, 1.02][i] : price, observedAt: now - age }));
        input.dexRow.source_total_tvl = tvl;
        const d = decide(input), notice = fresh && price === 0.992 && families === 2 && age === 30 && tvl === 5e6;
        expect(Boolean(d.deadBandNotice)).toBe(notice);
        if (notice) expect(d).toMatchObject({ commands: [], seenEventIds: [7], priceCoverage: { lastObservationKind: "blind" }, deadBandNotice: { eventId: 7, price, contributors: input.protocolSources.map(({ price: p, observedAt }) => expect.objectContaining({ price: p, observedAt })) } });
      }
      const recovery = decide(sample(1, 1));
      expect(recovery.observation).toEqual({ kind: "observed" });
      expect(recovery.commands.map((c) => c.type)).toEqual(fresh ? ["begin-recovery"] : []);
      expect(recovery.priceCoverage?.lastObservationKind).toBe(fresh ? "trusted-at-par" : "blind");
      expect(decide(sample(1.02, 1.02)).commands.map((c) => c.type)).toEqual(fresh ? ["close-event", "upsert-pending"] : []);
      expect(decide(sample(0.98, 0.98)).priceCoverage?.lastObservationKind).toBe(fresh ? "trusted-off-peg" : "blind");
      const veto = decide(sample(1, 0.98, true));
      expect(veto.commands).toEqual([]);
      expect(veto.priceCoverage?.lastObservationKind).toBe("blind");
      expect(decide({ ...sample(0.98, 1), existing: undefined }).commands).toEqual([]);
    });
  });

  it.each([{ priceSource: "pyth", priceObservedAtMode: "nominal_reference" as const }, { priceSource: "protocol-par" }])("does not open or recover an event from nominal evidence: %j", (prov) => {
    for (const price of [0.98, 1]) {
      for (const existing of [undefined, makeUsdEvent({}, false)]) {
        expect(runUsd0({ price, priceConfidence: "high", ...prov }, { existing }).commands).toEqual([]);
      }
    }
  });

  describe("observation outcome", () => {
    const usdEvent = () => makeUsdEvent({}, false);

    it.each([["missing price", { price: null }], ["nominal price", { priceSource: "protocol-par", price: 1 }]] as const)("records %s as primary-unusable", (_label, overrides) => {
      for (const existing of [undefined, usdEvent()]) {
        for (const circulating of [{ ethereum: 0 }, {}] as Record<string, number>[]) {
          const d = runUsd0({ ...overrides, circulating }, { existing });
          expect(d.observation).toEqual({ kind: "unavailable", reason: "primary-unusable" });
          expect(d.commands).toEqual([]);
        }
      }
    });

    it.each([false, true])("records unavailable supply without inventing zero (open event: %s)", (withEvent) => {
      const existing = withEvent ? usdEvent() : undefined, d = runUsd0({ circulating: {} }, { existing });
      expect(d.observation).toEqual({ kind: "unavailable", reason: "supply-unavailable" });
      expect(d.commands).toEqual([]);
      expect(d.seenEventIds).toEqual(withEvent ? [existing!.id] : []);
    });

    it("separates observed zero supply as below-floor", () => {
      const d = runUsd0({ circulating: { ethereum: 0 } }, { existing: usdEvent() });
      expect(d.observation).toEqual({ kind: "below-floor" });
      expect(d.commands).toMatchObject([{ type: "close-event", closeReason: "coverage-lost-supply" }]);
    });

    it.each([
      ["non-authoritative-reference", { peggedREAL: "median" as const }, { peggedREAL: 1 }, { peggedREAL: 0.19 }],
      ["invalid-reference", { peggedREAL: "median" as const }, { peggedREAL: 4 }, { peggedREAL: 0 }],
    ])("records the %s peg-signal rejection", (reason, pegRateSources, pegRateCounts, pegRates) => {
      expect(decide({ now: T0, asset: brzAsset(0.19), meta: brlMeta, pegRates, pegRateSources, pegRateCounts }).observation).toEqual({ kind: "unavailable", reason });
    });

    it("records a native-domain event without a native quote as native-quote-unavailable", () => {
      const d = decide({ now: T0, asset: brzAsset(0.1876), meta: brlMeta, existing: makeExistingEvent({ peg_reference: 1, source: "live" }), pegRates: { peggedREAL: 0.18765951 }, pegRateSources: { peggedREAL: "median" }, pegRateCounts: { peggedREAL: 3 } });
      expect(d.observation).toEqual({ kind: "unavailable", reason: "native-quote-unavailable" });
    });

    it.each([["at par", { price: 1 }], ["confirmation-required depeg", {}], ["stale (confirmation-required) price", { priceUpdatedAt: T0 - 30 * D }]])("counts a usable %s context as observed", (_label, overrides) => {
      expect(runUsd0(overrides).observation).toEqual({ kind: "observed" });
    });

    it("leaves untracked and NAV rows outside the census", () => {
      expect(runUsd0({}, { meta: undefined }).observation).toBeUndefined();
      expect(runUsd0({}, { meta: { ...usdMeta, flags: { ...usdMeta.flags, navToken: true } } }).observation).toBeUndefined();
    });
  });

  it("routes an authoritative small-cap depeg through pending confirmation", () => {
    const poolKey = "ethereum:0x0000000000000000000000000000000000000001";
    const d = decide({ ...usdInput, asset: { ...makeAsset(), upstreamKeys: [poolKey, "venue:coinbase"] } });
    expect(d.trackedCoinId).toBe(USDT);
    expect(d.commands).toHaveLength(1);
    expect(d.commands[0]).toMatchObject({ type: "upsert-pending", payload: { stablecoinId: USDT, direction: "below", bps: -200, price: 0.98, pegReference: 1, reason: "confirmation-window", sourceKeys: ["coinbase", poolKey, "pyth"] } });
    expect(d.diagnostics).toEqual(diag("[depeg] Pending confirmation for USDT: -200bps (confirmation-window)", "log"));

    const existing = makeUsdEvent({ admitted_coverage_json: JSON.stringify([{ fromSec: T0 - 60, toSec: T0 + 1 }]) }, false);
    const flip = runUsd0({ price: 1.02 }, { existing });
    expect(flip.commands[0]).toMatchObject({ type: "close-event", recoveryPrice: null, closeReason: "superseded-direction" });
    expect(flip.admittedCoverage).toEqual([{ fromSec: T0 - 60, toSec: T0 }]);
  });

  it("uses run ordering for an unclocked USD primary and rejects a repeated upstream quote", () => {
    for (const clocked of [false, true]) {
      const clock = clocked ? { priceObservedAt: T0, priceObservedAtMode: "upstream" as const } : {};
      expect(runUsd0({ price: 1.02, ...clock }, { existing: makeUsdEvent({ started_at: T0 }) }).commands.map(({ type }) => type)).toEqual(clocked ? [] : ["close-event", "upsert-pending"]);
      expect(runUsd0({ price: 1, ...clock }, { existing: makeUsdEvent({ recovery_first_seen_at: T0 - 900, recovery_last_seen_at: T0 }) }).commands.map(({ type }) => type)).toEqual(clocked ? [] : ["close-event"]);
    }
  });

  it("logs pending diagnostics only when explicitly emitted", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const d = runUsd0({ circulating: { ethereum: 2_000_000_000 } });
      expect(d.commands).toHaveLength(1);
      expect(d.commands[0]).toMatchObject({ type: "upsert-pending", payload: { stablecoinId: USDT, direction: "below", bps: -200, reason: "confirmation-window+large-cap" } });
      expect(d.diagnostics).toEqual(diag("[depeg] Pending confirmation for USDT: -200bps (confirmation-window+large-cap)", "log"));
      expect(logSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      emitDepegDiagnostics([...d.diagnostics, { level: "warn", message: "Withheld quote" }]);
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining(d.diagnostics[0].message));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Withheld quote"));
    } finally { logSpy.mockRestore(); infoSpy.mockRestore(); warnSpy.mockRestore(); }
  });

  it.each([["pyth", 90], ["coingecko", 90], ["coingecko", 30]] as const)("holds recovery from a stale or repeated %s quote aged %d seconds", (priceSource, age) => {
    const d = runUsd0({ price: 1, priceSource, priceObservedAt: T0 - age, priceObservedAtMode: "upstream" }, { existing: makeUsdEvent({ last_trusted_price_at: T0 - 60, recovery_first_seen_at: T0 - 60, recovery_last_seen_at: T0 - 30 }) });
    expect(d.commands).toEqual([]);
    expect(d.seenEventIds).toEqual([7]);
  });

  it.each<[string, Partial<PegAssetBase>, number, string]>([
    ["routes near-threshold market-cap weak-source severe moves to pending", { price: 0.975, circulating: { ethereum: 999_000_000 }, agreeSources: ["pyth"] }, -250, "confirmation-window+large-cap"],
    ["requires the confirmation window even with strong primary evidence", { price: 0.985, priceSource: "binance+pyth", priceConfidence: "high", agreeSources: ["binance", "pyth"], circulating: { ethereum: 999_000_000 } }, -150, "confirmation-window"],
    ["keeps same-family extreme moves pending even when two source labels agree", { price: 0.2, priceSource: "coingecko+coingecko-low-volume", priceConfidence: "high", agreeSources: ["coingecko", "coingecko-low-volume"], circulating: { ethereum: 20_000_000 } }, -8000, "confirmation-window+extreme-move+low-confidence"],
  ])("%s", (_title, asset, bps, reason) => {
    const d = runUsd0(asset);
    expect(d.commands).toHaveLength(1);
    expect(d.commands[0]).toMatchObject({ type: "upsert-pending", payload: { stablecoinId: USDT, direction: "below", bps, reason } });
  });

  it("does not start confirmation when only the rounded value reaches the threshold", () => {
    expect(runUsd0({ price: 0.99005 }).commands).toEqual([]);
  });

  it("requires the confirmation window for independent multi-source extreme moves", () => {
    const d = runUsd0(cgDlAsset(0.2, T0_60, { id: "msusd-main-street", symbol: "msUSD", circulating: { ethereum: 20_000_000 } }), { meta: makeMeta("msusd-main-street", "msUSD", "USD", { name: "Main Street USD", geckoId: "main-street-usd" }) });
    expect(d.trackedCoinId).toBe("msusd-main-street");
    expect(d.commands).toHaveLength(1);
    expect(d.commands[0]).toMatchObject({ type: "upsert-pending", payload: { stablecoinId: "msusd-main-street", direction: "below", bps: -8000, price: 0.2, reason: "confirmation-window+extreme-move+low-confidence" } });
    expect(d.diagnostics).toHaveLength(1);
  });

  it("suppresses a live mutation when the native quote shows recovery", () => {
    const d = decide({ now: T0, asset: brzAsset(0.190587), meta: brlMeta, nativePegQuote: brzQuote(0.995), ...clockedBenchmark("peggedREAL", 0.18765951, T0_60) });
    expect(d.trackedCoinId).toBe(BRZ);
    expect(d.commands).toHaveLength(0);
    expect(d.diagnostics).toEqual(diag("[depeg] Suppressed live depeg mutation for BRZ: primary=156bps but BRL quote=-50bps"));
  });

  it.each([
    ["a supported native-peg depeg through pending confirmation", 22_000_000, "confirmation-window+native-origin", false],
    ["large-cap native-peg openings to pending confirmation", 2_000_000_000, "confirmation-window+large-cap+native-origin", true],
  ])("routes %s", (_label, gnosis, expectedReason, expectSeenEventIds) => {
    assertNativeOpening({ circulating: { gnosis }, nativePrice: 0.9758, expectedBps: -242, expectedReason, expectSeenEventIds });
  });

  it.each([60, 21_600, undefined])("routes extreme native-peg openings only with fresh original DEX clocks (%s)", (age) => {
    assertNativeOpening({ circulating: { gnosis: 22_000_000 }, nativePrice: 0.2, expectedBps: -8000, expectedReason: "confirmation-window+extreme-move+native-origin", expectSeenEventIds: true, dexCorroboration: { price: 0.038379, tvl: 2_500_000, aggregateObservedAt: age == null ? undefined : T0 - age }, admitted: age === 60 });
  });

  it.each([60, 21_600, undefined])("requires fresh DEX support for an extreme native-quote veto at age %s", (age) => {
    const d = decide({
      now: T0, meta: brlMeta, ...brlPeg, asset: brzAsset(0.191895 * 1.03), nativePegQuote: brzQuote(0.2),
      dexRow: makeDexRow(0.038379, { stablecoin_id: BRZ, updated_at: T0_60, aggregateObservedAt: age == null ? undefined : T0 - age }),
      protocolSources: twoProtos(0.038379, 0.038379, 2_500_000, T0_60),
    });
    expect(d.commands.map(({ type }) => type)).toEqual(age === 60 ? [] : ["upsert-pending"]);
    expect(d.diagnostics.some(({ message }) => message.includes("Suppressed live depeg mutation"))).toBe(age === 60);
  });

  it.each([
    ["an uncorroborated extreme native-peg opening as unavailable evidence", undefined],
    ["an extreme native quote when a trusted DEX aggregate stays at peg", makeDexRow(0.1919, { stablecoin_id: BRZ, updated_at: T0_60, aggregateObservedAt: T0_60 })],
  ])("withholds %s", (_label, dexRow) => {
    const d = decide({ now: T0, asset: brzAsset(0.191187, { priceSource: "coingecko", circulating: { gnosis: 22_000_000 } }), meta: brlMeta, ...brlPeg, dexRow, nativePegQuote: brzQuote(0.2) });
    expect(d.commands).toEqual([]);
    expect(d.diagnostics).toEqual(withheldBrz);
  });

  it("withholds an above-peg native quote instead of opening a pending row", () => {
    const eurMeta = makeMeta("ceur-celo", "EURm", "EUR", { name: "Celo EUR", geckoId: "celo-euro" });
    const d = decide({
      now: T0, meta: eurMeta, ...clockedBenchmark("peggedEUR", 1.16, T0_60),
      asset: makeAsset({ id: "ceur-celo", symbol: "EURm", price: 1.16, priceSource: "coingecko", priceObservedAt: T0_60, priceObservedAtMode: "upstream", pegType: "peggedEUR", circulating: { celo: 22_000_000 } }),
      nativePegQuote: { stablecoinId: "ceur-celo", geckoId: "celo-euro", pegCurrency: "EUR", price: 2.598389348610164, updatedAt: T0_60, derivation: tradedPair },
    });
    expect(d.commands).toEqual([]);
    expect(d.diagnostics).toEqual(diag("[depeg] Withheld implausible EUR native quote for EURm: reason=native-quote-above-peg-reference-band"));
  });

  it("keeps an existing event open when the native quote still supports it", () => {
    const d = decide({ now: T0, asset: brzAsset(0.18765951), meta: brlMeta, existing: makeExistingEvent(), nativePegQuote: brzQuote(1.02), ...clockedBenchmark("peggedREAL", 0.18765951, T0_60) });
    expect(d.trackedCoinId).toBe(BRZ);
    expect(d.seenEventIds).toEqual([7]);
    expect(d.commands).toHaveLength(0);
    expect(d.diagnostics).toEqual(diag("[depeg] Kept BRZ open despite primary recovery: primary=0bps but BRL quote=200bps"));
  });

  it("recovers a native-domain row from its native quote under a nominal USD primary", () => {
    const d = decide({
      now: T1, meta: zarMeta, pegRates: { peggedZAR: 0.0552 }, pegRateSources: { peggedZAR: "fx" }, pegRateCounts: { peggedZAR: 4 },
      asset: makeAsset({ id: "zarm-mento", symbol: "ZARm", pegType: "peggedZAR", price: 0.0552, priceSource: "protocol-par", priceConfidence: null, priceObservedAt: null, priceUpdatedAt: null, priceObservedAtMode: "nominal_reference", circulating: { celo: 2_000_000 } }),
      existing: makeExistingEvent({ id: 7, stablecoin_id: "zarm-mento", symbol: "ZARm", peg_type: "peggedZAR", direction: "below", peak_deviation_bps: -400, started_at: T1 - 3_600, start_price: 0.96, peak_price: 0.96, peg_reference: 1, recovery_evidence_source: "native", ...recWin(T1) }),
      nativePegQuote: { stablecoinId: "zarm-mento", geckoId: "celo-south-african-rand", pegCurrency: "ZAR", price: 0.999, updatedAt: T1_60, derivation: tradedPair },
    });
    expect(d.commands).toEqual([closeCmd(7, T1, "recovered-native", { recoveryPrice: 0.999, recoveryPegReference: 1 })]);
  });

  it("closes a native-peg event after sustained recovery in native units", () => {
    const d = runBrl(0.1919, { existing: makeExistingEvent({ ...brzNativeEvent(), recovery_evidence_source: "native", recovery_first_seen_at: T0_60, recovery_last_seen_at: T0 }), nativePegQuote: brzQuote(0.997, T1_60) });
    expect(d.commands).toEqual([closeCmd(7, T1, "recovered-native", { recoveryPrice: 0.997, recoveryPegReference: 1 })]);
  });

  it.each(["pyth", "coingecko"])("closes a USD-domain row from native-only recovery without inventing a USD price (%s)", (priceSource) => {
    const d = runBrl(0.18, {
      ...clockedBenchmark("peggedREAL", 0.19, T1_60),
      existing: makeExistingEvent({ quote_mode: "usd", direction: "below", peg_reference: 0.19, recovery_evidence_source: "native", recovery_first_seen_at: T0_60, recovery_last_seen_at: T0 }),
      nativePegQuote: brzQuote(1, T1_60),
    }, { priceSource, ...upAt(T1_60) });
    expect(d.commands).toEqual([closeCmd(7, T1, "recovered-native", { recoveryPegReference: null })]);
  });

  it("holds a native-peg event open when the native quote is missing", () => {
    const d = runBrl(0.1919, { existing: brzNativeEvent() });
    expect(d.seenEventIds).toEqual([7]);
    expect(d.commands).toEqual([]);
  });

  it("does not supersede a native event from an opposite USD-domain signal", () => {
    const d = runBrl(0.195, { existing: brzNativeEvent(), nativePegQuote: brzQuote(0.9758, T1_60) });
    expect(d.seenEventIds).toEqual([7]);
    expect(d.commands).not.toContainEqual(expect.objectContaining({ type: "close-event", closeReason: "superseded-direction" }));
  });

  it("supersedes a native-peg event when the native quote reverses direction", () => {
    const d = runBrl(0.1919, { existing: brzNativeEvent(), nativePegQuote: brzQuote(1.03, T1_60) });
    expect(d.seenEventIds).toEqual([]);
    expect(d.commands).toEqual([
      closeCmd(7, T1_60, "superseded-direction"),
      expect.objectContaining({ type: "upsert-pending", payload: expect.objectContaining({ stablecoinId: BRZ, direction: "above", bps: 300, price: 1.03, pegReference: 1, reason: expect.stringContaining("native-origin") }) }),
    ]);
  });

  it("keeps a live event when an untrusted primary reading reverses direction", () => {
    const d = runUsd({ price: 1.02, priceSource: "cached", priceConfidence: "low" }, { existing: makeUsdEvent() });
    expect(d.seenEventIds).toEqual([7]);
    expect(d.commands).toEqual([]);
    expect(d.diagnostics).toEqual(diag("[depeg] Kept live event for USDT (id=7) through confirm-required opposite reading: existing=below, primary=above (200bps)"));
  });

  it("closes a live event when circulating coverage falls below the event floor", () => {
    const d = runUsd({ circulating: { ethereum: 1 } }, { existing: makeUsdEvent({}, false) });
    expect(d.seenEventIds).toEqual([]);
    expect(d.commands).toEqual([closeCmd(7, T1, "coverage-lost-supply")]);
    expect(d.diagnostics).toEqual(diag("[depeg] Closing live event for USDT: supply $1 is below the live-event floor", "log"));
  });

  it.each<{ label: string; circulating: Record<string, number> }>([
    { label: "absent buckets", circulating: {} }, { label: "wholly invalid buckets", circulating: { ethereum: Number.NaN } },
  ])("keeps a live event open when current supply is unavailable ($label)", ({ circulating }) => {
    const d = runUsd({ circulating }, { existing: makeUsdEvent({}, false) });
    expect(d.seenEventIds).toEqual([7]);
    expect(d.commands).toEqual([]);
    expect(d.diagnostics).toEqual(diag("[depeg] Kept live event for USDT open: current supply is unavailable, so the live-event floor cannot be assessed"));
  });

  it("still closes a live event on an explicit observed zero supply", () => {
    const d = runUsd({ circulating: { ethereum: 0 } }, { existing: makeUsdEvent({}, false) });
    expect(d.commands).toEqual([closeCmd(7, T1, "coverage-lost-supply")]);
  });

  it("preserves a live event when a thin fiat peg reference is not authoritative", () => {
    const d = runBrl(0.1919, { existing: makeExistingEvent(), pegRates: { peggedREAL: 0.191895 }, pegRateSources: { peggedREAL: "median" }, pegRateCounts: { peggedREAL: 2 } });
    expect(d.seenEventIds).toEqual([7]);
    expect(d.commands).toEqual([]);
    expect(d.diagnostics).toEqual(diag("[depeg] Skipped live-state mutation for BRZ: thin BRL peg reference lacks FX fallback"));
  });

  it("keeps an ongoing event open when only the aggregate DEX price disagrees", () => {
    const d = runUsd({}, { existing: makeUsdEvent({ started_at: 1_750_256_500 }), dexRow: makeDexRow(1.001, { source_pool_count: 5 }) });
    expect(d.seenEventIds).toEqual([7]);
    expect(d.commands).toEqual([]);
    expect(d.diagnostics).toEqual(diag("[depeg] DEX disagrees with ongoing event for USDT: primary=-200bps vs DEX=10bps (event age 60min); keeping event open until the recovery path confirms resolution"));
  });

  it("suppresses a new event when legacy USD rows have a confirming DEX protocol quorum", () => {
    const d = runUsd({ priceSource: "dex-promoted" }, { dexRow: makeDexRow(0.999), protocolSources: twoProtos(0.999, 1.001) });
    expect(d.seenEventIds).toEqual([]);
    expect(d.commands).toEqual([]);
    expect(d.diagnostics).toEqual(diag("[depeg] Suppressed new event for USDT: primary=-200bps but DEX=10bps (2 pools, $5.0M TVL)", "log"));
  });

  it("clears recovery progress when independent DEX protocols still show the depeg", () => {
    const d = runUsd({ price: 1.001 }, { existing: makeUsdEvent({ recovery_first_seen_at: 1_750_259_500, recovery_last_seen_at: T1_60 }), dexRow: makeDexRow(0.98), protocolSources: twoProtos(0.98, 0.981) });
    expect(d.seenEventIds).toEqual([7]);
    expect(d.commands).toEqual([{ type: "clear-recovery", id: 7 }]);
    expect(d.diagnostics).toEqual(diag("[depeg] Kept USDT open despite primary recovery: primary recovery is contradicted by 2 DEX protocol group(s) still showing the below depeg"));
  });

  it("keeps a recovered reading open when DEX recovery lacks independent support", () => {
    const d = runUsd({ price: 1.001, priceSource: "cached", priceConfidence: "low" }, { existing: makeUsdEvent(), dexRow: makeDexRow(0.999, { source_pool_count: 1 }), protocolSources: [proto("curve", 0.999, 5_000_000)] });
    expect(d.seenEventIds).toEqual([7]);
    expect(d.commands).toEqual([]);
    expect(d.diagnostics).toEqual(diag("[depeg] Ignored aggregate DEX recovery for USDT: 1 corroborating protocol group(s), challenged=false; keeping event open until corroborated recovery appears"));
  });

  it("continues recovery after a recent confirming observation", () => {
    const d = runUsd({ price: 1.001 }, { existing: makeUsdEvent({ recovery_first_seen_at: 1_750_259_800, recovery_last_seen_at: T1_60 }) });
    expect(d.seenEventIds).toEqual([7]);
    expect(d.commands).toEqual([{ type: "continue-recovery", id: 7, lastSeenAt: T1 }]);
  });

  it("clears recovery progress when the primary price returns to the depeg", () => {
    const d = runUsd({}, { existing: makeUsdEvent({ peak_deviation_bps: -300, peak_price: 0.97, recovery_first_seen_at: 1_750_259_800, recovery_last_seen_at: T1_60 }) });
    expect(d.seenEventIds).toEqual([7]);
    expect(d.commands).toEqual([{ type: "clear-recovery", id: 7 }]);
  });

  it("keeps an event open until the full recovery window elapses", () => {
    const tol = DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC;
    const ds = [tol - 1, tol, tol + 1].map((gap) => runUsd({ price: 1.001 }, { existing: makeUsdEvent({ recovery_first_seen_at: T1 - gap - 900, recovery_last_seen_at: T1 - gap }) }));
    expect(ds[0]?.commands[0]?.type).toBe("close-event");
    expect(ds[1]?.commands[0]?.type).toBe("close-event");
    expect(ds[2]?.commands).toEqual([{ type: "begin-recovery", id: 7, firstSeenAt: T1, lastSeenAt: T1 }]);
  });

  it("clears a partial recovery when price returns to the deadband", () => {
    const d = runUsd({ price: 0.993 }, { existing: makeUsdEvent({ recovery_first_seen_at: 1_750_259_500 }) });
    expect(d.seenEventIds).toEqual([7]);
    expect(d.commands).toEqual([{ type: "clear-recovery", id: 7 }]);
  });

  it("updates a native-peg event peak from the native quote domain", () => {
    const d = runBrl(0.1879, { existing: brzNativeEvent(), nativePegQuote: brzQuote(0.97, T1_60) });
    expect(d.commands).toMatchObject([{ type: "update-peak", id: 7, peakDeviationBps: -300, peakPrice: 0.97, peakPegReference: 1, peakQuoteDomain: "native-peg", peakReceipt: expect.stringContaining('"venue":"bitso"') }]);
  });

  it("updates a native-peg event peak when the USD primary is inside the trigger threshold", () => {
    const d = runBrl(0.19, { existing: brzNativeEvent(), nativePegQuote: brzQuote(0.95, T1_60) });
    expect(d.observation).toEqual({ kind: "observed" });
    expect(d.seenEventIds).toEqual([7]);
    expect(d.commands).toContainEqual(expect.objectContaining({ type: "update-peak", id: 7, peakDeviationBps: -500, peakPrice: 0.95, peakPegReference: 1, peakQuoteDomain: "native-peg" }));
  });

  it("keeps an existing event open when a high-TVL pool challenger contradicts primary recovery", () => {
    const d = decide({
      now: T2, ...usdPeg, meta: makeMeta("apxusd-apyx", "apxUSD"),
      asset: cgDlAsset(1.0006461557, T2 - 60, { id: "apxusd-apyx", symbol: "apxUSD" }),
      existing: makeUsdEvent({ id: 90089, stablecoin_id: "apxusd-apyx", symbol: "apxUSD", peak_deviation_bps: -1059, started_at: 1_780_437_028, start_price: 0.9892624763, peak_price: 0.8938719491 }),
      challengerPools: [pool(0.952866583, 52_000_000, "curve", "ethereum", "geckoterminal")],
    });
    expect(d.trackedCoinId).toBe("apxusd-apyx");
    expect(d.seenEventIds).toEqual([90089]);
    expect(d.commands).toHaveLength(0);
    expect(d.diagnostics).toEqual(keptOpen("apxUSD", "below", 1, 0, true));
  });

  it("allows authoritative primary recovery when only one small pool challenger disagrees", () => {
    const d = decide({
      now: T2, ...usdPeg, meta: usdMeta, asset: cgDlAsset(1.0006, T2 - 60),
      existing: makeUsdEvent({ id: 42, peak_deviation_bps: -250, started_at: 1_780_600_000 }),
      challengerPools: [pool(0.985, 250_000, "curve", "ethereum", "geckoterminal")],
    });
    expect(d.seenEventIds).toEqual([42]);
    expect(d.commands).toEqual([{ type: "begin-recovery", id: 42, firstSeenAt: T2, lastSeenAt: T2 }]);
  });

  it("allows primary recovery when two dormant diverging pools are outvoted by four at-peg pools", () => {
    // 2026-09-24 dex_price_challengers vchf-vnx: 2 dormant pools (celo univ3, icp kongswap) outvoted by 4 at-peg protocols.
    const now = 1_790_226_624;
    const d = decide({
      now, meta: chfMeta, ...clockedBenchmark("peggedCHF", 1.2128709869131222, now - 60, "fx"),
      asset: cgDlAsset(1.2130161427, now - 60, { id: "vchf-vnx", symbol: "VCHF", pegType: "peggedCHF", priceObservedAt: now - 60, priceObservedAtMode: "upstream", circulating: { ethereum: 5_000_000 } }),
      existing: makeExistingEvent({ id: 90792, stablecoin_id: "vchf-vnx", symbol: "VCHF", peg_type: "peggedCHF", direction: "above", peak_deviation_bps: 640, started_at: now - 6 * D, start_price: 1.2887194119, peak_price: 1.2887194119, peg_reference: 1.2128709869131222 }),
      challengerPools: [
        pool(1.2887194119, 4_712_969.3671, "uniswap-v3", "celo"), pool(1.2745982598, 380_730.3996, "kongswap", "icp"),
        pool(1.2130161427, 524_244.1538, "icpswap", "icp"), pool(1.2211210441, 414_750.15, "raydium", "solana", "direct_api"),
        pool(1.2180939432, 184_761.4457, "aerodrome", "base", "direct_api"), pool(1.2000335351, 130_340.6422, "meteora", "solana"),
      ],
    });
    expect(d.trackedCoinId).toBe("vchf-vnx");
    expect(d.seenEventIds).toEqual([90792]);
    expect(d.commands).toEqual([{ type: "begin-recovery", id: 90792, firstSeenAt: now - 60, lastSeenAt: now - 60 }]);
    expect(d.diagnostics).toEqual([]);
  });

  it.each(["clockless", "pre-reopen", "current"])("requires the %s challenger quote to pass its own FX admission for a recovery veto", (clock) => {
    const reopen = Date.UTC(2026, 10, 15, 22) / 1_000, now = reopen + 120, at = now - 30;
    const d = decide({
      ...clockedBenchmark("peggedREAL", 1, now - 60), now, meta: brlMeta, asset: brzAsset(1, { priceObservedAt: at, priceUpdatedAt: at }),
      existing: makeExistingEvent({ started_at: reopen - D, direction: "below", peak_deviation_bps: -300, peg_reference: 1, quote_mode: "usd" }),
      challengerPools: [pool(0.97, 6_000_000, "curve", "ethereum", "dl", clock === "current" ? at : clock === "pre-reopen" ? reopen - 15 : undefined)],
    });
    expect(d.commands.map((c) => c.type)).toEqual(clock === "current" ? [] : ["begin-recovery"]);
  });

  it("keeps an event open when the diverging pools are the majority against the recovered price", () => {
    const d = decide({
      now: T2, meta: usdMeta, ...usdPeg, asset: cgDlAsset(1.0004, T2 - 60),
      existing: makeUsdEvent({ id: 42, direction: "above", peak_deviation_bps: 250, started_at: T2 - 3_600, start_price: 1.025, peak_price: 1.025 }),
      challengerPools: [pool(1.02, 1e6, "curve", "ethereum", "geckoterminal"), pool(1.021, 1e6, "uniswap-v3"), pool(1.0005, 1e6, "raydium", "solana", "direct_api")],
    });
    expect(d.seenEventIds).toEqual([42]);
    expect(d.commands).toEqual([]);
    expect(d.diagnostics).toEqual(keptOpen("USDT", "above", 2, 1));
  });

  it("keeps the diverging set decisive on a tie against corroborating pools", () => {
    const d = decide({
      now: T2, meta: usdMeta, ...usdPeg, asset: cgDlAsset(1.0004, T2 - 60),
      existing: makeUsdEvent({ id: 42, direction: "above", peak_deviation_bps: 250, started_at: T2 - 3_600, start_price: 1.025, peak_price: 1.025 }),
      challengerPools: [pool(1.02, 1e6, "curve", "ethereum", "geckoterminal"), pool(1.021, 1e6, "uniswap-v3"), pool(1.0005, 1e6, "raydium", "solana", "direct_api"), pool(0.9995, 1e6, "orca", "solana")],
    });
    expect(d.seenEventIds).toEqual([42]);
    expect(d.commands).toEqual([]);
    expect(d.diagnostics).toEqual(keptOpen("USDT", "above", 2, 2));
  });

  it.each([undefined, 1_790_231_400])("keeps soft-source recovery open with publication-only challenger time %s", (obsAt) => {
    // 2026-09-24 live D1 (90781, usdb-blast): CG single-source + 5 in-band pools, no aggregate dex_prices row.
    const d = decide({
      now: T3, ...usdPeg, meta: makeMeta("usdb-blast", "USDB", "USD", { name: "USDB Blast" }),
      asset: cgUpAsset(0.9998628369821569, T3 - 107, { id: "usdb-blast", symbol: "USDB", circulating: { blast: 11_348_078.487122247 } }),
      existing: makeUsdEvent({ id: 90781, stablecoin_id: "usdb-blast", symbol: "USDB", direction: "above", peak_deviation_bps: 129, started_at: 1_787_295_709, start_price: 1.0102326760456513, peak_price: 1.0129092357526068, peg_reference: 0.999963, ...recWin(T3) }),
      challengerPools: [
        pool(0.995936075327477, 1_047_212.8546, "thruster-v3", "blast", "cg_onchain", obsAt),
        pool(0.997280614842842, 290_687.4629, "thruster-v3", "blast", "cg_onchain", obsAt),
        pool(0.999821125971321, 157_208.1985, "thruster-v3", "blast", "cg_onchain", obsAt),
        pool(1.0007739191, 108_478.947, "monoswap-v3-blast", "blast", "cg_onchain", obsAt),
        pool(0.996110886724201, 103_778.0611, "blasterswap", "blast", "cg_onchain", obsAt),
      ],
    });
    expect(d.seenEventIds).toEqual([90781]);
    expect(d.commands).toEqual([{ type: "continue-recovery", id: 90781, lastSeenAt: T3 - 107 }]);
    expect(d.diagnostics).toEqual([]);
  });

  it("keeps gold-peg recovery open without original challenger observation times", () => {
    const d = decide({
      now: T3, meta: goldMeta, ...clockedBenchmark("peggedGOLD", 4285, T3 - 60, "fallback"),
      asset: cgUpAsset(137.80559627497053, T3 - 77, { id: "vnxau-vnx", symbol: "VNXAU", pegType: "peggedGOLD", circulating: { ethereum: 6_063_570.880773928 } }),
      existing: makeExistingEvent({ id: 90760, stablecoin_id: "vnxau-vnx", symbol: "VNXAU", peg_type: "peggedGOLD", direction: "below", peak_deviation_bps: -178, started_at: 1_785_939_393, start_price: 133.18916240810498, peak_price: 133.36101778049144, peg_reference: 135.77096114706222, ...recWin(T3) }),
      challengerPools: [pool(137.508294070839, 263_932, "raydium", "solana", "direct_api"), pool(138.145893, 103_282, "aerodrome", "base", "direct_api")],
    });
    expect(d.seenEventIds).toEqual([90760]);
    expect(d.commands).toEqual([{ type: "continue-recovery", id: 90760, lastSeenAt: T3 - 77 }]);
    expect(d.diagnostics).toEqual([]);
  });

  it.each([
    ["begins", null, null, false, ["begin-recovery"]], ["continues under 24 h", 3_600, 600, false, ["continue-recovery"]],
    ["closes at 24 h", 86_460, 600, false, ["close-event"]], ["begins DEX recovery with agreeing primary", null, null, "agreeing-dex", ["begin-recovery"]],
    ["continues primary recovery with only one fresh DEX family", 3_600, 600, "one-family", ["continue-recovery"]],
    ["finishes primary recovery with agreeing DEX", 86_460, 900, "agreeing-dex", ["close-event"]],
    ["stops on a pool veto", 3_600, 600, "pool", ["clear-recovery"]], ["stops on a stale liquid DEX lane", 3_600, 600, "dex", ["clear-recovery"]],
    ["stops on a fresh DEX outside the band", 3_600, 600, "band", ["clear-recovery"]], ["stops on a raw 50.4 bps DEX reading", 86_460, 600, "raw", ["clear-recovery"]],
    ["stops on an unclocked liquid FX DEX row", 86_460, 600, "unclocked-fx", ["clear-recovery"]], ["needs an upstream-dated quote", 3_600, 600, "local", ["clear-recovery"]],
  ] as const)("sustained single-source recovery %s", (_label, firstSeenAge, lastSeenAge, veto, expected) => {
    const now = T3, fx = veto === "unclocked-fx";
    const d = decide({
      now, meta: fx ? brlMeta : usdMeta, ...(fx ? clockedBenchmark("peggedREAL", 0.191, now - 60) : usdPeg),
      asset: makeAsset({ price: fx ? 0.1909 : 0.999, pegType: fx ? "peggedREAL" : "peggedUSD", priceSource: "coingecko", priceConfidence: "single-source", priceObservedAtMode: veto === "local" ? "local_fetch" : "upstream", priceObservedAt: now - 60, circulating: { ethereum: 5_000_000 } }),
      existing: makeUsdEvent(firstSeenAge == null ? {} : { recovery_first_seen_at: now - firstSeenAge, recovery_last_seen_at: now - (lastSeenAge ?? 0) }),
      challengerPools: veto === "pool" ? [pool(0.98, 6_000_000, "curve")] : undefined,
      protocolSources: veto === "agreeing-dex" || veto === "one-family" ? (veto === "one-family" ? ["curve"] : ["curve", "uniswap"]).map((p) => proto(p, 0.999, 2_500_000, now - 120, p, { updatedAt: now - 60 })) : undefined,
      ...(veto === "dex" || veto === "band" || veto === "raw" || veto === "agreeing-dex" || veto === "one-family" || fx ? {
        dexRow: makeDexRow(fx ? 0.1909 : veto === "raw" ? 0.99496 : veto === "dex" || veto === "agreeing-dex" || veto === "one-family" ? 0.999 : 0.992,
          { updated_at: now - (veto === "dex" ? 7_200 : 60), aggregateObservedAt: fx ? null : now - (veto === "dex" ? 7_200 : 60) }),
      } : {}),
    });
    expect(d.commands.map(({ type }) => type)).toEqual(expected);
    if (veto === "agreeing-dex" && expected[0] === "begin-recovery") expect(d.commands[0]).toEqual({ type: "begin-recovery", id: 7, firstSeenAt: now - 60, lastSeenAt: now - 60, source: "dex" });
    if (expected[0] === "close-event") {
      expect(d.commands[0]).toMatchObject({ recoveryPrice: 0.999, recoveryPegReference: 1, closeReason: "recovered-primary" });
      expect(d.diagnostics).toEqual(diag("[depeg] Closing live event for USDT after 24 h of sustained single-source recovery", "log"));
    }
  });

  it.each([
    [134, goldMeta, { peggedGOLD: 4285 }, { kind: "unavailable", reason: "reference-market-closed" }, []],
    [100, goldMeta, { peggedGOLD: 4285 }, { kind: "observed" }, ["upsert-pending"]],
    [0.1919, brlMeta, brlPeg.pegRates, { kind: "unavailable", reason: "invalid-reference" }, []],
  ] as const)("uses legacy closure policy only for benchmarks without reference evidence (price %s)", (price, meta, pegRates, observation, commands) => {
    const now = 1_794_758_400; // Sun 16:00 UTC
    const d = decide({ now, asset: makeAsset({ id: meta.id, symbol: meta.symbol, price, priceUpdatedAt: now, pegType: `pegged${meta.flags.pegCurrency}` }), meta, pegRates, pegRateSources: { peggedGOLD: "median", peggedREAL: "median" }, pegRateCounts: { peggedGOLD: 4, peggedREAL: 3 } });
    expect(d.observation).toEqual(observation);
    expect(d.commands.map((c) => c.type)).toEqual(commands);
  });

  it("keeps an in-band soft-source event open when a high-TVL challenger pool still shows the depeg", () => {
    // 2026-09-24 live D1 (90786, hollar-hydrated): low-conf CG at -18 bps vs hydration-dex pools at ~-526 bps (>$5M).
    const d = decide({
      now: T3, ...usdPeg, meta: makeMeta("hollar-hydrated", "HOLLAR", "USD", { name: "Hydrated Dollar", geckoId: "hydrated-dollar" }),
      asset: cgUpAsset(0.9981523059225438, T3 - 77, { id: "hollar-hydrated", symbol: "HOLLAR", priceConfidence: "low", circulating: { hydration: 12_833_596.24937689 } }),
      existing: makeUsdEvent({ id: 90786, stablecoin_id: "hollar-hydrated", symbol: "HOLLAR", peak_deviation_bps: -525, started_at: 1_787_695_308, start_price: 0.947458, peak_price: 0.947458, ...recWin(T3) }),
      challengerPools: [pool(0.9474579112, 11_916_235.7742, "hydration-dex", "hydration"), pool(0.9474396418, 2_460_799.2408, "hydration-dex", "hydration"), pool(0.9474579112, 2_255_904.79, "hydration-dex", "hydration"), pool(0.947411, 746_895.7, "hydration-dex", "hydration")],
    });
    expect(d.seenEventIds).toEqual([90786]);
    expect(d.commands).toEqual([{ type: "clear-recovery", id: 90786 }]);
    expect(d.diagnostics).toEqual(keptOpen("HOLLAR", "below", 1, 0, true));
  });

  it("keeps an in-band soft-source event open when only one challenger group corroborates the band", () => {
    // 2026-09-24 live D1 (90777, audf-forte): single curve pool (-24 bps) below POOL_CHALLENGE_CONFIRM_MIN.
    const d = decide({
      now: T3, meta: makeMeta("audf-forte", "AUDF", "AUD", { name: "Forte AUD", geckoId: "forte-aud" }), ...clockedBenchmark("peggedAUD", 0.7067137809187279, T3 - 60, "fx"),
      asset: cgUpAsset(0.7030877342041957, T3 - 77, { id: "audf-forte", symbol: "AUDF", pegType: "peggedAUD", circulating: { ethereum: 3_566_436.4980290816 } }),
      existing: makeExistingEvent({ id: 90777, stablecoin_id: "audf-forte", symbol: "AUDF", peg_type: "peggedAUD", direction: "below", peak_deviation_bps: -287, started_at: 1_786_944_681, start_price: 0.9849393364193147, peak_price: 0.699732524541874, peg_reference: 0.71128258 }),
      challengerPools: [pool(0.704981734354013, 111_651.66302719248, "curve", "ethereum", "dl")],
    });
    expect(d.seenEventIds).toEqual([90777]);
    expect(d.commands).toEqual([{ type: "begin-recovery", id: 90777, firstSeenAt: T3 - 77, lastSeenAt: T3 - 77 }]);
    expect(d.diagnostics).toEqual([]);
  });

  it("requires the challenger corroborating groups to outvote the diverging set", () => {
    const dusd = makeMeta("dusd-test", "DUSD");
    const run = (corrob: ReturnType<typeof pool>[]) => decide({
      now: T2, ...usdPeg, meta: dusd, asset: cgUpAsset(0.9995, T2 - 60, { id: "dusd-test", symbol: "DUSD", circulating: { ethereum: 5_000_000 } }),
      existing: makeUsdEvent({ id: 55, stablecoin_id: "dusd-test", symbol: "DUSD", peak_deviation_bps: -300, started_at: T2 - D, start_price: 0.97, peak_price: 0.97, ...recWin(T2) }),
      challengerPools: [pool(0.985, 1e6, "curve"), pool(0.986, 1e6, "uniswap-v3"), ...corrob],
    });
    const base = [pool(0.9985, 1e6, "raydium", "solana", "direct_api"), pool(0.999, 1e6, "orca", "solana")];
    const tie = run(base);
    expect(tie.commands).toEqual([{ type: "clear-recovery", id: 55 }]);
    expect(tie.diagnostics).toEqual(keptOpen("DUSD", "below", 2, 2));
    const outvoted = run([...base, pool(0.9975, 1e6, "meteora", "solana")]);
    expect(outvoted.commands).toEqual([{ type: "clear-recovery", id: 55 }]);
    expect(outvoted.diagnostics).toEqual([]);
  });

  it("does not bypass a challenged aggregate DEX lane with the pool-challenger majority", () => {
    const d = decide({
      now: T2, ...usdPeg, meta: makeMeta("dusd-test", "DUSD"),
      asset: cgUpAsset(1.0005, T2 - 60, { id: "dusd-test", symbol: "DUSD", circulating: { ethereum: 5_000_000 } }),
      existing: makeUsdEvent({ id: 55, stablecoin_id: "dusd-test", symbol: "DUSD", direction: "above", peak_deviation_bps: 250, started_at: T2 - D, start_price: 1.025, peak_price: 1.025 }),
      dexRow: makeDexRow(1.0005, { stablecoin_id: "dusd-test", deviation_from_primary_bps: 5, source_pool_count: 3, source_total_tvl: 6_000_000, updated_at: T2 - 60, aggregateObservedAt: T2 - 60 }),
      protocolSources: [proto("curve", 1.0005, 3_000_000, T2 - 60, "dl"), proto("uniswap-v3", 1.0006, 3_000_000, T2 - 60, "cg_onchain")],
      challengerPools: [pool(1.02, 200_000, "curve", "ethereum", "dl"), pool(1.0004, 150_000, "uniswap-v3")],
    });
    expect(d.seenEventIds).toEqual([55]);
    expect(d.commands).toEqual([]);
    expect(d.diagnostics).toEqual(diag("[depeg] Ignored aggregate DEX recovery for DUSD: 2 corroborating protocol group(s), challenged=true; keeping event open until corroborated recovery appears"));
  });

  describe("Day-30+ escalation guards", () => {
    const t0 = Date.UTC(2026, 10, 18, 12) / 1_000;
    const cov = (at: number) => ({ last_trusted_price_at: at, price_coverage_gap_started_at: null, price_coverage_json: JSON.stringify({ intervals: [[t0 - 31 * D, at]], lastObservationKind: "trusted-off-peg" }) });
    const auth = (now: number, price: number, extra: Partial<PegAssetBase> = {}) => makeAsset({ price, priceSource: "pyth", priceConfidence: "single-source", ...upAt(now - 30), ...extra });
    const escOf = (now: number, existing: DepegDetectionRow, price: number, extra?: Partial<PegAssetBase>) =>
      decide({ ...usdInput, now, existing, asset: auth(now, price, extra) }).commands.find((c) => c.type === "update-escalation");
    const uEsc = (
      peakEscalationAnchorBps: number | null,
      peakEscalationCandidateAt: number | null = null,
      peakEscalatedAt: number | null = null,
      peakEscalationCandidateSeenAt: number | null = peakEscalationCandidateAt,
    ) => ({ type: "update-escalation", id: 7, peakEscalatedAt, peakEscalationAnchorBps, peakEscalationCandidateAt, peakEscalationCandidateSeenAt });
    const armedBrl = (now: number, cAt: number, extra: Partial<DepegDetectionRow> = {}) =>
      makeExistingEvent({ quote_mode: "usd", direction: "below", started_at: now - 35 * D, peg_reference: 1, peak_deviation_bps: -700, peak_escalation_anchor_bps: 400, peak_escalation_candidate_at: cAt, peak_escalation_candidate_seen_at: cAt, ...cov(cAt), ...extra });
    const pythBrl = (now: number, price: number, extra: Partial<PegAssetBase> = {}) => brzAsset(price, { priceSource: "pyth", priceObservedAt: now - 30, priceUpdatedAt: now - 30, ...extra });

    it("guards local_fetch/null/replay, >20m gap, rollback advance, sub-15m spacing, fallback hydration, and negative anchor", () => {
      const cAt = t0 - 30, unseeded = makeUsdEvent({ started_at: t0 - 31 * D, peak_deviation_bps: -400 });
      for (const extra of [{ priceObservedAtMode: "local_fetch" as const }, { priceObservedAt: null }]) expect(escOf(t0, unseeded, 0.93, extra)).toBeUndefined();
      const base = { started_at: t0 - 35 * D, peak_deviation_bps: -700, peak_escalation_anchor_bps: 400, peak_escalation_candidate_at: cAt, peak_escalation_candidate_seen_at: cAt }, armed = makeUsdEvent({ ...base, ...cov(cAt) });
      for (const extra of [{ priceObservedAtMode: "local_fetch" as const }, { priceObservedAt: null }]) expect(escOf(t0 + 900, armed, 0.93, extra)).toEqual(uEsc(400));
      expect(escOf(t0 + 900, armed, 0.93, { priceObservedAt: cAt, priceUpdatedAt: cAt })).toBeUndefined();
      expect(escOf(t0 + 3_600, armed, 0.93)).toEqual(uEsc(400, t0 + 3_570));
      expect(escOf(cAt + 1_230, makeUsdEvent({ ...base, ...cov(cAt + 960) }), 0.93)).toEqual(uEsc(400, cAt + 1_200));
      // Rolled-back Worker advancing coverage at +10m (without advancing candidate_seen_at) must reject confirmation.
      expect(escOf(cAt + 1_530, makeUsdEvent({ ...base, ...cov(cAt + 600) }), 0.93)).toEqual(uEsc(400, cAt + 1_500));
      // Sustained <15m cadence ([890s, 890s]) pins candidate_at, advances candidate_seen_at, and confirms once >=15m elapsed.
      expect(escOf(t0 + 890, armed, 0.93)).toEqual(uEsc(400, cAt, null, cAt + 890));
      expect(escOf(t0 + 1_780, makeUsdEvent({ ...base, peak_escalation_candidate_seen_at: cAt + 890, ...cov(cAt + 890) }), 0.93)).toEqual(uEsc(700, null, cAt + 1_780));
      // Higher carry-forward anchor invalidates prior candidate; base fallback preserves state and clears candidate without confirming.
      expect(escOf(t0, makeUsdEvent({ started_at: t0 - 35 * D, peak_deviation_bps: -400, peak_escalation_anchor_bps: 400, ...cov(t0 - 930) }), 0.932)).toEqual(uEsc(400, cAt));
      expect(escOf(t0 + 900, makeUsdEvent({ ...base, carry_forward_escalation_anchor_bps: 1_000, ...cov(cAt) }), 0.87)).toEqual(uEsc(1_000, t0 + 870));
      expect(escOf(t0 + 900, makeUsdEvent({ ...base, escalation_metadata_hydrated: false, ...cov(cAt) }), 0.93)).toEqual(uEsc(400));
      // Negative/below-threshold stored anchor reseeds cleanly instead of manufacturing an escalation target.
      expect(escOf(t0, makeUsdEvent({ started_at: t0 - 35 * D, peak_deviation_bps: -200, peak_escalation_anchor_bps: -100, peak_escalation_candidate_at: cAt - 900, peak_escalation_candidate_seen_at: cAt - 900, ...cov(cAt - 900) }), 0.984)).toEqual(uEsc(160));
    });

    it("guards confirm_required clears, pre-Day-30 clock, deadband seeding, and hydrated <=30d reset vs unhydrated fallback", () => {
      const cAt = t0 - 30, base = makeUsdEvent({ started_at: t0 - 35 * D, peak_deviation_bps: -700, peak_escalation_anchor_bps: 400, ...cov(t0 - 930) });
      expect(escOf(t0, base, 0.93)).toEqual(uEsc(400, cAt));
      const armed = { ...base, peak_escalation_candidate_at: cAt, peak_escalation_candidate_seen_at: cAt, ...cov(cAt) };
      for (const price of [0.93, 0.9925, 0.999]) expect(escOf(t0 + 450, armed, price, { priceSource: "coingecko", priceConfidence: "low" })).toEqual(uEsc(400));
      expect(escOf(t0 + 900, { ...armed, peak_escalation_candidate_at: null, peak_escalation_candidate_seen_at: null }, 0.93)).toEqual(uEsc(400, t0 + 870));
      const s0 = t0 - 30 * D - 60;
      expect(escOf(t0, makeUsdEvent({ started_at: s0, peak_deviation_bps: -400 }), 0.96, { priceObservedAt: s0 + 30 * D, priceUpdatedAt: s0 + 30 * D })).toBeUndefined();
      // A replayed pre-Day-30 deadband quote is no new tick, so it cannot clear a candidate armed after Day 30.
      expect(escOf(t0, makeUsdEvent({ started_at: s0, peak_deviation_bps: -700, peak_escalation_anchor_bps: 400, peak_escalation_candidate_at: cAt, peak_escalation_candidate_seen_at: cAt, ...cov(cAt) }), 0.994, { priceObservedAt: t0 - 100, priceUpdatedAt: t0 - 100 })).toBeUndefined();
      const db = makeUsdEvent({ started_at: t0 - 31 * D, peak_deviation_bps: -200 });
      expect(escOf(t0, db, 0.9925)).toEqual(uEsc(100));
      const seeded = { ...db, peak_escalation_anchor_bps: 100, ...cov(cAt) };
      expect(escOf(t0 + 900, seeded, 0.964)).toEqual(uEsc(100, t0 + 870));
      expect(escOf(t0 + 1_800, { ...seeded, peak_escalation_candidate_at: t0 + 870, peak_escalation_candidate_seen_at: t0 + 870, ...cov(t0 + 870) }, 0.964)).toEqual(uEsc(360, null, t0 + 1_770));
      const stale = { started_at: t0 - 5 * D, peak_deviation_bps: -300, peak_escalated_at: t0 - D, peak_escalation_anchor_bps: 450, peak_escalation_candidate_at: t0 - 600, peak_escalation_candidate_seen_at: t0 - 600 };
      for (const price of [0.97, 0.999]) expect(escOf(t0, makeUsdEvent({ ...stale, incident_started_at: t0 - 5 * D }), price)).toEqual(uEsc(null));
      // Unhydrated fallback preserves stored anchor & peak_escalated_at, clears transient candidate on newer obs, and no-ops on replay or cleared candidate.
      expect(escOf(t0, makeUsdEvent({ ...stale, peak_escalation_candidate_at: null, peak_escalation_candidate_seen_at: null }), 0.97)).toBeUndefined();
      expect(escOf(t0, makeUsdEvent({ ...stale, ...cov(t0 - 30) }), 0.97)).toBeUndefined();
      // Older deadband quote (T-100 while coverage is already at T-30) must never seed an anchor.
      expect(escOf(t0, makeUsdEvent({ started_at: t0 - 35 * D, peak_deviation_bps: -400, ...cov(t0 - 30) }), 0.994, { priceObservedAt: t0 - 100 })).toBeUndefined();
      const frag = { started_at: t0 - D, peak_deviation_bps: -700, peak_escalation_anchor_bps: 400, peak_escalation_candidate_at: cAt, peak_escalation_candidate_seen_at: cAt, ...cov(cAt) };
      expect(escOf(t0 + 850, makeUsdEvent(frag), 0.97)).toEqual(uEsc(400));
      expect(escOf(t0 + 1_780, makeUsdEvent({ ...frag, incident_started_at: t0 - 40 * D, peak_escalation_candidate_at: null, peak_escalation_candidate_seen_at: null, ...cov(t0 + 820) }), 0.93)).toEqual(uEsc(400, t0 + 1_750));
    });

    it("clears candidate on BRZ veto, early-exit blind/native-unavailable (newer vs replayed clock), closed-session, peer-move, and independentNativeBasis", () => {
      const cAt = t0 - 30;
      const brlDec = (now: number, existing: DepegDetectionRow, asset: PegAssetBase, ref: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        decide({ now, meta: brlMeta, existing, asset, ...ref, ...extra } as DecIn);
      const armedUsdBrl = armedBrl(t0, cAt, { peg_reference: 0.191895 });
      const vetoTick = brlDec(t0 + 450, armedUsdBrl, pythBrl(t0 + 450, 0.191895 * 0.93), clockedBenchmark("peggedREAL", 0.191895, t0 + 420), { nativePegQuote: brzQuote(0.99, t0 + 420) });
      expect(vetoTick.commands).toContainEqual(uEsc(400));
      expect(vetoTick.diagnostics[0]?.message).toContain("Suppressed live depeg mutation");
      expect(brlDec(t0 + 900, { ...armedUsdBrl, peak_escalation_candidate_at: null, peak_escalation_candidate_seen_at: null }, pythBrl(t0 + 900, 0.191895 * 0.93), clockedBenchmark("peggedREAL", 0.191895, t0 + 870)).commands).toContainEqual(uEsc(400, t0 + 870));

      const armedUsd = makeUsdEvent({ started_at: t0 - 35 * D, peak_deviation_bps: -700, peak_escalation_anchor_bps: 400, peak_escalation_candidate_at: cAt, peak_escalation_candidate_seen_at: cAt, ...cov(cAt) });
      expect(escOf(cAt + 450, armedUsd, 0.93, { circulating: {} })).toEqual(uEsc(400));
      expect(escOf(cAt, armedUsd, 0.93, { circulating: {} })).toBeUndefined();
      const armedNative = armedBrl(t0, cAt, { quote_mode: undefined, start_price: 0.97, peak_price: 0.93 });
      for (const [now, expected] of [[cAt + 450, uEsc(400)], [cAt, undefined]] as const) {
        const d = brlDec(now, armedNative, brzAsset(0.191895, { priceObservedAt: now - 30, priceUpdatedAt: now - 30 }), clockedBenchmark("peggedREAL", 0.191895, now - 60));
        expect(d.observation).toEqual({ kind: "unavailable", reason: "native-quote-unavailable" });
        expect(d.commands.find((c) => c.type === "update-escalation")).toEqual(expected);
      }

      expect(brlDec(weekend, armedBrl(weekend, weekend - 930), pythBrl(weekend, 0.7), clockedBenchmark("peggedREAL", 1, fridayBrlClose)).commands).toContainEqual(uEsc(400));
      const armedOpen = armedBrl(t0, t0 - 930), subj = pythBrl(t0, 0.93, { priceSource: "coingecko" }), peers = peerVenues.map((priceSource) => pythBrl(t0, 1, { id: priceSource, priceSource }));
      const emptyFx = { ...referenceState({ peggedREAL: 1 }, t0 - 60), observations: {} }, fxCtx = (rates: Record<string, number>) => ({ pegRates: rates, pegRateSources: { peggedREAL: "fx" as const }, pegRateCounts: { peggedREAL: 0 } });
      const peerRates = { peggedREAL: 1 };
      attachDetectionReferenceContext(peerRates, [subj, ...peers], peerMetadata([subj, ...peers], brlMeta), new Set(), emptyFx).rollbackSupportsPeerEvents = true;
      expect(brlDec(t0, armedOpen, subj, fxCtx(peerRates), { challengerPools: [pool(0.93, 210_000, "curve", "ethereum", "curve", t0 - 30)] }).commands).toContainEqual(uEsc(400));

      const noPeer = { peggedREAL: 1 };
      attachDetectionReferenceContext(noPeer, [], new Map(), new Set(), emptyFx);
      for (const np of [0.995, 0.93]) expect(brlDec(t0, armedOpen, pythBrl(t0, 0.93), fxCtx(noPeer), { nativePegQuote: brzQuote(np, t0 - 30) }).commands).toContainEqual(uEsc(400));
      expect(brlDec(t0, armedOpen, pythBrl(t0, 0.99), clockedBenchmark("peggedREAL", 1, t0 - 60)).commands).toContainEqual(uEsc(400));
    });
  });
});
