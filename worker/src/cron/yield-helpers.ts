// worker/src/cron/yield-helpers.ts
// Pure computation functions for yield intelligence. No I/O.

export const STALE_THRESHOLD_MS = 90 * 60 * 1000; // 3 sync cycles

// --- PYS formula constants ---
const PYS_RISK_PENALTY_FLOOR = 0.5;
const PYS_SUSTAINABILITY_FLOOR = 0.3;

// --- Warning signal thresholds ---
const YIELD_SPIKE_THRESHOLD = 2.0;
const YIELD_DIVERGENCE_THRESHOLD = 3.0;
const NEGATIVE_TREND_THRESHOLD = 0.7;
const REWARD_HEAVY_THRESHOLD = 0.8;
const TVL_OUTFLOW_THRESHOLD = -0.2;
const YIELD_SPIKE_MIN_APY = 2.0; // only flag spike if currentApy > 2%
const NEGATIVE_TREND_MIN_APY = 1.0; // only flag negative trend if apy30d > 1%
const ZERO_YIELD_HISTORY_THRESHOLD = 0.5; // flag when current=0 but 30d avg > 0.5%

export function computeApyFromRate(rateNow: number, ratePrev: number, days: number): number {
  if (ratePrev <= 0 || rateNow <= 0 || days <= 0) return 0;
  const ratio = rateNow / ratePrev;
  if (ratio === 1) return 0;
  return (Math.pow(ratio, 365.25 / days) - 1) * 100;
}

export function computeApyFromPrice(priceNow: number, pricePrev: number, days: number): number {
  return computeApyFromRate(priceNow, pricePrev, days);
}

interface PYSInput {
  apy30d: number;
  safetyScore: number;
  apyVarianceScore: number;
  scalingFactor: number;
}

export function computePYS({ apy30d, safetyScore, apyVarianceScore, scalingFactor }: PYSInput): number {
  if (apy30d <= 0) return 0;
  const riskPenalty = Math.max(PYS_RISK_PENALTY_FLOOR, (101 - safetyScore) / 20);
  const yieldEfficiency = apy30d / riskPenalty;
  const sustainabilityMultiplier = Math.max(PYS_SUSTAINABILITY_FLOOR, 1.0 - apyVarianceScore);
  return Math.min(100, Math.round(yieldEfficiency * sustainabilityMultiplier * scalingFactor));
}

export function computeYieldStability(apySamples: number[]): number | null {
  if (apySamples.length < 2) return null;
  const mean = apySamples.reduce((s, v) => s + v, 0) / apySamples.length;
  if (Math.abs(mean) < 1e-10) return null;
  const variance = apySamples.reduce((s, v) => s + (v - mean) ** 2, 0) / apySamples.length;
  const cv = Math.sqrt(variance) / Math.abs(mean);
  return Math.max(0, Math.min(1, Math.round((1 - cv) * 100) / 100));
}

export function computeApyVarianceScore(apySamples: number[]): number | null {
  if (apySamples.length < 2) return null;
  const mean = apySamples.reduce((s, v) => s + v, 0) / apySamples.length;
  if (Math.abs(mean) < 1e-10) return null;
  const variance = apySamples.reduce((s, v) => s + (v - mean) ** 2, 0) / apySamples.length;
  return Math.min(1, Math.sqrt(variance) / Math.abs(mean));
}

interface WarningInput {
  currentApy: number;
  apy30d: number;
  apyReward: number | null;
  medianApy: number;
  sourceTvlUsd: number | null;
  prevTvlUsd: number | null;
}

export function detectWarningSignals(input: WarningInput): string[] {
  const signals: string[] = [];
  if (input.apy30d > 0 && input.currentApy > YIELD_SPIKE_MIN_APY && input.currentApy / input.apy30d > YIELD_SPIKE_THRESHOLD) signals.push("yield-spike");
  if (input.medianApy > 0 && input.currentApy > input.medianApy * YIELD_DIVERGENCE_THRESHOLD) signals.push("yield-divergence");
  if (input.apy30d > NEGATIVE_TREND_MIN_APY && input.currentApy < input.apy30d * NEGATIVE_TREND_THRESHOLD) signals.push("negative-trend");
  if (input.apyReward != null && input.currentApy > 0 && input.apyReward / input.currentApy > REWARD_HEAVY_THRESHOLD) signals.push("reward-heavy");
  if (input.sourceTvlUsd != null && input.prevTvlUsd != null && input.prevTvlUsd > 0) {
    const change = (input.sourceTvlUsd - input.prevTvlUsd) / input.prevTvlUsd;
    if (change < TVL_OUTFLOW_THRESHOLD) signals.push("tvl-outflow");
  }
  if (input.currentApy === 0 && input.apy30d > ZERO_YIELD_HISTORY_THRESHOLD) signals.push("zero-yield");
  return signals;
}

/**
 * Returns ALL DL pools that are yield sources for the given coin.
 *
 * Layer 1: YIELD_POOL_MAP (native/primary pool — stablecoin + single exposure required)
 * Layer 2: YIELD_VARIANT_MAP (wrapper/savings pool — single exposure only; stablecoin
 *          flag relaxed because savings wrappers like fxSAVE are not flagged as
 *          stablecoin=true in DeFiLlama)
 * Layer 3: Base-symbol fallback (only when both static maps miss — stablecoin + single
 *          exposure required, picks highest TVL)
 *
 * Deduplicates by pool UUID. Used by sync-yield-data to support multiple sources per coin.
 */
