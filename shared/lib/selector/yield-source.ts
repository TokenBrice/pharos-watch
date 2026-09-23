import { sourceRiskInverted } from "./normalization";
import { clamp } from "../math";
import type {
  MergedRow,
  RecommendedSource,
  SelectorInput,
  YieldSourceCandidate,
} from "./types";

/** A rail the yield domain resolved to a venue chain, i.e. one it can name. */
type ResolvedYieldSourceCandidate = YieldSourceCandidate & { chain: string };

interface RankedYieldSourceCandidate {
  candidate: ResolvedYieldSourceCandidate;
  /** 1 when the candidate satisfies the user's venue answer, 0 otherwise. */
  venueMatch: number;
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

/**
 * Published rail-depth bands, and the depth score each one contributes to the
 * comparator.
 *
 * `sourceDepthRatio` is a venue's share of tracked stablecoin supply, not a
 * normalized score: the published depth lens already calls `>= 1%` "deep", so
 * real readings live in `1e-4`..`5e-2`. Scaling that fraction to 0-100 scored
 * the deepest possible rail at `<= 10`. The bands carry their own score
 * instead. `src/lib/yield-source-risk.ts` classifies the same lens from these
 * thresholds rather than re-typing them.
 */
export const YIELD_SOURCE_DEPTH_BANDS = {
  deep: { minRatio: 0.01, score: 100 },
  moderate: { minRatio: 0.001, score: 70 },
  thin: { minRatio: 0, score: 40 },
} as const;

/**
 * A rail nothing sized ranks below every measured band. An unmeasured venue is
 * not a shallow one, and the neutral score this replaced let an evidence-free
 * rail win the depth key against the deepest measured one.
 */
const UNMEASURED_DEPTH_SCORE = 0;

function sourceDepthScore(candidate: YieldSourceCandidate): number {
  const ratio = candidate.sourceDepthRatio;
  if (ratio != null && Number.isFinite(ratio) && ratio >= 0) {
    if (ratio >= YIELD_SOURCE_DEPTH_BANDS.deep.minRatio) return YIELD_SOURCE_DEPTH_BANDS.deep.score;
    if (ratio >= YIELD_SOURCE_DEPTH_BANDS.moderate.minRatio) return YIELD_SOURCE_DEPTH_BANDS.moderate.score;
    return YIELD_SOURCE_DEPTH_BANDS.thin.score;
  }
  if (candidate.sourceTvlUsd == null || candidate.sourceTvlUsd <= 0) return UNMEASURED_DEPTH_SCORE;
  return clamp((Math.log10(candidate.sourceTvlUsd) / Math.log10(500_000_000)) * 100, 0, 100);
}

function sourceFreshnessScore(candidate: YieldSourceCandidate): number {
  const age = candidate.freshness?.ageSeconds;
  if (age == null) return 50;
  // Fail closed on an age the freshness contract cannot produce, exactly where
  // `clamp` already sends NaN: a non-finite or future-dated capture must never
  // outrank a genuinely fresh reading. Ages are floored at zero by
  // `data-adapter.ts` and `validateSelectorSnapshot` requires a nonnegative
  // finite `ageSeconds`, so no storable snapshot's ordering changes here and
  // the engine version stays put.
  if (!Number.isFinite(age) || age < 0) return 0;
  return clamp(100 - (age / 172_800) * 100, 0, 100);
}

/**
 * Rank one candidate rail against the user's venue answer and the yield
 * domain's published readings.
 *
 * `selector-v2.0` deleted the weighted venue formula that used to sit here
 * (venue 0.35 / risk 0.25 / depth 0.20 / freshness 0.15 / excess APY 0.05). It
 * was a second yield model: it re-priced APY that the Pharos Yield Score
 * already prices, and it blended the published `sourceRiskScore` into a number
 * only the Selector understood. Selection is now a lexicographic ordering over
 * the user's preference and the published readings, so every field that
 * decides a rail is one a reader can look up.
 */
function rankYieldSourceCandidate(
  candidate: ResolvedYieldSourceCandidate,
  input: SelectorInput,
): RankedYieldSourceCandidate {
  return {
    candidate,
    venueMatch: venueMatchesPreference(candidate, input) ? 1 : 0,
    risk:
      candidate.sourceRiskScore != null
        ? sourceRiskInverted(candidate.sourceRiskScore)
        : riskTierScore(candidate.venueRiskTier),
    depth: sourceDepthScore(candidate),
    freshness: sourceFreshnessScore(candidate),
  };
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
      observationCount30d: row.yieldObservationDays30d,
      freshness: row.yieldFreshness,
      isPrimary: true,
    },
  ];
}

/**
 * The winning rail plus the engine-internal maturity reading the confidence
 * rule needs. `observationDays30d` is deliberately not part of the published
 * `RecommendedSource` contract: selection is the single place that knows
 * which rail's observation history the engine's `< 21` day rule must judge.
 */
export interface SelectedYieldSourceRail {
  source: RecommendedSource;
  /** Distinct UTC observation days behind the winning rail; null when it published none. */
  observationDays30d: number | null;
}

export function selectYieldSource(row: MergedRow, input: SelectorInput): RecommendedSource | null {
  return selectYieldSourceRail(row, input)?.source ?? null;
}

export function selectYieldSourceRail(row: MergedRow, input: SelectorInput): SelectedYieldSourceRail | null {
  const pool = row.yieldSources?.length ? row.yieldSources : fallbackYieldSources(row);
  // A rail whose venue chain the yield domain never resolved cannot be rendered
  // as a destination, but it is one rail — not the coin's whole yield coverage.
  // Filtering before the ranking keeps every resolvable sibling in play instead
  // of discarding the coin under `missingSignals: ["recommendedSource"]`.
  const candidates = pool.filter(
    (candidate): candidate is ResolvedYieldSourceCandidate => candidate.chain != null,
  );
  if (candidates.length === 0) {
    return null;
  }
  const rankedCandidates = candidates.map((candidate) => rankYieldSourceCandidate(candidate, input));
  rankedCandidates.sort((a, b) => {
    const venueDiff = b.venueMatch - a.venueMatch;
    if (venueDiff !== 0) return venueDiff;
    const riskDiff = b.risk - a.risk;
    if (Math.abs(riskDiff) > 0.0001) return riskDiff;
    const depthDiff = b.depth - a.depth;
    if (Math.abs(depthDiff) > 0.0001) return depthDiff;
    const freshDiff = b.freshness - a.freshness;
    if (Math.abs(freshDiff) > 0.0001) return freshDiff;
    return a.candidate.sourceKey.localeCompare(b.candidate.sourceKey);
  });
  const selected = rankedCandidates[0]!.candidate;
  return {
    source: {
      sourceKey: selected.sourceKey,
      protocol: selected.protocol,
      chain: selected.chain,
      yieldType: selected.yieldType,
      apy30d: selected.apy30d,
      pharosYieldScore: selected.pharosYieldScore,
      sourceTvlUsd: selected.sourceTvlUsd,
      // Unknown stays unknown, here as for `freshness`: an unsourced venue tier
      // published as `"mid"` is a measurement the registry never made.
      // `riskTierScore` keeps its neutral 55 for ordering.
      sourceRiskTier: selected.venueRiskTier,
      // Unknown stays unknown: `sourceFreshnessScore` ranks a missing reading as
      // neutral 50, and rendering `{ 0, 0 }` would print "0s old" for the same row.
      freshness: selected.freshness,
      selectionReason: venueMatchesPreference(selected, input)
        ? "venue-preference"
        : "risk-depth-freshness",
    },
    observationDays30d: selected.observationCount30d,
  };
}
