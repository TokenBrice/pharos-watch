export const DURABILITY_COMPONENT_WEIGHTS = {
  organicFraction: 0.15,
  tvlStability: 0.35,
  volumeConsistency: 0.25,
  maturity: 0.25,
} as const;

export const LIQUIDITY_COMPONENT_WEIGHTS = {
  tvlDepth: 0.35,
  volumeActivity: 0.2,
  poolQuality: 0.225,
  durability: 0.15,
  pairDiversity: 0.075,
} as const;
