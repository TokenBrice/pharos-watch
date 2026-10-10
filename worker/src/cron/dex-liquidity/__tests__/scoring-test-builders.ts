import type { DexPriceObs, GtNewPool, LiquidityMetrics, PoolEntry } from "../types";
import { summarizeRetainedPoolVolume } from "../scoring-helpers";
import { DEX_VOLUME_OBSERVATION_MAX_AGE_SEC } from "@shared/lib/dex-volume-availability";

export type PoolOverrides = Partial<PoolEntry> & Pick<PoolEntry, "poolId" | "project" | "chain" | "tvlUsd">;

export interface PoolMapEntry {
  stablecoinId: string;
  pools: readonly PoolOverrides[];
}

export type PricePoolSpec = PoolOverrides & { stablecoinId: string };

export interface ObservationMapEntry {
  stablecoinId: string;
  observations: readonly (Partial<DexPriceObs> & Pick<DexPriceObs, "price" | "tvl" | "chain" | "protocol">)[];
}

export function makePool(overrides: Partial<PoolEntry> = {}): PoolEntry {
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

export function makeGtPool(address: string, overrides: Partial<GtNewPool> = {}): GtNewPool {
  return {
    address,
    chain: "ethereum",
    dexId: "uniswap-v3",
    name: "USDC / USDT",
    tvlUsd: 100_000,
    volume24hUsd: 10_000,
    qualityMultiplier: 0.8,
    maturityDays: 30,
    price: 1,
    symbol: "USDC / USDT",
    poolType: "uniswap-v3-5bp",
    sourceFamily: "direct_api",
    ...overrides,
  };
}

export function makeObs(overrides: Partial<DexPriceObs> = {}): DexPriceObs {
  return {
    price: 1.0,
    tvl: 1_000_000,
    chain: "ethereum",
    protocol: "uniswap-v3",
    ...overrides,
  };
}

export function makePoolMap(entries: readonly PoolMapEntry[]): Map<string, PoolEntry[]> {
  return new Map(entries.map(({ stablecoinId, pools }) => [stablecoinId, pools.map((pool) => makePool(pool))]));
}

export function makePricePoolMap(entries: readonly PricePoolSpec[]): Map<string, PoolEntry[]> {
  const grouped = new Map<string, PoolEntry[]>();
  for (const { stablecoinId, ...pool } of entries) {
    grouped.set(stablecoinId, [...(grouped.get(stablecoinId) ?? []), makePool(pool)]);
  }
  return grouped;
}

export function makeObservationMap(entries: readonly ObservationMapEntry[]): Map<string, DexPriceObs[]> {
  return new Map(entries.map(({ stablecoinId, observations }) => [stablecoinId, observations.map((observation) => makeObs(observation))]));
}

/**
 * Records a metric's totals as one retained pool whose readings were admitted at
 * the evaluation clock, i.e. a complete 24h/7d window (full volume coverage).
 */
export function withCompleteVolume(m: LiquidityMetrics): LiquidityMetrics {
  const asOfSec = 1_800_000_000;
  m.volumeAvailability = summarizeRetainedPoolVolume(
    [{
      reading: { volume24hUsd: m.totalVolume24hUsd ?? 0, volume7dUsd: m.totalVolume7dUsd, observedAtSec: asOfSec },
      tvlUsd: m.totalTvlUsd,
    }],
    { asOfSec, maxObservationAgeSec: DEX_VOLUME_OBSERVATION_MAX_AGE_SEC },
  ).volumeAvailability;
  return m;
}