export function matchAllDlPools(
  stablecoinId: string,
  symbol: string,
  dlPools: Array<{
    pool: string; symbol: string; tvlUsd: number;
    apy: number; apyBase: number | null; apyReward: number | null;
    stablecoin: boolean; exposure: string;
  }>,
  poolMap: Record<string, string>,
  variantMap: Record<string, { variantSymbol: string }>,
): Array<{ pool: string; apy: number; apyBase: number | null; apyReward: number | null; tvlUsd: number }> {
  const found: Array<{ pool: string; apy: number; apyBase: number | null; apyReward: number | null; tvlUsd: number }> = [];
  const seenUuids = new Set<string>();

  // Layer 1: Static pool map (native/primary source — stablecoin=true required)
  const nativeId = poolMap[stablecoinId];
  if (nativeId) {
    const p = dlPools.find(p => p.pool === nativeId && p.exposure === "single");
    if (p) {
      found.push({ pool: p.pool, apy: p.apy, apyBase: p.apyBase, apyReward: p.apyReward, tvlUsd: p.tvlUsd });
      seenUuids.add(p.pool);
    } else if (!dlPools.find(p => p.pool === nativeId)) {
      console.warn(`[yield-sync] Pool UUID ${nativeId} for ${stablecoinId} not found in DL response, falling through`);
    }
  }

  // Layer 2: Variant map (wrapper/savings pool — stablecoin flag relaxed)
  const variant = variantMap[stablecoinId];
  if (variant) {
    const sym = variant.variantSymbol.toLowerCase();
    const candidates = dlPools.filter(p => p.exposure === "single" && p.symbol.toLowerCase() === sym);
    if (candidates.length > 0) {
      const best = candidates.reduce((a, b) => b.tvlUsd > a.tvlUsd ? b : a);
      if (!seenUuids.has(best.pool)) {
        found.push({ pool: best.pool, apy: best.apy, apyBase: best.apyBase, apyReward: best.apyReward, tvlUsd: best.tvlUsd });
        seenUuids.add(best.pool);
      }
    }
  }

  // Layer 3: Base-symbol fallback (only when both static maps miss — stablecoin=true required)
  if (found.length === 0) {
    const sym = symbol.toLowerCase();
    const candidates = dlPools.filter(p => p.exposure === "single" && p.stablecoin && p.symbol.toLowerCase().includes(sym));
    if (candidates.length > 0) {
      const best = candidates.reduce((a, b) => b.tvlUsd > a.tvlUsd ? b : a);
      found.push({ pool: best.pool, apy: best.apy, apyBase: best.apyBase, apyReward: best.apyReward, tvlUsd: best.tvlUsd });
    }
  }

  return found;
}

/**
 * Auto-discovery: find the best lending pool for a coin from allowlisted protocols.
 * Used for non-yield-bearing stablecoins rated C+ or above (Wave 2).
 *
 * Filters: single exposure, stablecoin = true, project in allowlist, symbol match.
 * Optional quality gates: minimum APY and minimum TVL.
 * Picks the highest-TVL pool.
 */
export function findBestLendingPool(
  symbol: string,
  dlPools: Array<{
    pool: string; symbol: string; project: string; tvlUsd: number;
    apy: number; apyBase: number | null; apyReward: number | null;
    stablecoin: boolean; exposure: string;
    underlyingTokens?: string[] | null;
  }>,
  allowlist: Set<string>,
  options?: {
    minApy?: number;
    minTvlUsd?: number;
    contractAddresses?: string[];
  },
): { pool: string; apy: number; apyBase: number | null; apyReward: number | null; tvlUsd: number; project: string } | null {
  const symLower = symbol.toLowerCase();
  const minApy = options?.minApy ?? 0;
  const minTvlUsd = options?.minTvlUsd ?? 0;
  const contractSet = new Set((options?.contractAddresses ?? []).map((a) => a.toLowerCase()));

  const baseCandidates = dlPools.filter((p) =>
    p.exposure === "single" &&
    p.stablecoin &&
    allowlist.has(p.project) &&
    p.apy >= minApy &&
    p.tvlUsd >= minTvlUsd
  );

  // Primary match: exact symbol (existing behavior).
  const symbolCandidates = baseCandidates.filter((p) => p.symbol.toLowerCase() === symLower);
  if (symbolCandidates.length > 0) {
    const best = symbolCandidates.reduce((a, b) => (b.tvlUsd > a.tvlUsd ? b : a));
    return {
      pool: best.pool,
      apy: best.apy,
      apyBase: best.apyBase,
      apyReward: best.apyReward,
      tvlUsd: best.tvlUsd,
      project: best.project,
    };
  }

  // Fallback: underlying token address match (covers symbol drift like FEUSDH/STEAKEURCV).
  if (contractSet.size === 0) return null;
  const addressCandidates = baseCandidates.filter((p) =>
    (p.underlyingTokens ?? []).some((addr) => contractSet.has(addr.toLowerCase()))
  );
  if (addressCandidates.length === 0) return null;

  const best = addressCandidates.reduce((a, b) => (b.tvlUsd > a.tvlUsd ? b : a));
  return {
    pool: best.pool,
    apy: best.apy,
    apyBase: best.apyBase,
    apyReward: best.apyReward,
    tvlUsd: best.tvlUsd,
    project: best.project,
  };
}
