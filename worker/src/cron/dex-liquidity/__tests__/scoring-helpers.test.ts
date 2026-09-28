import { describe, it, expect } from "vitest";
import {
  accumulateGlobalAggregate,
  aggregateProtocolSources,
  applyPoolVolumeEligibility,
  classifyCoverage,
  collapseDuplicateObservations,
  buildDexPriceObservationsFromRetainedPools,
  filterRetainedPools,
  summarizeRetainedPoolVolume,
  type GlobalPoolAggregateEntry,
} from "../scoring-helpers";
import { DEX_DEAD_POOL_TVL_MIN_USD, DEX_VOLUME_OBSERVATION_MAX_AGE_SEC } from "@shared/lib/dex-volume-availability";
import { initLiquidityFallbackCounters } from "../pool-helpers";
import { isPlausibleDexObservationPrice } from "../price-sanity";
import type { LiquiditySourceMixByFamily } from "../types";
import { makeObs, makePool } from "./scoring-test-builders";

describe("protocol price evidence admission", () => {
  it("omits a zero-weight cross-source price while retaining healthy protocols", () => {
    const retained = buildDexPriceObservationsFromRetainedPools(new Map([["usdc-circle", [
      makePool({ project: "orca", price: 1, priceEvidenceTvlUsd: 0 }),
      makePool({ project: "balancer", price: 0.999, priceEvidenceTvlUsd: 200_000 }),
    ]]]));
    expect(retained.get("usdc-circle")).toEqual([
      expect.objectContaining({ protocol: "balancer", price: 0.999, tvl: 200_000 }),
    ]);
    const sources = aggregateProtocolSources([
      ...retained.get("usdc-circle")!,
      makeObs({ protocol: "orca", tvl: 0 }),
    ]);
    expect(sources).toEqual([
      expect.objectContaining({ protocol: "balancer", price: 0.999, tvl: 200_000 }),
    ]);
    expect(aggregateProtocolSources([makeObs({ tvl: 0 })])).toEqual([]);
  });
});

describe("isPlausibleDexObservationPrice guards peg", () => {
  it("rejects extreme off-peg prices for usdc-circle", () => {
    // Below the reference lower bound (1% of peg = $0.01)
    expect(isPlausibleDexObservationPrice("usdc-circle", 0.005)).toBe(false);
    expect(isPlausibleDexObservationPrice("usdc-circle", 0)).toBe(false);
    expect(isPlausibleDexObservationPrice("usdc-circle", -1)).toBe(false);
  });

  it("accepts near-peg prices for usdc-circle", () => {
    expect(isPlausibleDexObservationPrice("usdc-circle", 1.0001)).toBe(true);
    expect(isPlausibleDexObservationPrice("usdc-circle", 0.995)).toBe(true);
  });
});

// Minimal input builder for classifyCoverage – only sourceMix and totalTvlUsd vary per case.
function makeCoverageInput(
  sourceMix: LiquiditySourceMixByFamily,
  totalTvlUsd: number,
  overrides: Partial<Parameters<typeof classifyCoverage>[0]> = {},
) {
  return {
    sourceMix,
    totalTvlUsd,
    protocolCount: 1,
    sourceFamilyCount: 1,
    balanceMeasuredTvlUsd: 0,
    organicMeasuredTvlUsd: 0,
    syntheticTvlUsd: 0,
    decayedTvlUsd: 0,
    measuredPriceTvlUsd: 0,
    ...overrides,
  };
}

