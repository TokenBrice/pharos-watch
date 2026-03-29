import { LIQUIDITY_SCORE_WEIGHTS } from "@shared/lib/liquidity-score-weights";

export { DURABILITY_COMPONENT_WEIGHTS } from "@shared/lib/liquidity-score-weights";

export const LIQUIDITY_COMPONENT_WEIGHTS = {
  tvlDepth: LIQUIDITY_SCORE_WEIGHTS[0].weight,
  volumeActivity: LIQUIDITY_SCORE_WEIGHTS[1].weight,
  poolQuality: LIQUIDITY_SCORE_WEIGHTS[2].weight,
  durability: LIQUIDITY_SCORE_WEIGHTS[3].weight,
  pairDiversity: LIQUIDITY_SCORE_WEIGHTS[4].weight,
} as const;
