/**
 * `runSelector(input, data, dataset)` — pure synchronous pipeline.
 *
 * Binding: `agents/selector-implementation-plan.md` §3, `agents/impl-plan-drafts/02-engine.md` §3.
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
  SelectorChainHints,
  SelectorComponent,
  SelectorData,
  SelectorInput,
  SelectorOutput,
  SelectorProfile,
  SelectorRecommendation,
  SkippedCoin,
  WeightKey,
  WhyKey,
  YieldRecommendation,
} from "./types";
import { SELECTOR_VERSION } from "./version";
import { WEIGHT_VECTORS } from "./weights";
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
  const vector = WEIGHT_VECTORS[profile];
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
  redistributedSlots: number;
  recommendedSource: RecommendedSource | null;
  perInputStaleness: Record<string, number> | null;
}

function scoreRow(
  row: MergedRow,
  profile: SelectorProfile,
  input: SelectorInput,
): {
  score: number;
  components: SelectorComponent[];
  confidence: number;
  redistributedSlots: number;
  /** True when every signal was null (degenerate row). */
  degenerate: boolean;
} | null {
  const slots = normalizeRow(row, profile, input);

  let redistributedSlots = 0;
  const present: NormalizedSlot[] = [];
  const neutralMissing = new Set<NormalizedSlot>();
  for (const slot of slots) {
    if (slot.rawValue != null && slot.normalizedValue != null) {
      present.push(slot);
      continue;
    }
    const policy = missingPolicy(slot.key, profile);
    if (policy === "penalty") {
      redistributedSlots += 1;
    }
    // Source-risk null is a deliberately neutral score input for Yield, but
    // still counts as missing for confidence and redistribution warnings.
    if (slot.key === "sourceRiskInverted" && slot.normalizedValue != null) {
      present.push(slot);
      neutralMissing.add(slot);
    }
  }

  if (present.length === 0) {
    return null;
  }

  // Pro-rata redistribute across present slots.
  const totalBase = present.reduce((acc, s) => acc + s.baseWeight, 0);
  if (totalBase === 0) {
    return { score: 0, components: [], confidence: 0, redistributedSlots, degenerate: true };
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
  if (row.isRecentListing) confidence -= 10;
  if (profile === "yield" && row.sourceSwitch) confidence -= 8;
  confidence = clamp(confidence, 0, 100);
  if (profile === "yield" && row.yieldHistoryDays < 60) {
    confidence = Math.min(confidence, 80);
  }

  return { score, components, confidence, redistributedSlots, degenerate: false };
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

function selectYieldSource(row: MergedRow): RecommendedSource | null {
  if (
    row.pharosYieldScore == null ||
    row.apy30d == null ||
    row.yieldProtocolSlug == null ||
    row.yieldVenueChain == null
  ) {
    return null;
  }
  return {
    protocol: row.yieldProtocolSlug,
    chain: row.yieldVenueChain,
    apy30d: row.apy30d,
    pharosYieldScore: row.pharosYieldScore,
    sourceRiskTier: row.venueRiskTier ?? "mid",
    freshness: row.yieldFreshness ?? { capturedAt: 0, ageSeconds: 0 },
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

function toScoredEntry(
  row: MergedRow,
  input: SelectorInput,
): ScoredEntry | null {
  const result = scoreRow(row, input.profile, input);
  if (result == null || result.degenerate) return null;
  const recommendedSource = input.profile === "yield" ? selectYieldSource(row) : null;
  if (input.profile === "yield" && recommendedSource == null) return null;
  return {
    row,
    score: result.score,
    components: result.components,
    confidence: result.confidence,
    redistributedSlots: result.redistributedSlots,
    recommendedSource,
    perInputStaleness:
      input.profile === "trading"
        ? {
            pegSummary: row.pegSummaryAgeSec ?? 0,
            dexTvl: row.dexTvlAgeSec ?? 0,
            dews: row.dewsAgeSec ?? 0,
          }
        : null,
  };
}

function isRelaxedFallbackEligible(
  row: MergedRow,
  input: SelectorInput,
): boolean {
  const coverage = hasRequiredSignals(row, input.profile);
  if (!coverage.ok) return false;
  const exclusion = evaluateExclusions(row, input);
  if (exclusion == null) return true;
  return !RELAXED_FALLBACK_BLOCKED_REASONS.has(exclusion.reason);
}

function buildRelaxedFallbackRecommendations(
  universe: readonly MergedRow[],
  input: SelectorInput,
): SelectorRecommendation[] {
  const scored: ScoredEntry[] = [];
  for (const row of universe) {
    if (!isRelaxedFallbackEligible(row, input)) continue;
    const entry = toScoredEntry(row, input);
    if (entry != null) scored.push(entry);
  }
  const deduped = dedupVariants(scored, input.profile);
  deduped.sort(compareScored);

  const recommended: SelectorRecommendation[] = [];
  for (const entry of deduped) {
    if (recommended.length >= 3) break;
    const rank = (recommended.length + 1) as 1 | 2 | 3;
    const rec = buildRecommendation(entry, rank, input.profile, input, () => []);
    if (rec != null) recommended.push(rec);
  }
  return recommended;
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

// ---------------------------------------------------------------------------
// Recommendation factory (variant-discriminated)
// ---------------------------------------------------------------------------

function buildRecommendation(
  entry: ScoredEntry,
  rank: 1 | 2 | 3,
  profile: SelectorProfile,
  input: SelectorInput,
  contextKeysFor: (row: MergedRow) => ContextKey[],
): SelectorRecommendation | null {
  const lowest = selectLowestSubDimension(entry.row, profile, entry.components);
  if (lowest == null) {
    return null;
  }
  const safetyGrade: ReportCardGrade = entry.row.safetyGrade ?? "NR";
  const base = {
    id: entry.row.id,
    symbol: entry.row.symbol,
    name: entry.row.name,
    rank,
    score: round1(entry.score),
    confidence: round1(entry.confidence),
    components: entry.components,
    whyKeys: pickWhyKeys(entry.row, profile, input),
    lowestSubDimension: {
      ...lowest,
      // Merge engine-derived context keys with the helper's defaults.
      contextKeys: Array.from(new Set([...lowest.contextKeys, ...contextKeysFor(entry.row)])),
    },
    chainHints: buildChainHints(entry.row, profile),
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

  // 5. Circuit-breakers
  const universeLen = universe.length;
  const skippedFrac = universeLen > 0 ? skippedForCoverage.length / universeLen : 0;
  const sparse = skippedFrac > 0.25;
  const uneven = !sparse && skippedFrac > 0.15;

  // 6. Layer 2 — scoring
  const scored: ScoredEntry[] = [];
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
      redistributedSlots: result.redistributedSlots,
      recommendedSource: null,
      perInputStaleness: null,
    });
  }

  // 7. Yield-only: select recommendedSource per coin.
  if (input.profile === "yield") {
    for (const entry of scored) {
      entry.recommendedSource = selectYieldSource(entry.row);
    }
  }

  // 8. Trading-only: per-input staleness.
  if (input.profile === "trading") {
    for (const entry of scored) {
      entry.perInputStaleness = {
        pegSummary: entry.row.pegSummaryAgeSec ?? 0,
        dexTvl: entry.row.dexTvlAgeSec ?? 0,
        dews: entry.row.dewsAgeSec ?? 0,
      };
    }
  }

  // 9. Variant dedup
  const deduped = dedupVariants(scored, input.profile);

  // 10. Rank with tie-breakers
  deduped.sort(compareScored);

  // 11. Confidence demotion (Trading skips per R2 Active Trader P2)
  if (input.profile !== "trading" && deduped.length >= 2) {
    if (deduped[0]!.confidence < 40) {
      const tmp = deduped[0]!;
      deduped[0] = deduped[1]!;
      deduped[1] = tmp;
    }
  }

  // 12. Build top-3 recommendations
  const recommended: SelectorRecommendation[] = [];
  const finalSurvivors: ScoredEntry[] = [];
  for (const entry of deduped) {
    if (recommended.length >= 3) {
      finalSurvivors.push(entry);
      continue;
    }
    const rank = (recommended.length + 1) as 1 | 2 | 3;
    const rec = buildRecommendation(entry, rank, input.profile, input, () => []);
    if (rec == null) {
      // template-coverage gap or yield missing source — exclude with reason
      excluded.push({
        id: entry.row.id,
        reason: input.profile === "yield" && entry.recommendedSource == null
          ? "coverage-too-thin"
          : "template-coverage-gap",
        severity: "info",
      });
      continue;
    }
    recommended.push(rec);
    finalSurvivors.push(entry);
  }
  const usedRelaxedFallback = recommended.length === 0;
  if (usedRelaxedFallback) {
    recommended.push(...buildRelaxedFallbackRecommendations(universe, input));
  }

  // 13. Lower-ranked-list
  const lowerRanked = selectLowerRanked(
    deduped,
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
    timestamp: dataset.timestamp,
    engineVersion: ENGINE_VERSION,
    methodologyVersions: dataset.methodologyVersions,
    datasetHash: dataset.datasetHash,
  };

  if (SELECTOR_DEBUG) {
    const allSurvivors: SelectorRecommendation[] = [];
    deduped.forEach((entry, index) => {
      const rank = Math.min(index + 1, 3) as 1 | 2 | 3;
      const rec = buildRecommendation(entry, rank, input.profile, input, () => []);
      if (rec != null) allSurvivors.push(rec);
    });
    output.debug = { allSurvivors };
  }

  return output;
}