describe("classifyCoverage", () => {
  it.each<[LiquiditySourceMixByFamily, number, string]>([
    [{ dl: { poolCount: 3, tvlUsd: 10_000_000 } }, 10_000_000, "primary"],
    [{ dl: { poolCount: 2, tvlUsd: 4_000_000 }, direct_api: { poolCount: 1, tvlUsd: 1_000_000 } }, 5_000_000, "primary"],
    [{ dl: { poolCount: 2, tvlUsd: 4_000_000 }, cg_onchain: { poolCount: 1, tvlUsd: 1_000_000 } }, 5_000_000, "mixed"],
    [{ cg_onchain: { poolCount: 2, tvlUsd: 3_000_000 } }, 3_000_000, "fallback"],
    [{ cg_tickers: { poolCount: 1, tvlUsd: 2_000_000 } }, 2_000_000, "fallback"],
    [{}, 5_000_000, "unobserved"],
  ])("classifies source mix %j with TVL %d as %s", (mix, tvl, expected) => {
    expect(classifyCoverage(makeCoverageInput(mix, tvl)).coverageClass).toBe(expected);
  });

  it("returns primary when all TVL is from direct_api source", () => {
    const { coverageClass, coverageConfidence } = classifyCoverage(
      makeCoverageInput({ direct_api: { poolCount: 2, tvlUsd: 5_000_000 } }, 5_000_000),
    );
    expect(coverageClass).toBe("primary");
    expect(coverageConfidence).toBe(0.6);
  });

  it("returns unobserved when totalTvlUsd is zero", () => {
    const { coverageClass, coverageConfidence } = classifyCoverage(makeCoverageInput({}, 0));
    expect(coverageClass).toBe("unobserved");
    expect(coverageConfidence).toBe(0);
  });


  it("caps coverageConfidence at 1 for fully measured broad primary coverage", () => {
    const { coverageClass, coverageConfidence } = classifyCoverage(
      makeCoverageInput(
        { dl: { poolCount: 10, tvlUsd: 100 } },
        100,
        {
          protocolCount: 10,
          sourceFamilyCount: 10,
          balanceMeasuredTvlUsd: 100,
          organicMeasuredTvlUsd: 100,
          measuredPriceTvlUsd: 100,
        },
      ),
    );

    expect(coverageClass).toBe("primary");
    expect(coverageConfidence).toBe(1);
  });

  it("floors coverageConfidence at 0 when fallback coverage is fully synthetic and decayed", () => {
    const { coverageClass, coverageConfidence } = classifyCoverage(
      makeCoverageInput(
        { cg_onchain: { poolCount: 1, tvlUsd: 100 } },
        100,
        {
          syntheticTvlUsd: 100,
          decayedTvlUsd: 100,
        },
      ),
    );

    expect(coverageClass).toBe("fallback");
    expect(coverageConfidence).toBe(0);
  });

  it("blends coverageConfidence for mixed measured and fallback evidence", () => {
    const { coverageClass, coverageConfidence } = classifyCoverage(
      makeCoverageInput(
        {
          dl: { poolCount: 2, tvlUsd: 60 },
          cg_onchain: { poolCount: 1, tvlUsd: 40 },
        },
        100,
        {
          protocolCount: 2,
          sourceFamilyCount: 2,
          balanceMeasuredTvlUsd: 50,
          organicMeasuredTvlUsd: 25,
          measuredPriceTvlUsd: 20,
          syntheticTvlUsd: 10,
          decayedTvlUsd: 20,
        },
      ),
    );

    expect(coverageClass).toBe("mixed");
    expect(coverageConfidence).toBeCloseTo(0.61, 6);
  });
});

describe("aggregateProtocolSources", () => {
  it("preserves source family on protocol-source rows for depeg corroboration", () => {
    const aggregated = aggregateProtocolSources([
      makeObs({ protocol: "curve", price: 0.99, tvl: 1_000_000, sourceFamily: "dl" }),
      makeObs({ protocol: "curve", price: 0.98, tvl: 2_000_000, sourceFamily: "gecko_terminal" }),
      makeObs({ protocol: "uniswap", price: 0.97, tvl: 3_000_000, sourceFamily: "gecko_terminal" }),
    ]);

    expect(aggregated).toEqual([
      expect.objectContaining({ protocol: "uniswap", sourceFamily: "gecko_terminal", tvl: 3_000_000 }),
      expect.objectContaining({ protocol: "curve", sourceFamily: "gecko_terminal", tvl: 2_000_000 }),
      expect.objectContaining({ protocol: "curve", sourceFamily: "dl", tvl: 1_000_000 }),
    ]);
  });
});

