import type { BluechipGrade, ReportCardGrade } from "../../types";
import { selectLowestSubDimension } from "./lowest-sub-dimension";
import { round1 } from "../math";
import type { ScoredEntry } from "./scoring";
import { selectorComponentProseLabel } from "./selector-labels";
import type {
  ContextKey,
  MergedRow,
  SelectorChainHints,
  SelectorProfile,
  SelectorRankRobustness,
  SelectorRecommendation,
  WhyKey,
  YieldRecommendation,
} from "./types";
import { renderWatchText } from "./what-to-watch-templates";
import { YIELD_OPPORTUNITY_SAFETY_DESCRIPTION } from "../yield-opportunity-provenance";
import { whyKeysByProfile, WHY_KEYS_SET } from "./why-keys";

function pickWhyKeys(
  row: MergedRow,
  profile: SelectorProfile,
): WhyKey[] {
  const candidates = whyKeysByProfile[profile];
  const triggered: WhyKey[] = [];
  for (const key of candidates) {
    if (triggered.length >= 4) break;
    if (whyKeyTriggers(key, row)) triggered.push(key);
  }
  for (const key of triggered) {
    if (!WHY_KEYS_SET.has(key)) {
      throw new Error(`[selector/engine] unknown whyKey emitted: ${key}`);
    }
  }
  return triggered;
}

function whyKeyTriggers(
  key: WhyKey,
  row: MergedRow,
): boolean {
  switch (key) {
    case "top-safety":
      return row.safetyScore != null && row.safetyScore >= 88;
    case "strong-bluechip":
      return (
        row.bluechipGrade === "A+" ||
        row.bluechipGrade === "A" ||
        row.bluechipGrade === "A-"
      );
    case "low-dews":
      return row.dewsScore != null && row.dewsScore <= 25;
    case "clean-peg-history":
      return (
        row.depegEventCount === 0 &&
        row.pegScore != null &&
        row.pegScore >= 80
      );
    case "strong-resilience":
      return row.safetyResilienceScore != null && row.safetyResilienceScore >= 80;
    case "wide-chain-presence":
      return Object.keys(row.chainTvl).length >= 5;
    case "recent-listing":
      return row.isRecentListing;
    case "regulated-custody":
      return (
        row.custodyModel === "institutional-top" ||
        row.custodyModel === "institutional-regulated"
      );
    case "dao-governance":
      return (
        row.governance === "decentralized" &&
        row.safetyDecentralizationScore != null &&
        row.safetyDecentralizationScore >= 70
      );
    case "long-tracking-span":
      return row.trackingSpanDays >= 365;
    case "top-pys":
      return row.pharosYieldScore != null && row.pharosYieldScore >= 85;
    case "yield-above-benchmark":
      return (
        row.apy30d != null &&
        row.benchmarkRate != null &&
        row.apy30d >= row.benchmarkRate + 2
      );
    case "low-variance":
      return row.apyVariance30d != null && row.apyVariance30d <= 0.5;
    case "clean-yield-source":
      return row.venueRiskTier === "low" && row.warningSignals.length === 0;
    case "native-wrapper-rail":
      return row.deploymentPlace === "native-wrapper";
    case "yield-source-recently-switched":
      return row.sourceSwitch;
    case "liquid-on-multiple-chains": {
      const chains = Object.entries(row.chainTvl);
      if (chains.length < 3) return false;
      return chains.every(([, tvl]) => tvl >= 10_000_000);
    }
    case "deepest-liquidity":
      return (
        row.liquidityScore != null &&
        row.liquidityScore >= 85 &&
        row.effectiveTvlUsd != null &&
        row.effectiveTvlUsd >= 100_000_000
      );
    case "multi-dex-presence":
      return row.concentrationHhi != null && row.concentrationHhi <= 0.25;
    case "tight-peg":
      return row.pegScore != null && row.pegScore >= 92;
    case "low-stress":
      return row.dewsScore != null && row.dewsScore <= 20;
    case "strong-exit":
      return row.effectiveExitScore != null && row.effectiveExitScore >= 75;
    default:
      return false;
  }
}

