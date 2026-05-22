/**
 * `runSelector(input, data, dataset)` — pure synchronous pipeline.
 *
 * Binding: see `docs/screener-picker-page.md` for the maintained engine contract.
 * The engine reads no clocks and no randomness; `dataset.timestamp` is the
 * single time input, threaded by the caller.
 */
import type { BluechipGrade, ReportCardGrade } from "../../types";
import {
  evaluateExclusions,
  hasRequiredSignals,
  HOWEY_UNCERTAIN_ASSETS,
} from "./exclusions";
import { selectLowerRanked } from "./lower-ranked";
import { selectLowestSubDimension } from "./lowest-sub-dimension";
import {
  bluechip,
  excessApyConcave,
  hhiToDiversity,
  identity,
  invert100,
  pegYieldScore,
  sourceRiskInverted,
  supplyLog,
  yieldVariance,
} from "./normalization";
import type {
  ContextKey,
  DatasetMetadata,
  ExclusionRecord,
  ExclusionReason,
  MergedRow,
  RecommendedSource,
  SelectorClosestSurvivor,
  SelectorChainHints,
  SelectorComponent,
  SelectorConfidenceReason,
  SelectorData,
  SelectorExclusionSummaryItem,
  SelectorInput,
  SelectorOutput,
  SelectorProfile,
  SelectorRankRobustness,
  SelectorRecommendation,
  SelectorRelaxableConstraint,
  SkippedCoin,
  WeightKey,
  WhyKey,
  YieldSourceCandidate,
  YieldRecommendation,
} from "./types";
import { SELECTOR_VERSION } from "./version";
import { getWeightVectorForInput } from "./weights";
import { renderWatchText } from "./what-to-watch-templates";
import { whyKeysByProfile, WHY_KEYS_SET } from "./why-keys";

export const ENGINE_VERSION = SELECTOR_VERSION;

const RELAXED_FALLBACK_BLOCKED_REASONS: ReadonlySet<ExclusionReason> = new Set([
  "active-depeg",
  "apy-below-floor",
  "below-supply-floor",
  "coverage-too-thin",
  "howey-uncertain",
  "lifecycle-non-active",
  "peg-currency-mismatch",
  "pys-null",
  "safety-grade-floor",
  "template-coverage-gap",
  "yield-native-only-violation",
]);

// ---------------------------------------------------------------------------
// Component computation
// ---------------------------------------------------------------------------

function rawValueFor(
  key: WeightKey,
  row: MergedRow,
  input: SelectorInput,
): number | null {
  switch (key) {
    case "safetyOverall":
      return row.safetyScore;
    case "resilience":
      return row.safetyResilienceScore;
    case "dependencyRisk":
      return row.safetyDependencyRiskScore;
    case "pegStabilityHistory":
    case "pegStabilityLive":
      return row.pegStabilityScore;
    case "pegScoreNow":
      return row.pegScore;
    case "decentralization":
      return row.safetyDecentralizationScore;
    case "dewsInverted":
      return row.dewsScore;
    case "bluechip":
      return row.bluechipGrade != null ? bluechip(row.bluechipGrade) : null;
    case "supplyLog":
      return row.supplyUsd;
    case "pharosYieldScore":
      return row.pharosYieldScore;
    case "excessApy":
      if (row.apy30d == null || row.benchmarkRate == null) return null;
      return row.apy30d - row.benchmarkRate;
    case "yieldVariance":
      return row.apyVariance30d;
    case "liquidity":
      return row.liquidityScore;
    case "sourceRiskInverted":
      return row.sourceRiskScore;
    case "effectiveExit":
      return row.effectiveExitScore;
    case "liquidityDiversification":
      return row.concentrationHhi;
  }
  // Exhaustiveness guard.
  void input;
  return null;
}

function normalizeFor(
  key: WeightKey,
  raw: number | null,
): number | null {
  switch (key) {
    case "safetyOverall":
    case "resilience":
    case "dependencyRisk":
    case "pegStabilityHistory":
    case "pegStabilityLive":
    case "pegScoreNow":
    case "decentralization":
    case "liquidity":
    case "effectiveExit":
      return identity(raw);
    case "dewsInverted":
      return invert100(raw);
    case "bluechip":
      return raw; // raw was already the ladder lookup
    case "supplyLog":
      return supplyLog(raw);
    case "pharosYieldScore":
      return pegYieldScore(raw);
    case "excessApy":
      return excessApyConcave(raw);
    case "yieldVariance":
      return yieldVariance(raw);
    case "sourceRiskInverted":
      // sourceRiskInverted normalizes null to neutral 50, but for confidence
      // accounting we want to know the raw was null. Engine handles that by
      // reading rawValueFor before applying normalization.
      return raw == null ? 50 : sourceRiskInverted(raw);
    case "liquidityDiversification":
      return hhiToDiversity(raw);
  }
}