describe("collapseDuplicateObservations", () => {
  it("collapses two observations sharing the same pool key to one", () => {
    const obs = [
      makeObs({ poolKey: "ethereum:0xabc", price: 0.999, tvl: 2_000_000 }),
      makeObs({ poolKey: "ethereum:0xabc", price: 1.001, tvl: 1_000_000 }),
    ];
    const { collapsed, duplicateGroups, duplicateObservations } = collapseDuplicateObservations(obs);
    expect(collapsed).toHaveLength(1);
    expect(duplicateGroups).toBe(1);
    expect(duplicateObservations).toBe(1);
    // Representative is the higher-TVL entry; price is median of [0.999, 1.001]
    expect(collapsed[0]!.price).toBeCloseTo(1.0, 5);
    expect(collapsed[0]!.tvl).toBe(2_000_000);
  });

  it("collapses two observations sharing derivedMatchKey (derived_unique) to one", () => {
    const obs = [
      makeObs({ derivedMatchKey: "usdc:usdt:curve", identityConfidence: "derived_unique", price: 1.0, tvl: 3_000_000 }),
      makeObs({ derivedMatchKey: "usdc:usdt:curve", identityConfidence: "derived_unique", price: 1.002, tvl: 2_000_000 }),
    ];
    const { collapsed, duplicateGroups, duplicateObservations } = collapseDuplicateObservations(obs);
    expect(collapsed).toHaveLength(1);
    expect(duplicateGroups).toBe(1);
    expect(duplicateObservations).toBe(1);
    expect(collapsed[0]!.tvl).toBe(3_000_000);
  });

  it("preserves distinct observations without a shared key", () => {
    const obs = [
      makeObs({ poolKey: "ethereum:0x111", identityConfidence: "exact" }),
      makeObs({ poolKey: "ethereum:0x222", identityConfidence: "exact", protocol: "curve" }),
      makeObs({ poolKey: "ethereum:0x333", identityConfidence: "exact", protocol: "balancer" }),
    ];
    const { collapsed, duplicateGroups, duplicateObservations } = collapseDuplicateObservations(obs);
    expect(collapsed).toHaveLength(3);
    expect(duplicateGroups).toBe(0);
    expect(duplicateObservations).toBe(0);
  });

  it("returns empty output with zero counters for empty input", () => {
    const { collapsed, duplicateGroups, duplicateObservations } = collapseDuplicateObservations([]);
    expect(collapsed).toHaveLength(0);
    expect(duplicateGroups).toBe(0);
    expect(duplicateObservations).toBe(0);
  });

  it("passes through observations with no identifiable key (no poolKey, not derived_unique)", () => {
    const obs = [
      makeObs({ identityConfidence: "none" }),
      makeObs({ identityConfidence: "derived_ambiguous", derivedMatchKey: "usdc:usdt" }),
    ];
    const { collapsed, duplicateGroups } = collapseDuplicateObservations(obs);
    // Both lack a qualifying key, so both pass through unchanged
    expect(collapsed).toHaveLength(2);
    expect(duplicateGroups).toBe(0);
  });
});

