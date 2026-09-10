import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { DexDiscoveryProvider } from "@shared/lib/dex-deployment-coverage";
import type { ContractDeployment } from "@shared/types/core";

/** Raw pool entry written to dex_pool_staging by the discovery cron. */
export interface StagedPool {
  poolId: string;
  stablecoinId: string;
  source:
    | "cg_onchain"
    | "gecko_terminal"
    | "dexscreener"
    | "cg_tickers"
    | "horizon"
    | "aquarius"
    | "tezos"
    | "icon-balanced"
    | "kava-swap"
    | "osmosis-sqs"
    | "noble-swap";
  chain: string;
  protocol: string;
  dexId: string | null;
  symbol: string;
  tvlUsd: number | null;
  volume24h: number | null;
  qualityMultiplier: number | null;
  poolType: string | null;
  feeTier: number | null;
  balanceRatio: number | null;
  isStable: boolean | null;
  baseToken: string | null;
  quoteToken: string | null;
  quoteSymbol: string | null;
  priceUsd: number | null;
  lockedLiqPct: number | null;
  rawJson: string | null;
  discoveredAt: number;
  refreshedAt: number;
}

/** Backoff state per stablecoin, read from dex_discovery_meta. */
export interface DiscoveryMeta {
  stablecoinId: string;
  consecutiveMisses: number;
  lastCrawlAt: number;
  lastHitAt: number | null;
}

export type DexDeploymentProviderCheckStatus = "success" | "failure" | "degraded";

export interface DexDeploymentProviderCheck {
  chain: string;
  address: string;
  provider: DexDiscoveryProvider;
  status: DexDeploymentProviderCheckStatus;
  observedPoolCount?: number;
  /** Timeout, 429, or other transport miss — do not persist as a hard provider outage. */
  retryable?: boolean;
}

export function makeDexDeploymentProviderCheck(
  target: Pick<ContractDeployment, "chain" | "address">,
  provider: DexDeploymentProviderCheck["provider"],
  status: DexDeploymentProviderCheck["status"],
  extras?: Pick<DexDeploymentProviderCheck, "observedPoolCount" | "retryable">,
): DexDeploymentProviderCheck {
  return {
    chain: target.chain,
    address: target.address,
    provider,
    status,
    ...(extras?.observedPoolCount !== undefined ? { observedPoolCount: extras.observedPoolCount } : {}),
    ...(extras?.retryable === true ? { retryable: true } : {}),
  };
}

/**
 * Max TVL for a staged secondary-source pool. Anything above this is treated as
 * malformed upstream data rather than a valid DEX venue.
 */
export const STAGED_POOL_MAX_TVL_USD = 10_000_000_000;

/**
 * Defaults applied when staged pools lack fields that primary sources expose.
 * The scoring merge should stay aligned with these values instead of inlining its own.
 */
export const STAGED_POOL_DEFAULTS = {
  organicFraction: 0.5,
  balanceRatioFallback: 1.0,
  lockedLiquidityFallback: null as number | null,
} as const;

/**
 * Staged rows are trusted at full weight for one day: hourly observation is the
 * norm, so a single missed run costs nothing. Beyond that the weight ramps
 * linearly to zero at the confidence horizon, sized from the measured census
 * revisit tail (p95 in the 7–14 day band on 2026-09-10) so a slow rotating
 * crawl no longer drops pools it simply has not revisited yet.
 */
export const STAGED_POOL_FRESH_HOURS = 24;
export const STAGED_POOL_CONFIDENCE_HORIZON_HOURS = 14 * 24;
/**
 * Price evidence never inherits the inventory horizon: a staged row older than
 * this contributes decayed TVL but no price observation and no retained-pool
 * price, so dex_prices, DDR and peg-summary only ever see day-fresh prices.
 */
export const STAGED_POOL_PRICE_MAX_AGE_HOURS = 24;

/**
 * Confidence decay for staged pool freshness: 1.0 through the fresh window,
 * then linear to 0 at the confidence horizon.
 */
export function stagedPoolConfidence(ageHours: number): number {
  ageHours = Math.max(0, ageHours);
  if (ageHours <= STAGED_POOL_FRESH_HOURS) return 1;
  if (ageHours >= STAGED_POOL_CONFIDENCE_HORIZON_HOURS) return 0;
  return (STAGED_POOL_CONFIDENCE_HORIZON_HOURS - ageHours) / (STAGED_POOL_CONFIDENCE_HORIZON_HOURS - STAGED_POOL_FRESH_HOURS);
}

/**
 * Estimate maturity as days since discovery, capped to avoid overstating durability.
 */
export function stagedPoolMaturityDays(discoveredAt: number, now: number): number {
  const days = (now - discoveredAt) / DAY_SECONDS;
  return Math.min(Math.max(0, days), 30);
}

/** Tier thresholds for discovery priority. */
export const DISCOVERY_TIERS = {
  // Sentinel: coins with zero discovered pools get the highest crawl cadence (t1).
  T1_ZERO_POOL_SENTINEL: 0,
  T2_MAX_POOLS: 4,
  // The discovery cron runs every two hours, so 84 runs is one week.
  T2_MODULO: 84,
  T3_MODULO: 84,
  BACKOFF_T2_MISSES: 3,
  BACKOFF_T3_MISSES: 6,
  BACKOFF_DORMANT_MISSES: 10,
  DORMANT_INTERVAL_SEC: DAY_SECONDS,
} as const;
