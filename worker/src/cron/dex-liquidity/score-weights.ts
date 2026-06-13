import { LIQUIDITY_SCORE_WEIGHTS, type LiquidityScoreComponentKey } from "@shared/lib/liquidity-score-weights";

export const LIQUIDITY_COMPONENT_WEIGHTS = Object.fromEntries(
  LIQUIDITY_SCORE_WEIGHTS.map(({ key, weight }) => [key, weight]),
) as Record<LiquidityScoreComponentKey, number>;