describe("buildDexPriceObservationsFromRetainedPools", () => {
  it("joins exact direct evidence to an unpriced retained primary pool", () => {
    const pool = makePool({
      poolId: "ethereum:0xtest",
      project: "balancer",
      tvlUsd: 52_000,
      price: undefined,
      source: "dl",
    });
    const result = buildDexPriceObservationsFromRetainedPools(
      new Map([["test-dollar", [pool]]]),
      new Map([
        [
          "test-dollar",
          [
            makeObs({
              price: 0.919816,
              tvl: 53_000,
              chain: "ethereum",
              protocol: "balancer",
              poolKey: "ethereum:0xtest",
              identityConfidence: "exact",
              sourceFamily: "direct_api",
            }),
          ],
        ],
      ]),
    );

    expect(result.get("test-dollar")).toEqual([
      expect.objectContaining({
        price: 0.919816,
        tvl: 52_000,
        poolKey: "ethereum:0xtest",
        sourceFamily: "direct_api",
      }),
    ]);
  });

  it("does not join derived, mismatched, or sub-threshold evidence", () => {
    const pool = makePool({ poolId: "ethereum:0xretained", tvlUsd: 52_000, price: undefined });
    const result = buildDexPriceObservationsFromRetainedPools(
      new Map([["test-dollar", [pool]]]),
      new Map([
        [
          "test-dollar",
          [
            makeObs({
              poolKey: "ethereum:0xretained",
              identityConfidence: "derived_unique",
            }),
            makeObs({
              poolKey: "ethereum:0xother",
              identityConfidence: "exact",
            }),
            makeObs({
              poolKey: "ethereum:0xretained",
              identityConfidence: "exact",
              tvl: 49_999,
            }),
          ],
        ],
      ]),
    );

    expect(result.has("test-dollar")).toBe(false);
  });

  it("does not join exact evidence from non-direct sources", () => {
    const pool = makePool({ poolId: "ethereum:0xretained", tvlUsd: 52_000, price: undefined });
    const result = buildDexPriceObservationsFromRetainedPools(
      new Map([["usp-pareto-credit", [pool]]]),
      new Map([
        [
          "usp-pareto-credit",
          [
            makeObs({
              poolKey: "ethereum:0xretained",
              identityConfidence: "exact",
              sourceFamily: "dexscreener",
            }),
          ],
        ],
      ]),
    );

    expect(result.has("usp-pareto-credit")).toBe(false);
  });

  it("attributes a cross-source price to the family that observed it with capped TVL weight", () => {
    const hybrid = makePool({
      poolId: "ethereum:0xhybrid",
      project: "uniswap-v3",
      tvlUsd: 200_000,
      price: 0.998,
      source: "dl",
      priceSource: "cg_onchain",
      priceEvidenceTvlUsd: 100_000,
    });
    const sameSource = makePool({
      poolId: "ethereum:0xsame",
      project: "curve",
      tvlUsd: 80_000,
      price: 0.999,
      source: "cg_onchain",
    });
    const result = buildDexPriceObservationsFromRetainedPools(
      new Map([["test-dollar", [hybrid, sameSource]]]),
    );

    expect(result.get("test-dollar")).toEqual([
      expect.objectContaining({
        price: 0.998,
        // Weighted at the price row's own $100K claim, not the dl row's $200K.
        tvl: 100_000,
        sourceFamily: "cg_onchain",
      }),
      expect.objectContaining({ price: 0.999, tvl: 80_000, sourceFamily: "cg_onchain" }),
    ]);
  });
});

