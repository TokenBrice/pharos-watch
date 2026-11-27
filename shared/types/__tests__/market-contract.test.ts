import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BLACKLIST_STABLECOINS, BlacklistSummaryResponseSchema } from "../blacklist";
import { DepegEventSchema, DepegEventStoredSnapshotSchema, DepegPendingIncidentSchema, OpenIncidentCoverageSchema, OpenIncidentSnapshotSchema, PegSummaryCoinSchema, PegSummaryResponseSchema, PegSummaryStatsSchema } from "../peg";
import { DexLiquidityHistoryPointSchema } from "../dex-liquidity";
import { PersistedNativePegQuoteSchema } from "../native-peg-quote";
import { StablecoinDataOutputSchema, StablecoinDataSchema, StablecoinListResponseSchema, SupplyHistoryResponseSchema } from "../supply";
import { makeStablecoin } from "../../test-utils/stablecoin";
import { isObservedPrice } from "../../lib/pricing-source-policy";

describe("peg summary quote identity", () => {
  it("preserves legacy quote absence", () => expect(PegSummaryCoinSchema.pick({ price: true }).parse({})).toEqual({}));
  it.each([undefined, null, 0.99, 0, -1, NaN, Infinity])("admits only legacy absence, null or a finite positive price: %s", (price) => {
    expect(PegSummaryCoinSchema.pick({ price: true }).safeParse({ price }).success).toBe(price == null || (Number.isFinite(price) && price > 0));
  });
});

