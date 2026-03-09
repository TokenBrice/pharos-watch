/** Raw pool entry written to dex_pool_staging by the discovery cron. */
export interface StagedPool {
  poolId: string; // chain:address (lowercase)
  stablecoinId: string;
  source: "cg_onchain" | "gecko_terminal" | "dexscreener" | "cg_tickers";
  chain: string;
  protocol: string; // normalized protocol name
  symbol: string; // pool symbol e.g. "USDC/USDT"
  tvlUsd: number | null;
  volume24h: number | null;
  feeTier: number | null; // basis points
  balanceRatio: number | null; // 0-1
  isStable: boolean | null;
  baseToken: string | null;
  quoteToken: string | null;
  quoteSymbol: string | null;
  priceUsd: number | null;
  lockedLiqPct: number | null;
  rawJson: string | null;
  discoveredAt: number; // epoch seconds
  refreshedAt: number; // epoch seconds
}

/** Backoff state per stablecoin, read from dex_discovery_meta. */
export interface DiscoveryMeta {
  stablecoinId: string;
  consecutiveMisses: number;
  lastCrawlAt: number; // epoch seconds
  lastHitAt: number | null; // epoch seconds, null if never found pools
}

/**
 * Staged pool defaults contract.
 * Defines how missing fields are handled when merging staged pools into scoring.
 * Used by the scoring cron's merge logic - NOT by the discovery cron.
 */
export const STAGED_POOL_DEFAULTS = {
  /** No incentive data available from discovery sources */
  organicFraction: 0.5,
  /** Conservative - balance data only from CG Onchain; GT/DS/tickers lack it */
  balanceRatioFallback: 1.0,
  /** Only CG Onchain provides locked liquidity */
  lockedLiquidityFallback: null as number | null,
} as const;

/**
 * Confidence decay for staged pool age.
 * Multiplies into effective TVL alongside quality multiplier.
 * @param ageHours - hours since the pool was last refreshed
 * @returns confidence multiplier between 0 and 1 (0 means excluded)
 */
export function stagedPoolConfidence(ageHours: number): number {
  if (ageHours > 24) return 0; // excluded
  return Math.max(0.5, 1 - ageHours / 48);
}

/**
 * Maturity estimate for staged pool (days since first discovered).
 * Capped at 30 to avoid inflating durability for long-lived staging rows.
 */
export function stagedPoolMaturityDays(discoveredAt: number, now: number): number {
  const days = (now - discoveredAt) / 86400;
  return Math.min(Math.max(0, days), 30);
}

/** Tier thresholds for discovery priority. */
export const DISCOVERY_TIERS = {
  /** 0 pools from primary sources -> crawl every run */
  T1_MAX_POOLS: 0,
  /** 1-4 pools or single chain -> crawl every 3rd run */
  T2_MAX_POOLS: 4,
  /** T2 modulo divisor */
  T2_MODULO: 3,
  /** T3 (>=5 pools, >=2 chains) -> crawl every 10th run */
  T3_MODULO: 10,
  /** Backoff: 3-5 misses -> demote to T2 cadence */
  BACKOFF_T2_MISSES: 3,
  /** Backoff: 6-9 misses -> demote to T3 cadence */
  BACKOFF_T3_MISSES: 6,
  /** Backoff: 10+ misses -> dormant (daily only) */
  BACKOFF_DORMANT_MISSES: 10,
  /** Dormant = at most once per 24h */
  DORMANT_INTERVAL_SEC: 86400,
} as const;