describe("filterRetainedPools", () => {
  it("drops large direct pools when zero volume is explicitly unmeasured", () => {
    const retained = filterRetainedPools([
      makePool({
        poolId: "base:0xslipstream",
        project: "aerodrome-slipstream",
        chain: "Base",
        tvlUsd: 150_000_000,
        volumeUsd1d: 0,
        source: "direct_api",
        extra: {
          measurement: {
            tvlMeasured: true,
            volumeMeasured: false,
          },
        },
      }),
    ]);

    expect(retained).toHaveLength(0);
  });

  it("still drops large pools with measured low volume", () => {
    const retained = filterRetainedPools([
      makePool({
        poolId: "ethereum:0xmeasured",
        tvlUsd: 150_000_000,
        volumeUsd1d: 0,
        extra: {
          measurement: {
            tvlMeasured: true,
            volumeMeasured: true,
          },
        },
      }),
    ]);

    expect(retained).toHaveLength(0);
  });

  describe("dead-pool floor (v6.92)", () => {
    const NOW = 1_800_000_000;
    const clock = { asOfSec: NOW, maxObservationAgeSec: DEX_VOLUME_OBSERVATION_MAX_AGE_SEC };
    const pool = (
      poolId: string,
      tvlUsd: number,
      reading: { volume24hUsd: number | null; ageSec?: number; signed?: boolean },
    ) => {
      const entry = makePool({ poolId, tvlUsd, volumeUsd1d: reading.volume24hUsd });
      entry.volumeReading = {
        volume24hUsd: reading.volume24hUsd,
        volume7dUsd: null,
        observedAtSec: NOW - (reading.ageSec ?? 3_600),
        ...(reading.signed ? { deadPoolSignature: true as const } : {}),
      };
      return entry;
    };

    it("drops a signed in-window zero from exactly the $1M threshold and keeps everything else", () => {
      const pools = [
        pool("ethereum:0xat", DEX_DEAD_POOL_TVL_MIN_USD, { volume24hUsd: 0, signed: true }),
        pool("ethereum:0xabove", 23_667_525, { volume24hUsd: 0, signed: true }),
        pool("ethereum:0xbelow", DEX_DEAD_POOL_TVL_MIN_USD - 0.01, { volume24hUsd: 0, signed: true }),
        // Measured zero without the signature: unverified provider zero or tracked counter-token.
        pool("ethereum:0xunsigned", 5_000_000, { volume24hUsd: 0 }),
        // Unknown volume is never a zero, signature or not.
        pool("ethereum:0xmissing", 5_000_000, { volume24hUsd: null, signed: true }),
        // A signed zero older than the admission window is stale, not measured.
        pool("ethereum:0xstale", 5_000_000, { volume24hUsd: 0, ageSec: DEX_VOLUME_OBSERVATION_MAX_AGE_SEC + 1, signed: true }),
        pool("ethereum:0xtraded", 5_000_000, { volume24hUsd: 12, signed: true }),
      ];
      applyPoolVolumeEligibility(pools, clock);
      const tally = { poolCount: 0, tvlUsd: 0 };
      const retained = filterRetainedPools(pools, undefined, tally);

      expect(retained.map((entry) => entry.poolId)).toEqual([
        "ethereum:0xbelow",
        "ethereum:0xunsigned",
        "ethereum:0xmissing",
        "ethereum:0xstale",
        "ethereum:0xtraded",
      ]);
      expect(tally).toEqual({ poolCount: 2, tvlUsd: DEX_DEAD_POOL_TVL_MIN_USD + 23_667_525 });
    });

    it("leaves a signed zero above $100M to the large-pool floor", () => {
      const counters = initLiquidityFallbackCounters();
      const tally = { poolCount: 0, tvlUsd: 0 };
      const pools = [pool("polygon:0xubs", 100_337_203, { volume24hUsd: 0, signed: true })];
      applyPoolVolumeEligibility(pools, clock);

      expect(filterRetainedPools(pools, counters, tally)).toHaveLength(0);
      expect(counters.retainedExclusionLargePoolLowVolume).toBe(1);
      expect(tally.poolCount).toBe(0);
    });
  });
});

