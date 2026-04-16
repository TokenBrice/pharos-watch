import { describe, it, expect } from "vitest";
import { accumulateGlobalAggregate, classifyCoverage, collapseDuplicateObservations } from "../scoring-helpers";
import { isPlausibleDexObservationPrice } from "../price-sanity";
import type { DexPriceObs, LiquiditySourceMix, PoolEntry } from "../types";

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
function makeCoverageInput(sourceMix: LiquiditySourceMix, totalTvlUsd: number) {
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

describe("accumulateGlobalAggregate", () => {
  it("dedupes the same poolId across stablecoins", () => {
    const seen = new Set<string>();
    const seenTvl = new Map<string, { tvl: number; vol24h: number; vol7d: number; proto: string; chain: string }>();
    const protoTvl: Record<string, number> = {};
    const chainTvl: Record<string, number> = {};
    const protoChainTvl: Record<string, number> = {};
    const chains = new Set<string>();

    const pool = makePool({});

    const a = accumulateGlobalAggregate([pool], seen, protoTvl, chainTvl, protoChainTvl, chains, seenTvl);
    const b = accumulateGlobalAggregate([pool], seen, protoTvl, chainTvl, protoChainTvl, chains, seenTvl);

    expect(a.totalTvl + b.totalTvl).toBe(5_000_000);
    expect(a.poolCount + b.poolCount).toBe(1);
  });

  it("prefers the higher-TVL row on poolId collision", () => {
    const seen = new Set<string>();
    const seenTvl = new Map<string, { tvl: number; vol24h: number; vol7d: number; proto: string; chain: string }>();
    const protoTvl: Record<string, number> = {};
    const chainTvl: Record<string, number> = {};
    const protoChainTvl: Record<string, number> = {};
    const chains = new Set<string>();

    const a = accumulateGlobalAggregate(
      [makePool({ tvlUsd: 4_500_000, volumeUsd1d: 900_000, volumeUsd7d: 6_300_000 })],
      seen, protoTvl, chainTvl, protoChainTvl, chains, seenTvl,
    );
    const b = accumulateGlobalAggregate(
      [makePool({ tvlUsd: 5_000_000, volumeUsd1d: 1_000_000, volumeUsd7d: 7_000_000 })],
      seen, protoTvl, chainTvl, protoChainTvl, chains, seenTvl,
    );

    expect(a.totalTvl + b.totalTvl).toBe(5_000_000);
    expect(protoTvl["balancer"]).toBe(5_000_000);
    expect(chainTvl["ethereum"]).toBe(5_000_000);
  });
});
