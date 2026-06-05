import type { ExclusionReason, SelectorProfile, WeightKey } from "./types";

export const SELECTOR_PROFILE_LABELS: Readonly<Record<SelectorProfile, string>> = {
  treasury: "Treasury",
  yield: "Yield",
  trading: "Active Trading",
};

export const SELECTOR_EXCLUSION_REASON_LABELS: Readonly<Record<ExclusionReason, string>> = {
  "below-supply-floor": "supply floor",
  "active-depeg": "active depeg",
  "safety-grade-floor": "safety grade",
  "safety-resilience-floor": "resilience",
  "safety-dependency-risk-floor": "dependency risk",
  "dews-ceiling": "DEWS stress",
  "depeg-event-count": "depeg history",
  "bluechip-d-or-f": "blue-chip alignment",
  "peg-score-floor": "PegScore",
  "peg-stability-floor": "peg stability",
  "pys-null": "yield coverage",
  "apy-below-floor": "yield floor",
  "yield-warning-unstable": "yield stability",
  "yield-warning-thin-tvl": "yield depth",
  "high-venue-on-c-tier": "venue risk",
  "liquidity-floor": "liquidity",
  "liquidity-diversification-floor": "liquidity diversification",
  "effective-exit-floor": "effective exit",
  "supply-tvl-floor-1h": "one-hour exit depth",
  "lifecycle-non-active": "lifecycle",
  "peg-currency-mismatch": "peg currency",
  "yield-native-only-violation": "native yield",
  "decentralization-required-violation": "decentralization",
  "custody-regulated-only-violation": "custody model",
  "custody-onchain-only-violation": "custody model",
  "howey-uncertain": "regulatory uncertainty",
  "template-coverage-gap": "template coverage",
  "coverage-too-thin": "coverage",
};

export const SELECTOR_COMPONENT_PROSE_LABELS: Readonly<Record<WeightKey, string>> = {
  safetyOverall: "safety",
  resilience: "resilience",
  dependencyRisk: "dependency risk",
  pegStabilityHistory: "peg history",
  pegStabilityLive: "live peg stability",
  pegScoreNow: "current PegScore",
  decentralization: "decentralization",
  dewsInverted: "stress",
  bluechip: "bluechip alignment",
  supplyLog: "supply depth",
  pharosYieldScore: "Pharos Yield Score",
  excessApy: "excess APY",
  yieldVariance: "APY variance",
  liquidity: "liquidity",
  sourceRiskInverted: "source risk",
  effectiveExit: "effective exit",
  liquidityDiversification: "liquidity diversification",
};

export const SELECTOR_COMPONENT_SCORE_LABELS: Readonly<Record<WeightKey, string>> = {
  safetyOverall: "Safety Score",
  resilience: "Resilience",
  dependencyRisk: "Dependency risk",
  pegStabilityHistory: "Peg history",
  pegStabilityLive: "Live peg stability",
  pegScoreNow: "Current peg score",
  decentralization: "Decentralization",
  dewsInverted: "DEWS stress",
  bluechip: "Blue-chip alignment",
  supplyLog: "Market depth",
  pharosYieldScore: "Pharos Yield Score",
  excessApy: "Net yield",
  yieldVariance: "Yield variance",
  sourceRiskInverted: "Source risk",
  effectiveExit: "Effective exit",
  liquidity: "Liquidity",
  liquidityDiversification: "Liquidity diversification",
};

export const SELECTOR_COMPONENT_READING_LABELS: Readonly<Record<WeightKey, string>> = {
  safetyOverall: "Safety Score",
  resilience: "resilience",
  dependencyRisk: "dependency risk",
  pegStabilityHistory: "peg history",
  pegStabilityLive: "live peg stability",
  pegScoreNow: "current peg score",
  decentralization: "decentralization",
  dewsInverted: "DEWS stress",
  bluechip: "blue-chip alignment",
  supplyLog: "market depth",
  pharosYieldScore: "Pharos Yield Score",
  excessApy: "net yield",
  yieldVariance: "yield variance",
  sourceRiskInverted: "source risk",
  effectiveExit: "effective exit",
  liquidity: "liquidity",
  liquidityDiversification: "liquidity diversification",
};

export const SELECTOR_COMPONENT_LOWEST_SUB_DIMENSION_LABELS: Readonly<Record<WeightKey, string>> = {
  safetyOverall: "Safety",
  resilience: "resilience",
  dependencyRisk: "dependency risk",
  pegStabilityHistory: "peg history",
  pegStabilityLive: "live peg stability",
  pegScoreNow: "current peg score",
  decentralization: "decentralization",
  dewsInverted: "DEWS stress",
  bluechip: "blue-chip alignment",
  supplyLog: "market depth",
  pharosYieldScore: "Pharos Yield Score",
  excessApy: "net yield",
  yieldVariance: "yield variance",
  sourceRiskInverted: "source risk",
  effectiveExit: "effective exit",
  liquidity: "liquidity",
  liquidityDiversification: "liquidity diversification",
};

function lookupSelectorLabel<T extends string>(
  labels: Readonly<Record<T, string>>,
  key: string,
): string | undefined {
  return (labels as Readonly<Record<string, string>>)[key];
}

export function selectorProfileLabel(profile: SelectorProfile): string {
  return SELECTOR_PROFILE_LABELS[profile];
}

export function selectorExclusionReasonLabel(reason: string): string | undefined {
  return lookupSelectorLabel(SELECTOR_EXCLUSION_REASON_LABELS, reason);
}

export function selectorComponentProseLabel(key: string): string | undefined {
  return lookupSelectorLabel(SELECTOR_COMPONENT_PROSE_LABELS, key);
}

export function selectorComponentScoreLabel(key: string): string | undefined {
  return lookupSelectorLabel(SELECTOR_COMPONENT_SCORE_LABELS, key);
}

export function selectorComponentReadingLabel(key: string): string | undefined {
  return lookupSelectorLabel(SELECTOR_COMPONENT_READING_LABELS, key);
}

export function selectorComponentLowestSubDimensionLabel(key: string): string | undefined {
  return lookupSelectorLabel(SELECTOR_COMPONENT_LOWEST_SUB_DIMENSION_LABELS, key);
}
