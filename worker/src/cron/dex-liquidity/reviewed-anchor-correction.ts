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

export function hasMeasuredAnchorReviewTvl(
  score: FullScoreResult | undefined,
  pools: LiquidityMetrics["topPools"] | undefined,
): boolean {
  return score != null && Number.isFinite(score.tvl) && score.tvl > 0 && score.coverageClass !== "unobserved"
    && pools != null && pools.length > 0 && pools.every(({ extra }) => extra?.measurement?.tvlMeasured === true
      && !extra.measurement.synthetic && !extra.measurement.decayed);
}