function buildChainHints(
  row: MergedRow,
  profile: SelectorProfile,
): SelectorChainHints {
  const entries = Object.entries(row.chainTvl);
  const topByLiquidity = entries
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([chain]) => chain);
  const topByYield =
    profile === "yield" && row.yieldVenueChain ? [row.yieldVenueChain] : [];
  const primary: string | null = (() => {
    if (profile === "yield") return row.yieldVenueChain ?? topByLiquidity[0] ?? null;
    if (profile === "treasury") {
      return topByLiquidity.find((chain) => chain.toLowerCase() === "ethereum") ?? topByLiquidity[0] ?? null;
    }
    return topByLiquidity[0] ?? null;
  })();
  return { topByLiquidity, topByYield, primary };
}

function buildWhyText(entry: ScoredEntry, profile: SelectorProfile): string {
  const provenanceNote =
    entry.row.safetyProvenance === "yield-opportunity"
      ? ` ${YIELD_OPPORTUNITY_SAFETY_DESCRIPTION}`
      : "";
  const anchors = entry.components
    .filter((component) => component.normalizedValue != null && component.weight > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 2)
    .map(
      (component) =>
        `${selectorComponentProseLabel(component.key)} ${Math.round(component.normalizedValue ?? 0)}`,
    );
  if (anchors.length === 0) {
    return `Score ${round1(entry.score)} under the ${profile} weight set; live coverage is limited.${provenanceNote}`;
  }
  return `Score ${round1(entry.score)} is driven by ${anchors.join(" and ")} under the ${profile} weights.${provenanceNote}`;
}

export function buildRecommendation(
  entry: ScoredEntry,
  rank: 1 | 2 | 3,
  profile: SelectorProfile,
  extraContextKeys: readonly ContextKey[] = [],
  rankRobustness?: SelectorRankRobustness,
): SelectorRecommendation | null {
  const lowest = selectLowestSubDimension(entry.row, profile, entry.components);
  if (lowest == null) {
    return null;
  }
  const safetyGrade: ReportCardGrade = entry.row.safetyGrade ?? "NR";
  const contextKeys = Array.from(new Set([...lowest.contextKeys, ...extraContextKeys]));
  const lowestWithContext = {
    ...lowest,
    contextKeys,
  };
  const base = {
    id: entry.row.id,
    symbol: entry.row.symbol,
    name: entry.row.name,
    rank,
    score: round1(entry.score),
    confidence: round1(entry.confidence),
    confidenceReasons: entry.confidenceReasons,
    components: entry.components,
    whyKeys: pickWhyKeys(entry.row, profile),
    whyText: buildWhyText(entry, profile),
    watchText: renderWatchText(lowestWithContext, profile, entry.row),
    lowestSubDimension: lowestWithContext,
    chainHints: buildChainHints(entry.row, profile),
    rankRobustness,
    relaxedReason: entry.relaxedReason,
    isRecentListing: entry.row.isRecentListing,
    bluechipGrade: (entry.row.bluechipGrade as BluechipGrade | null) ?? null,
    safetyGrade,
    supplyUsd: entry.row.supplyUsd,
    isBeta: true as const,
  };

  if (profile === "treasury") {
    return { ...base, profile: "treasury", recommendedSource: null, perInputStaleness: null };
  }
  if (profile === "yield") {
    if (entry.recommendedSource == null) return null;
    return {
      ...base,
      profile: "yield",
      recommendedSource: entry.recommendedSource,
      perInputStaleness: null,
    } satisfies YieldRecommendation;
  }
  return {
    ...base,
    profile: "trading",
    recommendedSource: null,
    perInputStaleness: entry.perInputStaleness ?? {},
  };
}
