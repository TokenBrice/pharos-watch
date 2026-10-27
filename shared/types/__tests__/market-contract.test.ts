import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BLACKLIST_STABLECOINS,
  BlacklistSummaryResponseSchema,
  DepegEventSchema,
  DepegEventStoredSnapshotSchema,
  DepegPendingIncidentSchema,
  DexLiquidityHistoryPointSchema,
  PegSummaryStatsSchema,
  StablecoinDataSchema,
  StablecoinListResponseSchema,
  SupplyHistoryResponseSchema,
} from "../market";

import { makeStablecoin } from "../../test-utils/stablecoin";
import { isObservedPrice } from "../../lib/pricing-source-policy";

describe("chain partition provenance contract", () => {
  const provenance = {
    basis: "onchain-share", observedAt: 1_700_000_000, onchainUsd: 1_020_000, ratio: 1.02, admission: "entered",
  };

  it.each(["entered", "retained", "carried"])("preserves %s provenance across list JSON round-trips", (admission) => {
    const chainPartition = { ...provenance, admission };
    const payload = StablecoinListResponseSchema.parse({ peggedAssets: [{ ...makeStablecoin(), chainPartition }] });
    expect(payload.peggedAssets[0]!.chainPartition).toEqual(chainPartition);
    expect(StablecoinListResponseSchema.parse(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
  });

  it.each([
    { basis: "provider-share" }, { observedAt: 0 }, { observedAt: 1.5 },
    { onchainUsd: 0 }, { onchainUsd: Infinity }, { ratio: 0 }, { ratio: NaN }, { admission: "fresh" },
  ])("rejects invalid partition evidence %j", (invalid) => {
    expect(StablecoinDataSchema.safeParse({
      ...makeStablecoin(), chainPartition: { ...provenance, ...invalid },
    }).success).toBe(false);
  });
});

describe("price derivation provenance contract (K-207)", () => {
  const priceDerivation = {
    inheritedFrom: "pathusd-bridge", parentSource: "coingecko", parentConfidence: "single-source",
    parentObservedAt: 1_700_000_000, parentObservedAtMode: "upstream", parentReplaySafe: true, navMethod: "convertToAssets",
  };

  it("round-trips derivation and keeps legacy rows without it", () => {
    const payload = StablecoinListResponseSchema.parse({
      peggedAssets: [{ ...makeStablecoin(), priceDerivation }, makeStablecoin()],
    });
    expect(payload.peggedAssets[0]!.priceDerivation).toEqual(priceDerivation);
    expect(payload.peggedAssets[1]).not.toHaveProperty("priceDerivation");
    expect(StablecoinListResponseSchema.parse(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
  });

  it.each([
    { inheritedFrom: "" }, { parentReplaySafe: "yes" }, { navMethod: "totalAssets" },
    { parentConfidence: "certain" }, { cachedVaultRate: { rate: 0, rateObservedAt: 1 } },
  ])("rejects invalid derivation evidence %j", (invalid) => {
    expect(StablecoinDataSchema.safeParse({
      ...makeStablecoin(), priceDerivation: { ...priceDerivation, ...invalid },
    }).success).toBe(false);
  });
});

const baseEvent = {
  id: 1,
  stablecoinId: "usdt-tether",
  symbol: "USDT",
  pegType: "peggedUSD",
  direction: "below" as const,
  peakDeviationBps: 120,
  startedAt: 1_700_000_000,
  endedAt: 1_700_086_400,
  startPrice: 1,
  peakPrice: 0.98,
  recoveryPrice: 1,
  pegReference: 1,
  source: "live" as const,
};

const baseIncident = {
  stablecoinId: "usdt-tether",
  symbol: "USDT",
  direction: "below" as const,
  firstSeenAt: 1_700_000_000,
  lastSeenAt: 1_700_003_600,
  firstSeenBps: 40,
  lastSeenBps: 55,
  peakSeenBps: 60,
  reason: "threshold-crossing",
  ageSec: 3_600,
  expiresAt: 1_700_007_200,
  availableConfirmationCategories: [],
  missingConfirmationCategories: [],
};

describe("depeg chronology contract", () => {
  it("accepts a well-ordered closed event and a still-open incident", () => {
    expect(DepegEventSchema.safeParse(baseEvent).success).toBe(true);
    expect(DepegPendingIncidentSchema.safeParse(baseIncident).success).toBe(true);
  });

  it("rejects a reversed event timeline instead of publishing a negative duration", () => {
    const reversed = DepegEventSchema.safeParse({ ...baseEvent, endedAt: baseEvent.startedAt - 1 });
    expect(reversed.success).toBe(false);
    expect(reversed.error!.issues.some((issue) => issue.path.includes("endedAt"))).toBe(true);

    expect(DepegEventSchema.safeParse({ ...baseEvent, endedAt: baseEvent.startedAt }).success).toBe(false);
    expect(DepegEventSchema.safeParse({ ...baseEvent, endedAt: null }).success).toBe(true);
  });

  it("rejects reversed pending-incident windows", () => {
    expect(
      DepegPendingIncidentSchema.safeParse({ ...baseIncident, lastSeenAt: baseIncident.firstSeenAt - 1 }).success,
    ).toBe(false);
    expect(
      DepegPendingIncidentSchema.safeParse({ ...baseIncident, expiresAt: baseIncident.firstSeenAt }).success,
    ).toBe(false);
  });

  it("accepts a pending incident still seen after its base expiry", () => {
    // The confirmation cron holds rows past the base expiry under the extended
    // and severe limits; rejecting them emptied the whole /depeg events feed.
    expect(
      DepegPendingIncidentSchema.safeParse({
        ...baseIncident,
        lastSeenAt: baseIncident.firstSeenAt + 6_264,
        ageSec: 6_880,
        expiresAt: baseIncident.firstSeenAt + 2_700,
      }).success,
    ).toBe(true);
  });

  it("rejects non-integer or negative event timestamps", () => {
    expect(DepegEventSchema.safeParse({ ...baseEvent, startedAt: 1_700_000_000.5 }).success).toBe(false);
    expect(DepegEventSchema.safeParse({ ...baseEvent, startedAt: -1 }).success).toBe(false);
  });

  it("parses every current build-time archive row under the chronology contract", () => {
    const archiveDir = join("data", "depeg-events");
    expect(existsSync(archiveDir)).toBe(true);
    const files = readdirSync(archiveDir).filter((name) => name.endsWith(".json") && name !== "index.json");
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const parsed = DepegEventStoredSnapshotSchema.safeParse(
        JSON.parse(readFileSync(join(archiveDir, name), "utf8")),
      );
      expect(parsed.success, name).toBe(true);
    }
  });
});

describe("peg summary median reader contract", () => {
  const summary = {
    activeDepegCount: 0,
    medianDeviationBps: null,
    worstCurrent: null,
    coinsAtPeg: 0,
    totalTracked: 0,
    depegEventsToday: 2,
    depegEventsYesterday: 1,
  };

  it.each([null, 0, 75])("preserves median %s without changing independent counts", (medianDeviationBps) => {
    expect(PegSummaryStatsSchema.parse({ ...summary, medianDeviationBps })).toEqual({ ...summary, medianDeviationBps });
  });

  it.each(["activeDepegCount", "coinsAtPeg", "totalTracked", "depegEventsToday", "depegEventsYesterday"])(
    "does not widen the %s cohort count to nullable",
    (field) => {
      expect(PegSummaryStatsSchema.safeParse({ ...summary, [field]: null }).success).toBe(false);
    },
  );
});

describe("blacklist summary cache contract", () => {
  it("parses a cache payload whose quarterly record still carries only pre-addition symbols", () => {
    const body = {
      stats: {
        usdcBlacklisted: 1,
        usdtBlacklisted: 2,
        goldBlacklisted: 3,
        frozenAddresses: 4,
        destroyedTotal: 5,
        activeAddressCount: 6,
        activeFrozenTotal: 7,
        activeAmountGapCount: 8,
        trackedAddressCount: 9,
        trackedFrozenTotal: 10,
        trackedAmountGapCount: 11,
        recentCount: 12,
        recentCount24h: 13,
        recentFreezeCount24h: 0,
        recentFreezeCount7d: 0,
        recentFreezeAmount24hUsd: 0,
        recentFreezeAmount7dUsd: 0,
        recoverableGapCount: 14,
        perCoinBlacklistCounts: {},
        perCoinTotalEvents: {},
        perCoinFrozenAddressCount: {},
        perCoinFrozenTotal: {},
        perCoinDestroyedTotal: {},
        perCoinQuarterlyEventTypes: {
          USDC: [{ quarter: "2026-Q1", blacklist: 1, unblacklist: 0, destroy: 0 }],
          "NOT-YET-TRACKED": [{ quarter: "2026-Q2", blacklist: 1, unblacklist: 0, destroy: 0 }],
        },
      },
      chart: [],
      chains: [],
      totalEvents: 12,
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
    expect(legacy.price).toBe(0.98);
    expect(isObservedPrice(legacy)).toBe(true);
    expect(legacy).not.toHaveProperty("nominalPriceReference");
    const nominalPriceReference = { price: 1, source: "protocol-par", mode: "nominal_reference" };
    const market = StablecoinDataSchema.parse({ ...legacy, nominalPriceReference });
    expect(market.price).toBe(0.98);
    expect(market.nominalPriceReference).toEqual(nominalPriceReference);
    expect(isObservedPrice(market)).toBe(true);
  });

  it.each(["nominal_reference", "future-mode"])("does not promote %s to an observation", (mode) => {
    const row = StablecoinDataSchema.parse({
      ...makeStablecoin(),
      price: 1, priceSource: "protocol-redeem", priceConfidence: "high",
      priceObservedAt: 1_800_000_000,
      priceObservedAtMode: mode,
    });
    expect(isObservedPrice(row)).toBe(false);
    expect(isObservedPrice({ priceSource: "protocol-par" })).toBe(false);
  });
});

describe("DEX volume availability wire contract", () => {
  it.each([
    [1, null, false],
    [1, 0, true],
    [0, null, true],
    [null, null, true],
  ] as const)("admits measured count %s and sum %s only with consistent evidence", (measuredPoolCount, partialGrossUsd, accepted) => {
    const schema = DexLiquidityHistoryPointSchema.pick({ volume24hAvailability: true });
    const result = schema.safeParse({ volume24hAvailability: {
      completeness: "complete", reason: null, measuredPoolCount, partialGrossUsd,
      missingPoolCount: 0, stalePoolCount: 0, windowSec: 86_400,
      asOfSec: 1_790_000_000, maxObservationAgeSec: 259_200,
      oldestObservedAtSec: null, newestObservedAtSec: null,
    } });
    expect(result.success).toBe(accepted);
    if (result.success) expect(result.data.volume24hAvailability).not.toHaveProperty("admittedTvlUsd");
  });
});

describe("supply history provenance contract (K-031)", () => {
  it("admits old points and nullable provenance additively, rejecting malformed metadata", () => {
    const guard = {
      reason: "supply-chain-dropout", status: "chains-unavailable", partialCoverage: true,
      chains: [{ chainLabel: "HyperEVM", listCurrentUsd: 0, baselineUsd: 3, baselineObservedAt: 1, baselineSource: "state", resolution: "unavailable" }],
    };
    const parsed = SupplyHistoryResponseSchema.parse([
      { date: 1, circulatingUsd: 100, price: 1 },
      { date: 2, circulatingUsd: 97, price: 1, supplyProvenance: { supplySource: "defillama", supplyObservedAt: 2, supplyChainGuard: guard } },
      { date: 3, circulatingUsd: 0, price: null, supplyProvenance: null },
    ]);
    // Absent stays absent (unknown); nothing defaults to a complete record.
    expect(parsed[0]).not.toHaveProperty("supplyProvenance");
    expect(parsed[1]!.supplyProvenance?.supplyChainGuard?.partialCoverage).toBe(true);
    expect(parsed[2]!.supplyProvenance).toBeNull();
    expect(SupplyHistoryResponseSchema.safeParse([
      { date: 1, circulatingUsd: 1, price: 1, supplyProvenance: { supplySource: 7, supplyObservedAt: null, supplyChainGuard: null } },
    ]).success).toBe(false);
  });
});
