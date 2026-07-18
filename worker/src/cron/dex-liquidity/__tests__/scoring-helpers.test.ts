import { describe, it, expect } from "vitest";
import {
  accumulateGlobalAggregate,
  aggregateProtocolSources,
  classifyCoverage,
  collapseDuplicateObservations,
  buildDexPriceObservationsFromRetainedPools,
  filterRetainedPools,
} from "../scoring-helpers";
import { isPlausibleDexObservationPrice } from "../price-sanity";
import type { DexPriceObs, LiquiditySourceMixByFamily, PoolEntry } from "../types";

function makePool(overrides: Partial<PoolEntry>): PoolEntry {
  return {
    poolId: "ethereum:0xabc",
    project: "balancer-v3",
    chain: "Ethereum",
    tvlUsd: 5_000_000,
    symbol: "USDC/USDT",
    volumeUsd1d: 1_000_000,
    volumeUsd7d: 7_000_000,
    poolType: "balancer-stable",
    source: "dl",
    ...overrides,
  } as PoolEntry;
}

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

function makeObs(overrides: Partial<DexPriceObs>): DexPriceObs {
  return {
    price: 1.0,
    tvl: 1_000_000,
    chain: "ethereum",
    protocol: "uniswap-v3",
    ...overrides,
  };
}

describe("classifyCoverage", () => {
  it("returns primary when all TVL is from dl source", () => {
    const { coverageClass } = classifyCoverage(
      makeCoverageInput({ dl: { poolCount: 3, tvlUsd: 10_000_000 } }, 10_000_000),
    );
    expect(coverageClass).toBe("primary");
  });

  it("returns primary when all TVL is from direct_api source", () => {
    const { coverageClass } = classifyCoverage(
      makeCoverageInput({ direct_api: { poolCount: 2, tvlUsd: 5_000_000 } }, 5_000_000),
    );
    expect(coverageClass).toBe("primary");
  });

  it("returns primary when TVL comes from mix of dl and direct_api only", () => {
    const { coverageClass } = classifyCoverage(
      makeCoverageInput(
        { dl: { poolCount: 2, tvlUsd: 4_000_000 }, direct_api: { poolCount: 1, tvlUsd: 1_000_000 } },
        5_000_000,
      ),
    );
    expect(coverageClass).toBe("primary");
  });

  it("returns mixed when TVL spans dl and a fallback source (cg_onchain)", () => {
    const { coverageClass } = classifyCoverage(
      makeCoverageInput(
        { dl: { poolCount: 2, tvlUsd: 4_000_000 }, cg_onchain: { poolCount: 1, tvlUsd: 1_000_000 } },
        5_000_000,
      ),
    );
    expect(coverageClass).toBe("mixed");
  });

  it("returns fallback when all TVL is from cg_onchain only", () => {
    const { coverageClass } = classifyCoverage(
      makeCoverageInput({ cg_onchain: { poolCount: 2, tvlUsd: 3_000_000 } }, 3_000_000),
    );
    expect(coverageClass).toBe("fallback");
  });

  it("returns fallback when all TVL is from cg_tickers only", () => {
    const { coverageClass } = classifyCoverage(
      makeCoverageInput({ cg_tickers: { poolCount: 1, tvlUsd: 2_000_000 } }, 2_000_000),
    );
    expect(coverageClass).toBe("fallback");
  });

  it("returns unobserved when totalTvlUsd is zero", () => {
    const { coverageClass, coverageConfidence } = classifyCoverage(makeCoverageInput({}, 0));
    expect(coverageClass).toBe("unobserved");
    expect(coverageConfidence).toBe(0);
  });

  it("returns unobserved when sourceMix is empty even with positive TVL", () => {
    const { coverageClass } = classifyCoverage(makeCoverageInput({}, 5_000_000));
    expect(coverageClass).toBe("unobserved");
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
  it("collapses two observations sharing the same exactPoolKey to one", () => {
    const obs = [
      makeObs({ poolKey: "ethereum:0xabc", identityConfidence: "exact", price: 0.999, tvl: 2_000_000 }),
      makeObs({ poolKey: "ethereum:0xabc", identityConfidence: "exact", price: 1.001, tvl: 1_000_000 }),
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
});

describe("accumulateGlobalAggregate", () => {
  it("dedupes the same poolId across stablecoins", () => {
    const seenTvl = new Map<string, { tvl: number; vol24h: number; vol7d: number; proto: string; chain: string }>();
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

  it("prefers the higher-TVL row on poolId collision", () => {
    const seenTvl = new Map<string, { tvl: number; vol24h: number; vol7d: number; proto: string; chain: string }>();
    const protoTvl: Record<string, number> = {};
    const chainTvl: Record<string, number> = {};
    const protoChainTvl: Record<string, number> = {};
    const chains = new Set<string>();

    const a = accumulateGlobalAggregate(
      [makePool({ tvlUsd: 4_500_000, volumeUsd1d: 900_000, volumeUsd7d: 6_300_000 })],
      protoTvl, chainTvl, protoChainTvl, chains, seenTvl,
    );
    const b = accumulateGlobalAggregate(
      [makePool({ tvlUsd: 5_000_000, volumeUsd1d: 1_000_000, volumeUsd7d: 7_000_000 })],
      protoTvl, chainTvl, protoChainTvl, chains, seenTvl,
    );

    expect(a.totalTvl + b.totalTvl).toBe(5_000_000);
    expect(protoTvl["balancer"]).toBe(5_000_000);
    expect(chainTvl["ethereum"]).toBe(5_000_000);
  });
});
