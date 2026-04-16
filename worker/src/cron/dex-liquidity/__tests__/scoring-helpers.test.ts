import { describe, it, expect } from "vitest";
import { accumulateGlobalAggregate } from "../scoring-helpers";
import { isPlausibleDexObservationPrice } from "../price-sanity";
import type { PoolEntry } from "../types";

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
