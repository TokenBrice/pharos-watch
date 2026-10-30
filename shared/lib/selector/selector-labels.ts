import type { ExclusionReason, SelectorProfile, WeightKey } from "./types";

const SELECTOR_PROFILE_LABELS: Readonly<Record<SelectorProfile, string>> = {
  treasury: "Treasury",
  yield: "Yield",
  trading: "Active Trading",
};

const SELECTOR_EXCLUSION_REASON_LABELS: Readonly<Record<ExclusionReason, string>> = {
  "supply-unavailable": "supply data",
  "below-supply-floor": "supply floor",
  "active-depeg": "active depeg",
  "safety-grade-floor": "safety grade",
  "safety-resilience-floor": "Backing",
  "safety-dependency-risk-floor": "V9 dependency context",
  "dews-ceiling": "DEWS stress",
  "bluechip-d-or-f": "blue-chip alignment",
  "peg-score-floor": "PegScore",
  "pys-null": "yield coverage",
  "apy-below-floor": "yield floor",
  "yield-warning-unstable": "yield stability",
  "yield-warning-thin-tvl": "yield depth",
  "high-venue-on-c-tier": "venue risk",
  "liquidity-floor": "liquidity",
  "effective-exit-floor": "Exit",
  "supply-tvl-floor-1h": "one-hour exit depth",
  "peg-currency-mismatch": "peg currency",
  "yield-native-only-violation": "native yield",
  "decentralization-required-violation": "decentralization",
  "insufficient-control-evidence": "reviewed freeze-control evidence",
  "custody-regulated-only-violation": "custody model",
  "custody-onchain-only-violation": "custody model",
  "howey-uncertain": "regulatory uncertainty",
  "template-coverage-gap": "template coverage",
  "coverage-too-thin": "coverage",
};

/**
 * Labels for `buildWhyText`, which prints each component's normalized 0-100
 * index. A transformed slot must therefore be named by its index ("APY
 * stability"), never by the raw metric it was derived from ("APY variance"):
 * the printed number is the index, not the observed reading.
 */
const SELECTOR_COMPONENT_PROSE_LABELS: Readonly<Record<WeightKey, string>> = {
  safetyOverall: "safety",
  resilience: "Backing",
  dependencyRisk: "V9 dependency context",
  pegStabilityHistory: "peg history",
  pegStabilityLive: "live peg stability",
  pegScoreNow: "current PegScore",
  decentralization: "Economic Control",
  dewsInverted: "stress resilience",
  bluechip: "bluechip alignment",
  supplyLog: "market depth score",
  pharosYieldScore: "Pharos Yield Score",
  excessApy: "net yield score",
  yieldVariance: "APY stability",
  liquidity: "liquidity",
  sourceRiskInverted: "source risk resilience",
  effectiveExit: "Exit",
  liquidityDiversification: "liquidity diversification score",
};

const SELECTOR_COMPONENT_SCORE_LABELS: Readonly<Record<WeightKey, string>> = {
  safetyOverall: "Safety Score",
  resilience: "Backing",
  dependencyRisk: "V9 dependency context",
  pegStabilityHistory: "Peg history",
  pegStabilityLive: "Live peg stability",
  pegScoreNow: "Current peg score",
  decentralization: "Economic Control",
  dewsInverted: "DEWS stress",
  bluechip: "Blue-chip alignment",
  supplyLog: "Market depth",
  pharosYieldScore: "Pharos Yield Score",
  excessApy: "Net yield",
  yieldVariance: "Yield variance",
  sourceRiskInverted: "Source risk",
  effectiveExit: "Exit",
  liquidity: "Liquidity",
  liquidityDiversification: "Liquidity diversification",
};

const SELECTOR_COMPONENT_READING_LABELS: Readonly<Record<WeightKey, string>> = {
  safetyOverall: "Safety Score",
  resilience: "Backing",
  dependencyRisk: "V9 dependency context",
  pegStabilityHistory: "peg history",
  pegStabilityLive: "live peg stability",
  pegScoreNow: "current peg score",
  decentralization: "Economic Control",
  dewsInverted: "DEWS stress",
  bluechip: "blue-chip alignment",
  supplyLog: "market depth",
  pharosYieldScore: "Pharos Yield Score",
  excessApy: "net yield",
  yieldVariance: "yield variance",
  sourceRiskInverted: "source risk",
  effectiveExit: "Exit",
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

export const selectorComponentProseLabel = ((key: string): string | undefined => {
  return lookupSelectorLabel(SELECTOR_COMPONENT_PROSE_LABELS, key);
}) as {
  (key: WeightKey): string;
  (key: string): string | undefined;
};

export function selectorComponentScoreLabel(key: string): string | undefined {
  return lookupSelectorLabel(SELECTOR_COMPONENT_SCORE_LABELS, key);
}

export function selectorComponentReadingLabel(key: string): string | undefined {
  return lookupSelectorLabel(SELECTOR_COMPONENT_READING_LABELS, key);
}

export function selectorComponentLowestSubDimensionLabel(key: string): string | undefined {
  // Identical to the reading labels except safetyOverall ("Safety" vs "Safety Score").
  if (key === "safetyOverall") return "Safety";
  return lookupSelectorLabel(SELECTOR_COMPONENT_READING_LABELS, key);
}
