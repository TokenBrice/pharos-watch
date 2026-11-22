import type { FullScoreResult, LiquidityMetrics } from "./types";

// Exact carried anchor from the November 15 sUSDat incident. See the DEX liquidity appendix.
export const REVIEWED_POOL_REJECTION_ANCHOR_CORRECTION = {
  stablecoinId: "susdat-saturn",
  baselineBeforeSec: 1_794_741_390,
  anchorTvlUsd: 4_811_562.319125249,
  reviewedAt: "2026-11-19T22:26:28Z",
  expiresAt: "2026-11-26T22:26:28Z",
  evidenceRef: "TokenBrice/pharos-watch#2142",
  decisionKey: "dex-liquidity:anchor-review:2142",
} as const;

type CarriedAnchorState = {
  baselineBeforeSec?: number;
  baselineTvlUsdByCoin: Record<string, number | null>;
};

export function matchesReviewedAnchor<T extends CarriedAnchorState>(coverage: T | undefined): coverage is T {
  const { stablecoinId, baselineBeforeSec, anchorTvlUsd } = REVIEWED_POOL_REJECTION_ANCHOR_CORRECTION;
  return coverage?.baselineBeforeSec === baselineBeforeSec && coverage.baselineTvlUsdByCoin[stablecoinId] === anchorTvlUsd;
}

const ANCHOR_REVIEW_MAX_DECAYED_TVL_SHARE = 0.05;

export function hasMeasuredAnchorReviewTvl(
  score: FullScoreResult | undefined,
  pools: LiquidityMetrics["topPools"] | undefined,
): boolean {
  if (
    score == null || !Number.isFinite(score.tvl) || score.tvl <= 0 || score.coverageClass === "unobserved"
    || pools == null || pools.length === 0
  ) {
    return false;
  }
  let decayedTvlUsd = 0;
  let hasLivePrimaryPool = false;
  for (const pool of pools) {
    const measurement = pool.extra?.measurement;
    if (
      measurement?.tvlMeasured !== true || measurement.synthetic
      || !Number.isFinite(pool.tvlUsd) || pool.tvlUsd < 0
    ) {
      return false;
    }
    if (measurement.decayed) {
      decayedTvlUsd += pool.tvlUsd;
    } else if (pool.tvlUsd > 0 && (pool.source === "dl" || pool.source === "direct_api")) {
      hasLivePrimaryPool = true;
    }
  }
  return hasLivePrimaryPool && decayedTvlUsd / score.tvl <= ANCHOR_REVIEW_MAX_DECAYED_TVL_SHARE;
}
