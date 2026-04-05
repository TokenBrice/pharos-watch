/**
 * Liquidity Score component weights (current methodology v5.x).
 * Single source of truth consumed by the worker scoring engine,
 * the dex-liquidity-card breakdown, and the report-card detail.
 */
export const LIQUIDITY_SCORE_WEIGHTS = [
  { key: "tvlDepth" as const, label: "TVL Depth", weight: 0.30, displayWeight: "30%", tooltip: "Effective TVL relative to market cap (log-scale depth ratio)" },
  { key: "volumeActivity" as const, label: "Volume", weight: 0.20, displayWeight: "20%", tooltip: "Log-scale volume/TVL ratio" },
  { key: "poolQuality" as const, label: "Pool Quality", weight: 0.20, displayWeight: "20%", tooltip: "Venue quality retention: mechanism multiplier × balance health" },
  { key: "durability" as const, label: "Durability", weight: 0.20, displayWeight: "20%", tooltip: "TVL stability, volume consistency, maturity, organic fees" },
  { key: "pairDiversity" as const, label: "Diversity", weight: 0.10, displayWeight: "10%", tooltip: "Number of distinct liquidity pools" },
] as const;

export type LiquidityScoreComponentKey = (typeof LIQUIDITY_SCORE_WEIGHTS)[number]["key"];

export const DURABILITY_COMPONENT_WEIGHTS = {
  organicFraction: 0.15,
  tvlStability: 0.35,
  volumeConsistency: 0.25,
  maturity: 0.25,
} as const;