describe("DEC-19 retained pool volume", () => {
  const NOW = 1_800_000_000;
  const clock = { asOfSec: NOW, maxObservationAgeSec: DEX_VOLUME_OBSERVATION_MAX_AGE_SEC };
  const pool = (volume24hUsd: number | null, ageSec: number | null, tvlUsd = 1_000) => ({
    reading: { volume24hUsd, volume7dUsd: null, observedAtSec: ageSec == null ? null : NOW - ageSec },
    tvlUsd,
  });

  it("admits a reading exactly 72h old and excludes one a second older", () => {
    const summary = summarizeRetainedPoolVolume(
      [pool(100, 0), pool(50, 72 * 3600, 3_000), pool(1_000, 72 * 3600 + 1, 4_000), pool(50_000, 180 * 3600, 2_000)],
      clock,
    );
    expect(summary.totalVolume24hUsd).toBeNull();
    expect(summary.volumeAvailability["24h"]).toMatchObject({
      completeness: "partial",
      reason: "pool-observations-stale",
      partialGrossUsd: 150,
      measuredPoolCount: 2,
      stalePoolCount: 2,
      maxObservationAgeSec: 72 * 3600,
      admittedTvlUsd: 4_000,
      retainedTvlUsd: 10_000,
      volumeCoverage: 0.4,
    });
  });

  it("keeps a complete measured zero at full coverage and nulls all-missing and mixed windows", () => {
    const zero = summarizeRetainedPoolVolume([pool(0, 60), pool(0, 0)], clock);
    expect(zero.totalVolume24hUsd).toBe(0);
    expect(zero.volumeAvailability["24h"]).toMatchObject({ completeness: "complete", volumeCoverage: 1 });
    const missing = summarizeRetainedPoolVolume([pool(null, 0), { reading: undefined, tvlUsd: 500 }], clock);
    expect(missing.totalVolume24hUsd).toBeNull();
    expect(missing.volumeAvailability["24h"]).toMatchObject({ completeness: "missing", volumeCoverage: 0 });
    const mixed = summarizeRetainedPoolVolume([pool(10, 0), pool(null, 0), pool(5, 200 * 3600)], clock);
    expect(mixed.volumeAvailability["24h"]).toMatchObject({
      completeness: "partial",
      reason: "pool-observations-missing-and-stale",
      partialGrossUsd: 10,
    });
  });

  it("publishes only admitted pool volume and never a decayed or aged value", () => {
    const aged = makePool({ poolId: "ethereum:0xaged", volumeUsd1d: 50_000 });
    aged.volumeReading = pool(50_000, 180 * 3600).reading;
    aged.extra = { measurement: { volumeMeasured: true, decayed: true } };
    const admitted = makePool({ poolId: "ethereum:0xadmitted", volumeUsd1d: 7 });
    admitted.volumeReading = pool(7, 72 * 3600).reading;
    applyPoolVolumeEligibility([aged, admitted], clock);
    expect(aged.volumeUsd1d).toBeNull();
    expect(aged.volumeObservation).toEqual({ status: "stale", observedAtSec: NOW - 180 * 3600 });
    expect(aged.extra?.measurement?.volumeMeasured).toBe(false);
    expect(admitted.volumeUsd1d).toBe(7);
    expect(admitted.volumeObservation).toEqual({ status: "measured", observedAtSec: NOW - 72 * 3600 });
  });
});

describe("accumulateGlobalAggregate", () => {
  it("dedupes the same poolId across stablecoins", () => {
    const seenTvl = new Map<string, GlobalPoolAggregateEntry>();
    const protoTvl: Record<string, number> = {};
    const chainTvl: Record<string, number> = {};
    const protoChainTvl: Record<string, number> = {};
    const chains = new Set<string>();

    const pool = makePool({});

    const a = accumulateGlobalAggregate([pool], protoTvl, chainTvl, protoChainTvl, chains, seenTvl);
    const b = accumulateGlobalAggregate([pool], protoTvl, chainTvl, protoChainTvl, chains, seenTvl);

    expect(a.totalTvl + b.totalTvl).toBe(5_000_000);
    expect(a.poolCount + b.poolCount).toBe(1);
  });

  it("lets the higher-TVL occurrence own the deduped pool, including its volume reading", () => {
    const seenTvl = new Map<string, GlobalPoolAggregateEntry>();
    const protoTvl: Record<string, number> = {};
    const chainTvl: Record<string, number> = {};
    const protoChainTvl: Record<string, number> = {};
    const chains = new Set<string>();
    const lower = makePool({ chain: "ethereum", tvlUsd: 4_500_000 });
    lower.volumeReading = { volume24hUsd: 900_000, volume7dUsd: null, observedAtSec: 1 };
    const higher = makePool({ chain: "ethereum", tvlUsd: 5_000_000 });
    higher.volumeReading = { volume24hUsd: 1_000_000, volume7dUsd: 7_000_000, observedAtSec: 2 };

    const a = accumulateGlobalAggregate([lower], protoTvl, chainTvl, protoChainTvl, chains, seenTvl);
    const b = accumulateGlobalAggregate([higher], protoTvl, chainTvl, protoChainTvl, chains, seenTvl);

    expect(a.totalTvl + b.totalTvl).toBe(5_000_000);
    expect(protoTvl["balancer"]).toBe(5_000_000);
    expect(chainTvl["ethereum"]).toBe(5_000_000);
    expect(seenTvl.get("ethereum:0xabc")).toMatchObject({ tvl: 5_000_000, reading: higher.volumeReading });
  });
});