describe("chain partition provenance contract", () => {
  const prov = { basis: "onchain-share", observedAt: 1_700_000_000, onchainUsd: 1_020_000, ratio: 1.02, admission: "entered" };
  it.each(["entered", "retained", "carried"])("preserves %s provenance across list JSON round-trips", (admission) => {
    const chainPartition = { ...prov, admission };
    const payload = StablecoinListResponseSchema.parse({ peggedAssets: [{ ...makeStablecoin(), chainPartition }] });
    expect(payload.peggedAssets[0]!.chainPartition).toEqual(chainPartition);
    expect(StablecoinListResponseSchema.parse(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
  });
  it.each([{ basis: "provider-share" }, { observedAt: 0 }, { observedAt: 1.5 }, { onchainUsd: 0 }, { onchainUsd: Infinity }, { ratio: 0 }, { ratio: NaN }, { admission: "fresh" }])("rejects invalid partition evidence %j", (invalid) => {
    expect(StablecoinDataSchema.safeParse({ ...makeStablecoin(), chainPartition: { ...prov, ...invalid } }).success).toBe(false);
  });
});

describe("price derivation provenance contract (K-207)", () => {
  const deriv = { inheritedFrom: "pathusd-bridge", parentSource: "coingecko", parentConfidence: "single-source", parentObservedAt: 1_700_000_000, parentObservedAtMode: "upstream", parentReplaySafe: true, navMethod: "convertToAssets" };
  it("round-trips derivation and keeps legacy rows without it", () => {
    const payload = StablecoinListResponseSchema.parse({ peggedAssets: [{ ...makeStablecoin(), priceDerivation: deriv }, makeStablecoin()] });
    expect(payload.peggedAssets[0]!.priceDerivation).toEqual(deriv);
    expect(payload.peggedAssets[1]).not.toHaveProperty("priceDerivation");
    expect(StablecoinListResponseSchema.parse(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
  });
  it.each([{ inheritedFrom: "" }, { parentReplaySafe: "yes" }, { navMethod: "totalAssets" }, { parentConfidence: "certain" }, { cachedVaultRate: { rate: 0, rateObservedAt: 1 } }])("rejects invalid derivation evidence %j", (invalid) => {
    expect(StablecoinDataSchema.safeParse({ ...makeStablecoin(), priceDerivation: { ...deriv, ...invalid } }).success).toBe(false);
  });
});

it.each([{ kind: "traded-pair", lineage: { venue: "kraken", pair: "EURS/EUR" } }, { kind: "conversion", lineage: { fxSource: "oxr", fxObservedAtSec: 1_700_000_000 } }, { kind: "unknown", lineage: {} }])("preserves $kind lineage on native quotes and accepts legacy quotes", (derivation) => {
  const legacy = { value: 1, observedAt: 1_700_000_100, source: "coingecko" };
  expect(PersistedNativePegQuoteSchema.parse(legacy)).toEqual(legacy);
  expect(PersistedNativePegQuoteSchema.parse({ ...legacy, derivation })).toEqual({ ...legacy, derivation });
  expect(PersistedNativePegQuoteSchema.safeParse({ ...legacy, derivation: { ...derivation, lineage: { fxObservedAtSec: 1.5 } } }).success).toBe(false);
});

const baseEvent = { id: 1, stablecoinId: "usdt-tether", symbol: "USDT", pegType: "peggedUSD", direction: "below" as const, peakDeviationBps: 120, startedAt: 1_700_000_000, endedAt: 1_700_086_400, startPrice: 1, peakPrice: 0.98, recoveryPrice: 1, pegReference: 1, source: "live" as const };
const baseIncident = { stablecoinId: "usdt-tether", symbol: "USDT", direction: "below" as const, firstSeenAt: 1_700_000_000, lastSeenAt: 1_700_003_600, firstSeenBps: 40, lastSeenBps: 55, peakSeenBps: 60, reason: "threshold-crossing", ageSec: 3_600, expiresAt: 1_700_007_200, availableConfirmationCategories: [], missingConfirmationCategories: [] };

describe("depeg chronology contract", () => {
  it("validates event/pending timelines, retirement marker, and post-expiry pending rows", () => {
    expect(DepegEventSchema.safeParse(baseEvent).success).toBe(true);
    expect(DepegPendingIncidentSchema.safeParse(baseIncident).success).toBe(true);
    const reversed = DepegEventSchema.safeParse({ ...baseEvent, endedAt: baseEvent.startedAt - 1 });
    expect(reversed.success).toBe(false);
    expect(reversed.error!.issues.some((i) => i.path.includes("endedAt"))).toBe(true);
    expect(DepegEventSchema.safeParse({ ...baseEvent, endedAt: baseEvent.startedAt }).success).toBe(false);
    expect(DepegEventSchema.safeParse({ ...baseEvent, endedAt: null }).success).toBe(true);
    expect(DepegEventSchema.safeParse({ ...baseEvent, startedAt: 1_700_000_000.5 }).success).toBe(false);
    expect(DepegEventSchema.safeParse({ ...baseEvent, startedAt: -1 }).success).toBe(false);
    expect(DepegEventSchema.parse({ ...baseEvent, retired: true }).retired).toBe(true);
    expect(DepegEventSchema.parse(baseEvent)).not.toHaveProperty("retired");
    expect(DepegPendingIncidentSchema.safeParse({ ...baseIncident, lastSeenAt: baseIncident.firstSeenAt - 1 }).success).toBe(false);
    expect(DepegPendingIncidentSchema.safeParse({ ...baseIncident, expiresAt: baseIncident.firstSeenAt }).success).toBe(false);
    expect(DepegPendingIncidentSchema.safeParse({ ...baseIncident, lastSeenAt: baseIncident.firstSeenAt + 6_264, ageSec: 6_880, expiresAt: baseIncident.firstSeenAt + 2_700 }).success).toBe(true);
  });

  it.each([
    ["restored-evidenced", "usd", [{ fromSec: baseEvent.startedAt + 60, toSec: baseEvent.startedAt + 120 }, { fromSec: baseEvent.startedAt + 180, toSec: baseEvent.endedAt }]],
    ["admitted-coverage", "usd", []],
    ["repaired", "native-peg", [{ fromSec: baseEvent.startedAt, toSec: baseEvent.endedAt }]],
  ])("preserves %s event observations in the API and archive", (disposition, peakQuoteDomain, admittedCoverage) => {
    const fields = { peakPegReference: 1.05, peakQuoteDomain, recoveryPegReference: 1.07, admittedCoverage, disposition };
    const event = { ...baseEvent, ...fields };
    expect(DepegEventSchema.parse(event)).toMatchObject(fields);
    expect(DepegEventStoredSnapshotSchema.parse([{ ...event, slug: "event" }])[0]).toMatchObject(fields);
    const legacy = DepegEventSchema.parse(baseEvent);
    for (const f of Object.keys(fields)) expect(legacy).not.toHaveProperty(f);
  });

  it.each([{ admittedCoverage: [{ fromSec: 20, toSec: 10 }] }, { admittedCoverage: [{ fromSec: 10, toSec: 10 }] }, { admittedCoverage: [{ fromSec: 10, toSec: 30 }, { fromSec: 20, toSec: 40 }] }])("rejects invalid admitted coverage %j", ({ admittedCoverage }) => {
    expect(DepegEventSchema.safeParse({ ...baseEvent, admittedCoverage }).success).toBe(false);
  });

  it("parses every current build-time archive row under the chronology contract", () => {
    const archiveDir = join("data", "depeg-events");
    expect(existsSync(archiveDir)).toBe(true);
    const files = readdirSync(archiveDir).filter((n) => n.endsWith(".json") && n !== "index.json");
    expect(files.length).toBeGreaterThan(0);
    for (const n of files) expect(DepegEventStoredSnapshotSchema.safeParse(JSON.parse(readFileSync(join(archiveDir, n), "utf8"))).success, n).toBe(true);
  });
});

describe("peg summary median reader contract", () => {
  const summary = { activeDepegCount: 0, medianDeviationBps: null, worstCurrent: null, coinsAtPeg: 0, totalTracked: 0, depegEventsToday: 2, depegEventsYesterday: 1 };
  it.each([null, 0, 75])("preserves median %s without changing independent counts", (medianDeviationBps) => {
    expect(PegSummaryStatsSchema.parse({ ...summary, medianDeviationBps })).toEqual({ ...summary, medianDeviationBps });
  });
  it.each(["activeDepegCount", "coinsAtPeg", "totalTracked", "depegEventsToday", "depegEventsYesterday"])("does not widen the %s cohort count to nullable", (field) => {
    expect(PegSummaryStatsSchema.safeParse({ ...summary, [field]: null }).success).toBe(false);
  });
  it("admits optional split counts and open-incident sidecar snapshots while preserving legacy payloads", () => {
    const withSplit = PegSummaryStatsSchema.parse({ ...summary, activeDepegCount: 17, recentActiveDepegCount: 4, longRunningActiveDepegCount: 13 });
    expect(withSplit).toMatchObject({ activeDepegCount: 17, recentActiveDepegCount: 4, longRunningActiveDepegCount: 13 });
    expect(PegSummaryStatsSchema.safeParse({ ...summary, activeDepegCount: -1 }).success).toBe(false);
    expect(PegSummaryStatsSchema.safeParse({ ...summary, recentActiveDepegCount: 1.5 }).success).toBe(false);
    const coverage = OpenIncidentCoverageSchema.parse({ lastObservationKind: "trusted-off-peg", lastTrustedObservationAt: 1_800_000_000, gapStartedAt: null });
    const snapshot = OpenIncidentSnapshotSchema.parse({ eventId: 42, startedAt: 1_799_000_000, escalatedAt: null, coverage });
    expect(snapshot).toEqual({ eventId: 42, startedAt: 1_799_000_000, escalatedAt: null, coverage });
    expect(OpenIncidentSnapshotSchema.safeParse({ ...snapshot, eventId: 0 }).success).toBe(false);
    expect(OpenIncidentCoverageSchema.safeParse({ ...coverage, lastObservationKind: "stale" }).success).toBe(false);
    const methodology = { version: "6.56", versionLabel: "v6.56", currentVersion: "6.56", currentVersionLabel: "v6.56", changelogPath: "/methodology/depeg-changelog/", asOf: 1_800_000_000, isCurrent: true };
    const response = PegSummaryResponseSchema.parse({ coins: [], summary: withSplit, openIncidents: { "usdt-tether": snapshot }, openIncidentsAsOfSec: 1_800_000_000, methodology });
    expect(response.openIncidents?.["usdt-tether"]).toEqual(snapshot);
    expect(response.openIncidentsAsOfSec).toBe(1_800_000_000);
    const legacy = PegSummaryResponseSchema.parse({ coins: [], summary, methodology });
    expect(legacy).not.toHaveProperty("openIncidents");
    expect(legacy).not.toHaveProperty("openIncidentsAsOfSec");
  });
});

describe("blacklist summary cache contract", () => {
  it("parses a cache payload whose quarterly record still carries only pre-addition symbols", () => {
    const body = {
      stats: {
        usdcBlacklisted: 1, usdtBlacklisted: 2, goldBlacklisted: 3, frozenAddresses: 4, destroyedTotal: 5,
        activeAddressCount: 6, activeFrozenTotal: 7, activeAmountGapCount: 8, trackedAddressCount: 9,
        trackedFrozenTotal: 10, trackedAmountGapCount: 11, recentCount: 12, recentCount24h: 13,
        recentFreezeCount24h: 0, recentFreezeCount7d: 0, recentFreezeAmount24hUsd: 0, recentFreezeAmount7dUsd: 0,
        recoverableGapCount: 14, perCoinBlacklistCounts: {}, perCoinTotalEvents: {},
        perCoinFrozenAddressCount: {}, perCoinFrozenTotal: {}, perCoinDestroyedTotal: {},
        perCoinQuarterlyEventTypes: { USDC: [{ quarter: "2026-Q1", blacklist: 1, unblacklist: 0, destroy: 0 }], "NOT-YET-TRACKED": [{ quarter: "2026-Q2", blacklist: 1, unblacklist: 0, destroy: 0 }] },
      },
      chart: [], chains: [], totalEvents: 12,
    };
    const parsed = BlacklistSummaryResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(Object.keys(parsed.data!.stats.perCoinQuarterlyEventTypes)).toContain("NOT-YET-TRACKED");
    expect(BLACKLIST_STABLECOINS.includes("NOT-YET-TRACKED" as never)).toBe(false);
  });
});

describe("nominal price reference reader contract", () => {
  it("preserves a legacy observation and an independently labelled nominal reference", () => {
    const legacy = StablecoinDataSchema.parse(makeStablecoin({ price: 0.98, priceSource: "coingecko" }));
    expect(legacy.price).toBe(0.98); expect(isObservedPrice(legacy)).toBe(true); expect(legacy).not.toHaveProperty("nominalPriceReference");
    const nominalPriceReference = { price: 1, source: "protocol-par", mode: "nominal_reference" };
    const market = StablecoinDataSchema.parse({ ...legacy, nominalPriceReference });
    expect(market.price).toBe(0.98); expect(market.nominalPriceReference).toEqual(nominalPriceReference); expect(isObservedPrice(market)).toBe(true);
  });
  it.each(["nominal_reference", "future-mode"])("does not promote %s to an observation", (mode) => {
    const row = StablecoinDataSchema.parse({ ...makeStablecoin(), price: 1, priceSource: "protocol-redeem", priceConfidence: "high", priceObservedAt: 1_800_000_000, priceObservedAtMode: mode });
    expect(isObservedPrice(row)).toBe(false); expect(isObservedPrice({ priceSource: "protocol-par" })).toBe(false);
  });
});

describe("DEX volume availability wire contract", () => {
  it.each([[1, null, false], [1, 0, true], [0, null, true], [null, null, true]] as const)("admits measured count %s and sum %s only with consistent evidence", (measuredPoolCount, partialGrossUsd, accepted) => {
    const result = DexLiquidityHistoryPointSchema.pick({ volume24hAvailability: true }).safeParse({ volume24hAvailability: {
      completeness: "complete", reason: null, measuredPoolCount, partialGrossUsd, missingPoolCount: 0, stalePoolCount: 0, windowSec: 86_400,
      asOfSec: 1_790_000_000, maxObservationAgeSec: 259_200, oldestObservedAtSec: null, newestObservedAtSec: null,
    } });
    expect(result.success).toBe(accepted);
    if (result.success) expect(result.data.volume24hAvailability).not.toHaveProperty("admittedTvlUsd");
  });
});

describe("supply history provenance contract (K-031)", () => {
  it("admits old points and nullable provenance additively, rejecting malformed metadata", () => {
    const guard = { reason: "supply-chain-dropout", status: "chains-unavailable", partialCoverage: true, chains: [{ chainLabel: "HyperEVM", listCurrentUsd: 0, baselineUsd: 3, baselineObservedAt: 1, baselineSource: "state", resolution: "unavailable" }] };
    const parsed = SupplyHistoryResponseSchema.parse([
      { date: 1, circulatingUsd: 100, price: 1 },
      { date: 2, circulatingUsd: 97, price: 1, supplyProvenance: { supplySource: "defillama", supplyObservedAt: 2, supplyChainGuard: guard } },
      { date: 3, circulatingUsd: 0, price: null, supplyProvenance: null },
    ]);
    expect(parsed[0]).not.toHaveProperty("supplyProvenance");
    expect(parsed[1]!.supplyProvenance?.supplyChainGuard?.partialCoverage).toBe(true);
    expect(parsed[2]!.supplyProvenance).toBeNull();
    expect(SupplyHistoryResponseSchema.safeParse([{ date: 1, circulatingUsd: 1, price: 1, supplyProvenance: { supplySource: 7, supplyObservedAt: null, supplyChainGuard: null } }]).success).toBe(false);
  });
});

it.each([{}, { circulatingNative: null, valuationPriceUsd: null, valuationObservedAtSec: null }, { circulatingNative: 0, valuationPriceUsd: 2.5, valuationObservedAtSec: 1_700_000_000 }, { circulatingNative: 125.5, valuationPriceUsd: 2.5, valuationObservedAtSec: 1_700_000_000 }])("round-trips native quantity fields %j in current and historical supply", (fields) => {
  const coin = makeStablecoin(), current = StablecoinDataSchema.parse({ ...coin, ...fields });
  expect(current).toStrictEqual({ ...StablecoinDataSchema.parse(coin), ...fields });
  expect(StablecoinDataOutputSchema.parse(current)).toEqual(current);
  const history = { date: 1_700_000_000, circulatingUsd: 500, price: 2, ...fields };
  expect(SupplyHistoryResponseSchema.parse([history])).toEqual([history]);
});

it.each([{ circulatingNative: -1 }, { circulatingNative: Infinity }, { valuationPriceUsd: 0 }, { valuationObservedAtSec: 1.5 }])("rejects invalid native quantity metadata %j", (fields) => {
  expect(StablecoinDataSchema.safeParse({ ...makeStablecoin(), ...fields }).success).toBe(false);
  expect(SupplyHistoryResponseSchema.safeParse([{ date: 1, circulatingUsd: 1, price: 1, ...fields }]).success).toBe(false);
});

describe("StablecoinListResponseSchema compatibility", () => {
  it("normalizes snake_case gecko IDs, nullable historical buckets, and missing gecko IDs", () => {
    const parsed = StablecoinListResponseSchema.parse({
      peggedAssets: [
        { id: "usdt-tether", name: "Tether", symbol: "USDT", gecko_id: "tether", pegType: "peggedUSD", pegMechanism: "fiat-backed", price: 1, priceSource: "defillama", circulating: { peggedUSD: 1000 }, circulatingPrevDay: null, circulatingPrevWeek: undefined, circulatingPrevMonth: { peggedUSD: 950 }, chainCirculating: { Ethereum: { current: 1000, circulatingPrevDay: 990, circulatingPrevWeek: 980, circulatingPrevMonth: 970 } }, chains: ["Ethereum"] },
        { id: "usdc-circle", name: "Unknown", symbol: "UNK", pegType: "peggedUSD", pegMechanism: "fiat-backed", price: null, priceSource: "defillama", priceConfidence: null, circulating: { peggedUSD: 100 }, circulatingPrevDay: { peggedUSD: 100 }, circulatingPrevWeek: { peggedUSD: 100 }, circulatingPrevMonth: { peggedUSD: 100 }, chainCirculating: {}, chains: [] },
      ],
      chains: ["Ethereum"], _meta: { updatedAt: 1, ageSeconds: 0, status: "fresh" },
    });
    expect(parsed.peggedAssets[0]).toMatchObject({ geckoId: "tether", priceConfidence: null, circulatingPrevDay: {}, circulatingPrevWeek: {}, circulatingPrevMonth: { peggedUSD: 950 } });
    expect(parsed.peggedAssets[1].geckoId).toBeNull();
  });
});
