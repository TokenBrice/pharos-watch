import type { FullScoreResult } from "../dex-liquidity/types";

export function makeFullScoreResult(overrides: Partial<FullScoreResult> = {}): FullScoreResult {
  return {
    tvl: 1, effectiveTvl: 1, vol24h: 1, score: 1, hhi: 0.1, durability: 50,
    components: { tvlDepth: 10, volumeActivity: 10, poolQuality: 10, durability: 50, pairDiversity: 5 },
    weightedBalanceRatio: null, organicFrac: null, avgStress: null, lockedLiqPct: null,
    coverageClass: "primary", coverageConfidence: 1,
    sourceMix: { dl: { poolCount: 1, tvlUsd: 1 } },
    balanceMeasuredTvlUsd: 0, organicMeasuredTvlUsd: 0,
    ...overrides,
  };
}