interface NormalizedSlot {
  key: WeightKey;
  rawValue: number | null;
  normalizedValue: number | null;
  /** Profile-allocated weight before redistribution. */
  baseWeight: number;
}

function normalizeRow(
  row: MergedRow,
  profile: SelectorProfile,
  input: SelectorInput,
): NormalizedSlot[] {
  const vector = getWeightVectorForInput(input);
  const slots: NormalizedSlot[] = [];
  for (const [k, w] of Object.entries(vector)) {
    if (typeof w !== "number") continue;
    if (w === 0) continue; // suppress zero-weight slots (Treasury supplyLog)
    if (k === "__profile") continue;
    const key = k as WeightKey;
    const raw = rawValueFor(key, row, input);
    const normalized = normalizeFor(key, raw);
    slots.push({ key, rawValue: raw, normalizedValue: normalized, baseWeight: w });
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Missing-data policy
// ---------------------------------------------------------------------------

type MissingPolicy = "penalty" | "ignore";

const CRITICAL_SIGNALS_BY_PROFILE: Readonly<Record<SelectorProfile, readonly WeightKey[]>> = {
  treasury: [
    "safetyOverall",
    "resilience",
    "dependencyRisk",
    "pegStabilityHistory",
    "dewsInverted",
  ],
  yield: [
    "pharosYieldScore",
    "yieldVariance",
    "safetyOverall",
    "sourceRiskInverted",
    "pegStabilityLive",
    "liquidity",
  ],
  trading: ["liquidity", "pegScoreNow", "dewsInverted", "effectiveExit"],
};

function missingPolicy(
  key: WeightKey,
  profile: SelectorProfile,
): MissingPolicy {
  // Treasury policy
  if (profile === "treasury") {
    if (key === "decentralization") return "penalty";
    if (key === "bluechip") return "penalty";
    if (key === "pegScoreNow") return "penalty";
    return "penalty";
  }
  // Yield policy
  if (profile === "yield") {
    // R2: variance + source-risk are Penalty, not Ignore
    if (key === "yieldVariance") return "penalty";
    if (key === "sourceRiskInverted") return "penalty";
    if (key === "bluechip") return "ignore";
    if (key === "excessApy") return "penalty";
    return "penalty";
  }
  // Trading policy
  if (key === "bluechip") return "ignore";
  if (key === "effectiveExit") return "penalty";
  if (key === "liquidityDiversification") return "penalty";
  return "penalty";
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface ScoredEntry {
  row: MergedRow;
  score: number;
  components: SelectorComponent[];
  confidence: number;
  confidenceReasons: SelectorConfidenceReason[];
  redistributedSlots: number;
  recommendedSource: RecommendedSource | null;
  perInputStaleness: Record<string, number> | null;
  relaxedReason: ExclusionReason | null;
  concentrationAdjusted?: boolean;
}

function scoreRow(
  row: MergedRow,
  profile: SelectorProfile,
  input: SelectorInput,
): {
  score: number;
  components: SelectorComponent[];
  confidence: number;
  confidenceReasons: SelectorConfidenceReason[];
  redistributedSlots: number;
  /** True when every signal was null (degenerate row). */
  degenerate: boolean;
} | null {
  const slots = normalizeRow(row, profile, input);

  let redistributedSlots = 0;
  let scoreCap = 100;
  const confidenceReasons = new Set<SelectorConfidenceReason>();
  const present: NormalizedSlot[] = [];
  const neutralMissing = new Set<NormalizedSlot>();
  const criticalSignals = CRITICAL_SIGNALS_BY_PROFILE[profile];
  for (const slot of slots) {
    if (slot.rawValue != null && slot.normalizedValue != null) {
      present.push(slot);
      continue;
    }
    const policy = missingPolicy(slot.key, profile);
    if (policy === "penalty") {
      redistributedSlots += 1;
    }
    if (criticalSignals.includes(slot.key)) {
      confidenceReasons.add(`missing-critical-${slot.key}`);
      scoreCap = Math.min(scoreCap, 78);
    }
    // Source-risk null is a deliberately neutral score input for Yield, but
    // still counts as missing for confidence and redistribution warnings.
    if (slot.key === "sourceRiskInverted" && slot.normalizedValue != null) {
      present.push(slot);
      neutralMissing.add(slot);
      confidenceReasons.add("source-risk-missing");
    }
  }

  if (present.length === 0) {
    return null;
  }

  // Pro-rata redistribute across present slots.
  const totalBase = present.reduce((acc, s) => acc + s.baseWeight, 0);
  if (totalBase === 0) {
    return {
      score: 0,
      components: [],
      confidence: 0,
      confidenceReasons: ["redistributed-missing-data"],
      redistributedSlots,
      degenerate: true,
    };
  }

  const components: SelectorComponent[] = [];
  let score = 0;
  for (const slot of present) {
    const weight = (slot.baseWeight / totalBase) * 100;
    const contribution = (weight * (slot.normalizedValue ?? 0)) / 100;
    components.push({
      key: slot.key,
      weight,
      rawValue: slot.rawValue,
      normalizedValue: slot.normalizedValue,
      contribution,
      redistributed: neutralMissing.has(slot),
    });
    score += contribution;
  }

  // Also emit redistributed slots (the ones we dropped) so consumers see the
  // full original vector and can render "we couldn't read X" affordances.
  for (const slot of slots) {
    if (present.includes(slot)) continue;
    components.push({
      key: slot.key,
      weight: 0,
      rawValue: slot.rawValue,
      normalizedValue: slot.normalizedValue,
      contribution: 0,
      redistributed: missingPolicy(slot.key, profile) === "penalty",
    });
  }

  let confidence = 100 - 5 * redistributedSlots;
  if (redistributedSlots > 0) {
    confidenceReasons.add("redistributed-missing-data");
  }
  if (row.isRecentListing) {
    confidence -= 10;
    confidenceReasons.add("recent-listing");
  }
  if (profile === "treasury" && row.depegEventCount >= 2) {
    confidence -= Math.min(12, row.depegEventCount * 3);
  }
  if (profile === "yield" && row.sourceSwitch) {
    confidence -= 8;
    confidenceReasons.add("yield-source-switched");
  }
  for (const reason of confidenceReasons) {
    if (String(reason).startsWith("missing-critical-")) confidence -= 8;
  }
  confidence = clamp(confidence, 0, 100);
  if (profile === "yield" && row.yieldHistoryDays < 60) {
    confidence = Math.min(confidence, 80);
    confidenceReasons.add("short-yield-history");
  }
  score = Math.min(score, scoreCap);

  return {
    score,
    components,
    confidence,
    confidenceReasons: Array.from(confidenceReasons).sort(),
    redistributedSlots,
    degenerate: false,
  };
}

/**
 * Score a row as if its exclusion had not fired. Used by lower-ranked Slot A
 * to surface high-quality near-misses.
 *
 * @internal Exported for `lower-ranked.ts`.
 */
export function scoreIgnoringExclusion(
  row: MergedRow,
  input: SelectorInput,
): number | null {
  const result = scoreRow(row, input.profile, input);
  return result ? result.score : null;
}

// ---------------------------------------------------------------------------
// Why-keys, chain hints, recommended-source
// ---------------------------------------------------------------------------

function pickWhyKeys(
  row: MergedRow,
  profile: SelectorProfile,
  input: SelectorInput,
): WhyKey[] {
  const candidates = whyKeysByProfile[profile];
  const triggered: WhyKey[] = [];
  for (const key of candidates) {
    if (triggered.length >= 4) break;
    if (whyKeyTriggers(key, row, input)) triggered.push(key);
  }
  // Dev-only sanity check (silent in prod). Engine never emits an unknown key.
  for (const key of triggered) {
    if (!WHY_KEYS_SET.has(key)) {
      // Unreachable when the vocabulary stays in sync; defensive guard only.
      throw new Error(`[selector/engine] unknown whyKey emitted: ${key}`);
    }
  }
  return triggered;
}

function whyKeyTriggers(
  key: WhyKey,
  row: MergedRow,
  input: SelectorInput,
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
        row.pegStabilityScore != null &&
        row.pegStabilityScore >= 80
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
    case "low-dependency-risk":
      return (
        row.safetyDependencyRiskScore != null &&
        row.safetyDependencyRiskScore >= 80
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
      void input;
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

function yieldSourceScore(candidate: YieldSourceCandidate, input: SelectorInput): number {
  const venue = venueMatchesPreference(candidate, input) ? 100 : 35;
  const risk =
    candidate.sourceRiskScore != null
      ? sourceRiskInverted(candidate.sourceRiskScore) ?? riskTierScore(candidate.venueRiskTier)
      : riskTierScore(candidate.venueRiskTier);
  const depth = sourceDepthScore(candidate);
  const freshness = sourceFreshnessScore(candidate);
  const apy = excessApyConcave(candidate.apy30d - 4) ?? 0;
  return venue * 0.35 + risk * 0.25 + depth * 0.2 + freshness * 0.15 + apy * 0.05;
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

function selectYieldSource(row: MergedRow, input: SelectorInput): RecommendedSource | null {
  const candidates = row.yieldSources?.length ? [...row.yieldSources] : fallbackYieldSources(row);
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => {
    const scoreDiff = yieldSourceScore(b, input) - yieldSourceScore(a, input);
    if (Math.abs(scoreDiff) > 0.0001) return scoreDiff;
    const riskDiff = riskTierScore(b.venueRiskTier) - riskTierScore(a.venueRiskTier);
    if (riskDiff !== 0) return riskDiff;
    const depthDiff = sourceDepthScore(b) - sourceDepthScore(a);
    if (Math.abs(depthDiff) > 0.0001) return depthDiff;
    const freshDiff = sourceFreshnessScore(b) - sourceFreshnessScore(a);
    if (Math.abs(freshDiff) > 0.0001) return freshDiff;
    return a.sourceKey.localeCompare(b.sourceKey);
  });
  const selected = candidates[0]!;
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

// ---------------------------------------------------------------------------
// Variant dedup
// ---------------------------------------------------------------------------

function dedupVariants(
  entries: ScoredEntry[],
  profile: SelectorProfile,
): ScoredEntry[] {
  const seen = new Map<string, ScoredEntry>();
  const out: ScoredEntry[] = [];
  for (const entry of entries) {
    if (entry.row.variantOf == null) {
      out.push(entry);
      continue;
    }
    // Yield dedup keyed by (variantOf, isYieldBearing); else by variantOf.
    const key =
      profile === "yield"
        ? `${entry.row.variantOf}::${entry.row.isYieldBearing ? "y" : "n"}`
        : entry.row.variantOf;
    const existing = seen.get(key);
    if (!existing || entry.score > existing.score) {
      seen.set(key, entry);
    }
  }
  // Build output preserving sort order; drop duplicates not kept.
  const kept = new Set(Array.from(seen.values()));
  for (const entry of entries) {
    if (entry.row.variantOf == null) continue;
    if (kept.has(entry)) out.push(entry);
  }
  // Re-sort by score desc to preserve rank.
  return out.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Ranking + tie-breakers
// ---------------------------------------------------------------------------

const GRADE_RANK: Record<ReportCardGrade, number> = {
  "A+": 0,
  "A": 1,
  "A-": 2,
  "B+": 3,
  "B": 4,
  "B-": 5,
  "C+": 6,
  "C": 7,
  "C-": 8,
  "D": 9,
  "F": 10,
  "NR": 11,
};

function compareScored(a: ScoredEntry, b: ScoredEntry): number {
  const diff = b.score - a.score;
  if (Math.abs(diff) > 1.5) return diff;
  // Tie-break window
  if (b.row.supplyUsd !== a.row.supplyUsd) {
    return b.row.supplyUsd - a.row.supplyUsd;
  }
  const aGrade = a.row.safetyGrade != null ? GRADE_RANK[a.row.safetyGrade] : 99;
  const bGrade = b.row.safetyGrade != null ? GRADE_RANK[b.row.safetyGrade] : 99;
  if (aGrade !== bGrade) return aGrade - bGrade;
  const aLiq = a.row.liquidityScore ?? -1;
  const bLiq = b.row.liquidityScore ?? -1;
  if (aLiq !== bLiq) return bLiq - aLiq;
  return a.row.id.localeCompare(b.row.id);
}

const CONCENTRATION_SUBSTITUTE_WINDOW = 3;

function applyConcentrationSafeguard(entries: ScoredEntry[]): ScoredEntry[] {
  const remaining = [...entries];
  const selected: ScoredEntry[] = [];
  while (selected.length < 3 && remaining.length > 0) {
    const primary = remaining[0]!;
    const primaryProtocol = primary.row.protocolSlug;
    const conflicts =
      primaryProtocol != null &&
      selected.some((entry) => entry.row.protocolSlug === primaryProtocol);
    if (conflicts) {
      const substituteIndex = remaining.findIndex((candidate) => {
        if (candidate.row.protocolSlug == null) return false;
        if (candidate.row.protocolSlug === primaryProtocol) return false;
        return primary.score - candidate.score <= CONCENTRATION_SUBSTITUTE_WINDOW;
      });
      if (substituteIndex > 0) {
        const [substitute] = remaining.splice(substituteIndex, 1);
        substitute!.concentrationAdjusted = true;
        selected.push(substitute!);
        continue;
      }
    }
    selected.push(remaining.shift()!);
  }
  return [...selected, ...remaining];
}

function toScoredEntry(
  row: MergedRow,
  input: SelectorInput,
): ScoredEntry | null {
  const result = scoreRow(row, input.profile, input);
  if (result == null || result.degenerate) return null;
  const recommendedSource = input.profile === "yield" ? selectYieldSource(row, input) : null;
  if (input.profile === "yield" && recommendedSource == null) return null;
  return {
    row,
    score: result.score,
    components: result.components,
    confidence: result.confidence,
    confidenceReasons: result.confidenceReasons,
    redistributedSlots: result.redistributedSlots,
    recommendedSource,
    perInputStaleness:
      input.profile === "trading"
        ? tradingPerInputStaleness(row)
        : null,
    relaxedReason: null,
  };
}

function tradingPerInputStaleness(row: MergedRow): Record<string, number> {
  const ages: Record<string, number> = {};
  if (row.pegSummaryAgeSec != null) ages.pegSummary = row.pegSummaryAgeSec;
  if (row.dexTvlAgeSec != null) ages.dexTvl = row.dexTvlAgeSec;
  if (row.dewsAgeSec != null) ages.dews = row.dewsAgeSec;
  return ages;
}

function relaxedFallbackReason(
  row: MergedRow,
  input: SelectorInput,
): ExclusionReason | null {
  const coverage = hasRequiredSignals(row, input.profile);
  if (!coverage.ok) return null;
  const exclusion = evaluateExclusions(row, input);
  if (exclusion == null) return null;
  if (RELAXED_FALLBACK_BLOCKED_REASONS.has(exclusion.reason)) return null;
  if (
    input.profile === "treasury" &&
    exclusion.reason === "peg-score-floor"
  ) {
    return null;
  }
  return exclusion.reason;
}

function buildRelaxedFallbackEntries(
  universe: readonly MergedRow[],
  input: SelectorInput,
  excludedIds: ReadonlySet<string>,
): ScoredEntry[] {
  const scored: ScoredEntry[] = [];
  for (const row of universe) {
    if (excludedIds.has(row.id)) continue;
    const reason = relaxedFallbackReason(row, input);
    if (reason == null) continue;
    const entry = toScoredEntry(row, input);
    if (entry != null) {
      scored.push({
        ...entry,
        confidence: Math.min(entry.confidence, 60),
        confidenceReasons: Array.from(
          new Set<SelectorConfidenceReason>([...entry.confidenceReasons, "relaxed-fallback"]),
        ).sort(),
        relaxedReason: reason,
      });
    }
  }
  const deduped = dedupVariants(scored, input.profile);
  deduped.sort(compareScored);
  return applyConcentrationSafeguard(deduped);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

const COMPONENT_LABELS: Readonly<Record<WeightKey, string>> = {
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

function buildWhyText(entry: ScoredEntry, profile: SelectorProfile): string {
  const anchors = entry.components
    .filter((component) => component.normalizedValue != null && component.weight > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 2)
    .map((component) => `${COMPONENT_LABELS[component.key]} ${Math.round(component.normalizedValue ?? 0)}`);
  if (anchors.length === 0) {
    return `Score ${round1(entry.score)} under the ${profile} weight set; live coverage is limited.`;
  }
  return `Score ${round1(entry.score)} is driven by ${anchors.join(" and ")} under the ${profile} weights.`;
}

function rankRobustnessFor(
  entries: readonly ScoredEntry[],
  index: number,
): SelectorRankRobustness {
  const entry = entries[index];
  const next = entries[index + 1];
  if (entry?.concentrationAdjusted) {
    return { label: "concentration-adjusted", scoreMargin: next ? round1(Math.max(0, entry.score - next.score)) : null };
  }
  if (!entry || !next) return { label: "clear-margin", scoreMargin: null };
  const margin = round1(Math.max(0, entry.score - next.score));
  if (margin < 1.5) return { label: "narrow-margin", scoreMargin: margin };
  if (margin < 3) return { label: "crowded-field", scoreMargin: margin };
  return { label: "clear-margin", scoreMargin: margin };
}

// ---------------------------------------------------------------------------
// Recommendation factory (variant-discriminated)
// ---------------------------------------------------------------------------

function buildRecommendation(
  entry: ScoredEntry,
  rank: 1 | 2 | 3,
  profile: SelectorProfile,
  input: SelectorInput,
  contextKeysFor: (row: MergedRow) => ContextKey[],
  rankRobustness?: SelectorRankRobustness,
): SelectorRecommendation | null {
  const lowest = selectLowestSubDimension(entry.row, profile, entry.components);
  if (lowest == null) {
    return null;
  }
  const safetyGrade: ReportCardGrade = entry.row.safetyGrade ?? "NR";
  const contextKeys = Array.from(new Set([...lowest.contextKeys, ...contextKeysFor(entry.row)]));
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
    whyKeys: pickWhyKeys(entry.row, profile, input),
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

// ---------------------------------------------------------------------------
// mergeRow
// ---------------------------------------------------------------------------

/**
 * Look up a merged row from the data bag. Exported so tests and the
 * template-coverage gate can call it directly.
 *
 * @internal
 */
export function mergeRow(id: string, data: SelectorData): MergedRow | null {
  return data.rows.get(id) ?? null;
}

function buildExclusionSummary(excluded: readonly ExclusionRecord[]): SelectorExclusionSummaryItem[] {
  const grouped = new Map<ExclusionReason, SelectorExclusionSummaryItem>();
  for (const record of excluded) {
    const existing = grouped.get(record.reason);
    if (existing) {
      existing.count += 1;
      if (existing.sampleIds.length < 3) existing.sampleIds.push(record.id);
      if (record.severity === "hard") existing.severity = "hard";
      else if (record.severity === "soft" && existing.severity === "info") existing.severity = "soft";
      continue;
    }
    grouped.set(record.reason, {
      reason: record.reason,
      count: 1,
      severity: record.severity,
      sampleIds: [record.id],
    });
  }
  return Array.from(grouped.values()).sort((a, b) =>
    b.count !== a.count ? b.count - a.count : a.reason.localeCompare(b.reason),
  );
}

function liveReadingFor(reason: ExclusionReason, row: MergedRow): string {
  switch (reason) {
    case "active-depeg":
      return row.currentDeviationBps != null
        ? `${Math.round(row.currentDeviationBps)} bps deviation`
        : "active depeg flag";
    case "depeg-event-count":
      return `${row.depegEventCount} depeg events`;
    case "peg-score-floor":
      return row.pegScore != null
        ? `PegScore ${Math.round(row.pegScore)}`
        : "missing PegScore";
    case "peg-stability-floor":
      if (row.pegStabilityScore != null && row.pegScore != null) {
        return `peg history ${Math.round(row.pegStabilityScore)}, PegScore ${Math.round(row.pegScore)}`;
      }
      if (row.pegStabilityScore != null) {
        return `peg history ${Math.round(row.pegStabilityScore)}`;
      }
      if (row.pegScore != null) {
        return `PegScore ${Math.round(row.pegScore)}`;
      }
      return "missing peg-quality data";
    case "dews-ceiling":
      return row.dewsScore != null ? `DEWS ${Math.round(row.dewsScore)}` : "missing DEWS";
    case "safety-resilience-floor":
      return row.safetyResilienceScore != null
        ? `resilience ${Math.round(row.safetyResilienceScore)}`
        : "missing resilience";
    case "safety-dependency-risk-floor":
      return row.safetyDependencyRiskScore != null
        ? `dependency risk ${Math.round(row.safetyDependencyRiskScore)}`
        : "missing dependency risk";
    case "liquidity-floor":
      return row.liquidityScore != null
        ? `liquidity ${Math.round(row.liquidityScore)}`
        : "missing liquidity";
    case "effective-exit-floor":
      return row.effectiveExitScore != null
        ? `effective exit ${Math.round(row.effectiveExitScore)}`
        : "missing exit score";
    case "high-venue-on-c-tier":
      return row.venueRiskTier != null ? `venue risk ${row.venueRiskTier}` : "venue risk gap";
    case "yield-warning-unstable":
    case "yield-warning-thin-tvl":
      return row.warningSignals.length > 0 ? row.warningSignals.join(", ") : "yield warning";
    case "custody-regulated-only-violation":
      return row.custodyModel != null
        ? `custody model ${row.custodyModel}`
        : "custody model unavailable";
    case "custody-onchain-only-violation":
      return row.custodyModel != null
        ? `custody model ${row.custodyModel}`
        : "custody model unavailable";
    case "coverage-too-thin":
      return "required signals missing";
    default:
      return "profile gate missed";
  }
}

function buildClosestSurvivors(
  excluded: readonly ExclusionRecord[],
  universe: readonly MergedRow[],
  input: SelectorInput,
): SelectorClosestSurvivor[] {
  const rowsById = new Map(universe.map((row) => [row.id, row] as const));
  const candidates: Array<SelectorClosestSurvivor & { sortScore: number }> = [];
  for (const record of excluded) {
    if (record.reason === "howey-uncertain" || record.reason === "lifecycle-non-active") continue;
    const row = rowsById.get(record.id);
    if (!row) continue;
    const hypotheticalScore = scoreIgnoringExclusion(row, input);
    candidates.push({
      id: row.id,
      symbol: row.symbol,
      failingDimension: record.reason,
      liveReading: liveReadingFor(record.reason, row),
      reason: record.reason,
      hypotheticalScore: hypotheticalScore == null ? null : round1(hypotheticalScore),
      sortScore: hypotheticalScore ?? -1,
    });
  }
  return candidates
    .sort((a, b) => b.sortScore - a.sortScore || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map(({ sortScore: _sortScore, ...candidate }) => candidate);
}

function hasExcludedReason(
  excluded: readonly ExclusionRecord[],
  reasons: readonly ExclusionReason[],
): ExclusionReason | null {
  for (const reason of reasons) {
    if (excluded.some((record) => record.reason === reason)) return reason;
  }
  return null;
}

function buildRelaxableConstraints(
  input: SelectorInput,
  excluded: readonly ExclusionRecord[],
): SelectorRelaxableConstraint[] {
  const out: SelectorRelaxableConstraint[] = [];
  const depegReason = hasExcludedReason(excluded, [
    "active-depeg",
    "peg-score-floor",
  ]);
  if (input.depegTolerance === "zero" || input.depegTolerance === "tight" || depegReason) {
    out.push({
      key: "depegTolerance",
      label: "Relax depeg tolerance",
      description: input.depegTolerance === "zero" ? "Zero to tight" : "Tight to moderate",
      reason: depegReason ?? "input-strictness",
    });
  }

  const venueReason = hasExcludedReason(excluded, [
    "high-venue-on-c-tier",
    "yield-warning-thin-tvl",
    "liquidity-diversification-floor",
  ]);
  const venueScoped = input.composability !== "high" || !(input.venuePreferences?.includes("all" as never) ?? false);
  if (input.profile !== "treasury" && (venueScoped || venueReason)) {
    out.push({
      key: "venue",
      label: "Open venue scope",
      description: "Specific rail to all rails",
      reason: venueReason ?? "input-strictness",
    });
  }

  const exitReason = hasExcludedReason(excluded, [
    "effective-exit-floor",
    "supply-tvl-floor-1h",
    "liquidity-floor",
  ]);
  if (input.exitSpeed !== "any" || exitReason) {
    out.push({
      key: "exitSpeed",
      label: "Loosen exit speed",
      description: "Tighter exit to any",
      reason: exitReason ?? "input-strictness",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// runSelector
// ---------------------------------------------------------------------------

const SELECTOR_DEBUG =
  typeof process !== "undefined" && process.env?.SELECTOR_DEBUG === "true";

export function runSelector(
  input: SelectorInput,
  data: SelectorData,
  dataset: DatasetMetadata,
): SelectorOutput {
  // 1+2. Universe (selected peg + Howey pre-exclusion)
  const universe: MergedRow[] = [];
  for (const row of data.rows.values()) {
    if (row.pegCurrency !== input.pegCurrency) continue;
    if (HOWEY_UNCERTAIN_ASSETS.has(row.id)) continue;
    universe.push(row);
  }

  // 3. Merge (already done — `MergedRow` is what we iterate)

  // 4. Layer 1 — hard exclusions + coverage-too-thin
  const excluded: ExclusionRecord[] = [];
  const skippedForCoverage: SkippedCoin[] = [];
  const survivors: MergedRow[] = [];
  for (const row of universe) {
    const exclusion = evaluateExclusions(row, input);
    if (exclusion) {
      excluded.push(exclusion);
      continue;
    }
    const coverage = hasRequiredSignals(row, input.profile);
    if (!coverage.ok) {
      excluded.push({ id: row.id, reason: "coverage-too-thin", severity: "info" });
      skippedForCoverage.push({
        id: row.id,
        symbol: row.symbol,
        missingSignals: coverage.missing,
      });
      continue;
    }
    survivors.push(row);
  }

  const universeLen = universe.length;

  // 6. Layer 2 — scoring
  let scored: ScoredEntry[] = [];
  for (const row of survivors) {
    const result = scoreRow(row, input.profile, input);
    if (result == null || result.degenerate) {
      excluded.push({ id: row.id, reason: "coverage-too-thin", severity: "info" });
      skippedForCoverage.push({
        id: row.id,
        symbol: row.symbol,
        missingSignals: ["every-signal-null"],
      });
      continue;
    }
    scored.push({
      row,
      score: result.score,
      components: result.components,
      confidence: result.confidence,
      confidenceReasons: result.confidenceReasons,
      redistributedSlots: result.redistributedSlots,
      recommendedSource: null,
      perInputStaleness: null,
      relaxedReason: null,
    });
  }

  // 7. Yield-only: select recommendedSource per coin.
  if (input.profile === "yield") {
    for (const entry of scored) {
      entry.recommendedSource = selectYieldSource(entry.row, input);
    }
    scored = scored.filter((entry) => {
      if (entry.recommendedSource != null) return true;
      excluded.push({
        id: entry.row.id,
        reason: "coverage-too-thin",
        severity: "info",
        detail: "missing-recommended-source",
      });
      skippedForCoverage.push({
        id: entry.row.id,
        symbol: entry.row.symbol,
        missingSignals: ["recommendedSource"],
      });
      return false;
    });
  }

  // 8. Circuit-breakers
  const skippedFrac = universeLen > 0 ? skippedForCoverage.length / universeLen : 0;
  const sparse = skippedFrac > 0.25;
  const uneven = !sparse && skippedFrac > 0.15;

  // 9. Trading-only: per-input staleness.
  if (input.profile === "trading") {
    for (const entry of scored) {
      entry.perInputStaleness = tradingPerInputStaleness(entry.row);
    }
  }

  // 10. Variant dedup
  const deduped = dedupVariants(scored, input.profile);

  // 11. Rank with tie-breakers
  deduped.sort(compareScored);
  const ranked = applyConcentrationSafeguard(deduped);

  // 12. Confidence demotion (Trading skips per R2 Active Trader P2)
  if (input.profile !== "trading" && ranked.length >= 2) {
    if (ranked[0]!.confidence < 40) {
      const tmp = ranked[0]!;
      ranked[0] = ranked[1]!;
      ranked[1] = tmp;
    }
  }

  // 13. Build top-3 recommendations
  const recommended: SelectorRecommendation[] = [];
  for (let i = 0; i < ranked.length; i += 1) {
    const entry = ranked[i]!;
    if (recommended.length >= 3) {
      continue;
    }
    const rank = (recommended.length + 1) as 1 | 2 | 3;
    const rec = buildRecommendation(
      entry,
      rank,
      input.profile,
      input,
      () => [],
      rankRobustnessFor(ranked, i),
    );
    if (rec == null) {
      // template-coverage gap — Yield rows without a source were removed before ranking.
      excluded.push({
        id: entry.row.id,
        reason: "template-coverage-gap",
        severity: "info",
      });
      continue;
    }
    recommended.push(rec);
  }
  const relaxedReasons = new Set<ExclusionReason>();
  if (recommended.length < 3) {
    const relaxed = buildRelaxedFallbackEntries(
      universe,
      input,
      new Set(recommended.map((rec) => rec.id)),
    );
    for (let i = 0; i < relaxed.length && recommended.length < 3; i += 1) {
      const entry = relaxed[i]!;
      const rank = (recommended.length + 1) as 1 | 2 | 3;
      const rec = buildRecommendation(
        entry,
        rank,
        input.profile,
        input,
        () => ["coverage-thin"],
        rankRobustnessFor(relaxed, i),
      );
      if (rec == null) continue;
      recommended.push(rec);
      if (entry.relaxedReason != null) relaxedReasons.add(entry.relaxedReason);
    }
  }
  const usedRelaxedFallback = relaxedReasons.size > 0;

  // 14. Lower-ranked-list
  const lowerRanked = selectLowerRanked(
    ranked,
    excluded,
    input,
    universe,
    new Set(recommended.map((r) => r.id)),
    scoreIgnoringExclusion,
  );

  // Coverage warning rollup
  const newListingCount = scored.filter((s) => s.row.isRecentListing).length;
  const redistributionCount = scored.reduce(
    (acc, s) => acc + s.redistributedSlots,
    0,
  );

  const lowConfidence =
    usedRelaxedFallback ||
    sparse ||
    recommended.length === 0 ||
    (recommended[0]?.confidence ?? 100) < 70;

  const output: SelectorOutput = {
    profile: input.profile,
    input,
    universe: { active: universeLen, surviving: survivors.length },
    recommended,
    lowerRanked,
    coverageWarnings: {
      skippedForCoverageCount: skippedForCoverage.length,
      skippedForCoverage,
      sparse,
      uneven,
      newListingCount,
      redistributionCount,
    },
    lowConfidence,
    usedRelaxedFallback,
    relaxedReasons: Array.from(relaxedReasons).sort(),
    exclusionSummary: buildExclusionSummary(excluded),
    closestSurvivors: buildClosestSurvivors(excluded, universe, input),
    relaxableConstraints: buildRelaxableConstraints(input, excluded),
    timestamp: dataset.timestamp,
    engineVersion: ENGINE_VERSION,
    methodologyVersions: dataset.methodologyVersions,
    datasetHash: dataset.datasetHash,
  };

  if (SELECTOR_DEBUG) {
    const allSurvivors: SelectorRecommendation[] = [];
    ranked.forEach((entry, index) => {
      const rank = Math.min(index + 1, 3) as 1 | 2 | 3;
      const rec = buildRecommendation(
        entry,
        rank,
        input.profile,
        input,
        () => [],
        rankRobustnessFor(ranked, index),
      );
      if (rec != null) allSurvivors.push(rec);
    });
    output.debug = { allSurvivors };
  }

  return output;
}
