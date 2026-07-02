import {
  excessApyConcave,
  sourceRiskInverted,
} from "./normalization";
import { clamp } from "../math";
import type {
  MergedRow,
  RecommendedSource,
  SelectorInput,
  YieldSourceCandidate,
} from "./types";

interface ScoredYieldSourceCandidate {
  candidate: YieldSourceCandidate;
  score: number;
  risk: number;
  depth: number;
  freshness: number;
}

function riskTierScore(tier: YieldSourceCandidate["venueRiskTier"]): number {
  if (tier === "low") return 100;
  if (tier === "mid") return 70;
  if (tier === "high") return 35;
  return 55;
}

function venueMatchesPreference(
  candidate: YieldSourceCandidate,
  input: SelectorInput,
): boolean {
  const prefs = input.venuePreferences?.filter((pref) =>
    pref === "lend" || pref === "dex" || pref === "wrap" || pref === "all",
  );
  if (!prefs || prefs.length === 0 || prefs.includes("all")) return true;
  return prefs.some((pref) => {
    if (pref === "lend") {
      return (
        candidate.yieldType === "lending-vault" ||
        candidate.yieldType === "lending-opportunity" ||
        candidate.yieldType === "fixed-yield" ||
        candidate.yieldType === "structured-tranche" ||
        candidate.deploymentPlace === "lending"
      );
    }
    if (pref === "dex") {
      return candidate.yieldType === "lp-receipt" || candidate.deploymentPlace === "lp";
    }
    if (pref === "wrap") {
      return (
        candidate.yieldType === "rebase" ||
        candidate.yieldType === "nav-appreciation" ||
        candidate.deploymentPlace === "native-wrapper" ||
        candidate.deploymentPlace === "issuer-savings"
      );
    }
    return false;
  });
}

function sourceDepthScore(candidate: YieldSourceCandidate): number {
  if (candidate.sourceDepthRatio != null) {
    return clamp(candidate.sourceDepthRatio * 100, 0, 100);
  }
  if (candidate.sourceTvlUsd == null || candidate.sourceTvlUsd <= 0) return 45;
  return clamp((Math.log10(candidate.sourceTvlUsd) / Math.log10(500_000_000)) * 100, 0, 100);
}

function sourceFreshnessScore(candidate: YieldSourceCandidate): number {
  const age = candidate.freshness?.ageSeconds;
  if (age == null) return 50;
  return clamp(100 - (age / 172_800) * 100, 0, 100);
}

function yieldSourceScore(
  candidate: YieldSourceCandidate,
  input: SelectorInput,
  benchmarkRate: number | null,
  depth: number,
  freshness: number,
): number {
  const venue = venueMatchesPreference(candidate, input) ? 100 : 35;
  const risk =
    candidate.sourceRiskScore != null
      ? sourceRiskInverted(candidate.sourceRiskScore)
      : riskTierScore(candidate.venueRiskTier);
  // Match the main scorer's excess-APY definition (scoring.ts excessApy):
  // measure against the per-coin benchmarkRate so non-USD pegs use the
  // peg-appropriate benchmark instead of a flat 4% floor. Fall back to 4
  // only when the row has no benchmark.
  const apy = excessApyConcave(candidate.apy30d - (benchmarkRate ?? 4)) ?? 0;
  return venue * 0.35 + risk * 0.25 + depth * 0.2 + freshness * 0.15 + apy * 0.05;
}

function scoreYieldSourceCandidate(
  candidate: YieldSourceCandidate,
  input: SelectorInput,
  benchmarkRate: number | null,
): ScoredYieldSourceCandidate {
  const risk = riskTierScore(candidate.venueRiskTier);
  const depth = sourceDepthScore(candidate);
  const freshness = sourceFreshnessScore(candidate);
  const score = yieldSourceScore(candidate, input, benchmarkRate, depth, freshness);
  return { candidate, score, risk, depth, freshness };
}

function fallbackYieldSources(row: MergedRow): YieldSourceCandidate[] {
  if (
    row.pharosYieldScore == null ||
    row.apy30d == null ||
    row.yieldProtocolSlug == null ||
    row.yieldVenueChain == null
  ) {
    return [];
  }
  return [
    {
      sourceKey: `${row.yieldProtocolSlug}:${row.yieldVenueChain}`,
      protocol: row.yieldProtocolSlug,
      chain: row.yieldVenueChain,
      yieldType: null,
      apy30d: row.apy30d,
      pharosYieldScore: row.pharosYieldScore,
      sourceTvlUsd: row.effectiveTvlUsd,
      dataSource: null,
      sourceRiskScore: row.sourceRiskScore,
      venueRiskTier: row.venueRiskTier,
      deploymentPlace: row.deploymentPlace,
      sourceDepthRatio: null,
      sourceSwitchCount30d: row.sourceSwitch ? 1 : 0,
      observationCount30d: row.yieldHistoryDays,
      freshness: row.yieldFreshness,
      isPrimary: true,
    },
  ];
}

export function selectYieldSource(row: MergedRow, input: SelectorInput): RecommendedSource | null {
  const candidates = row.yieldSources?.length ? [...row.yieldSources] : fallbackYieldSources(row);
  if (candidates.length === 0) {
    return null;
  }
  const scoredCandidates = candidates.map((candidate) =>
    scoreYieldSourceCandidate(candidate, input, row.benchmarkRate),
  );
  scoredCandidates.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 0.0001) return scoreDiff;
    const riskDiff = b.risk - a.risk;
    if (riskDiff !== 0) return riskDiff;
    const depthDiff = b.depth - a.depth;
    if (Math.abs(depthDiff) > 0.0001) return depthDiff;
    const freshDiff = b.freshness - a.freshness;
    if (Math.abs(freshDiff) > 0.0001) return freshDiff;
    return a.candidate.sourceKey.localeCompare(b.candidate.sourceKey);
  });
  const selected = scoredCandidates[0]!.candidate;
  if (selected.chain == null) return null;
  return {
    sourceKey: selected.sourceKey,
    protocol: selected.protocol,
    chain: selected.chain,
    yieldType: selected.yieldType,
    apy30d: selected.apy30d,
    pharosYieldScore: selected.pharosYieldScore,
    sourceTvlUsd: selected.sourceTvlUsd,
    sourceRiskTier: selected.venueRiskTier ?? "mid",
    freshness: selected.freshness ?? { capturedAt: 0, ageSeconds: 0 },
    selectionReason: venueMatchesPreference(selected, input)
      ? "venue-preference"
      : "risk-depth-freshness",
  };
}
