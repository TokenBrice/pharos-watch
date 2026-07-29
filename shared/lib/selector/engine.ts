/**
 * `runSelector(input, data, dataset)` — pure synchronous pipeline.
 *
 * Binding: see `docs/screener-picker-page.md` for the maintained engine contract.
 * The engine reads no clocks and no randomness; `dataset.timestamp` is the
 * single time input, threaded by the caller.
 */
import {
  evaluateExclusions,
  hasRequiredSignals,
  HOWEY_UNCERTAIN_ASSETS,
} from "./exclusions";
import { selectLowerRanked } from "./lower-ranked";
import {
  buildClosestSurvivors,
  buildExclusionSummary,
  buildRelaxableConstraints,
} from "./output-helpers";
import {
  applyConcentrationSafeguard,
  dedupVariants,
  rankRobustnessFor,
  rankScoredEntries,
  sortScoredEntries,
} from "./ranking";
import { buildRecommendation } from "./recommendation";
import {
  scoreIgnoringExclusion,
  scoreRow,
  type ScoredEntry,
} from "./scoring";
import type {
  DatasetMetadata,
  ExclusionRecord,
  ExclusionReason,
  MergedRow,
  SelectorConfidenceReason,
  SelectorData,
  SelectorInput,
  SelectorOutput,
  SelectorRecommendation,
  SkippedCoin,
} from "./types";
import { SELECTOR_VERSION } from "./version";
import { selectYieldSource } from "./yield-source";

export const ENGINE_VERSION = SELECTOR_VERSION;
export { scoreIgnoringExclusion };

const RELAXED_FALLBACK_ALLOWED_REASONS: ReadonlySet<ExclusionReason> = new Set([
  "peg-score-floor",
]);

const SELECTOR_DEBUG =
  typeof process !== "undefined" && process.env?.SELECTOR_DEBUG === "true";

interface EligibilityPhase {
  excluded: ExclusionRecord[];
  skippedForCoverage: SkippedCoin[];
  survivors: MergedRow[];
}

interface ScoringPhase {
  excluded: ExclusionRecord[];
  skippedForCoverage: SkippedCoin[];
  scored: ScoredEntry[];
}

interface CoverageState {
  sparse: boolean;
  uneven: boolean;
}

interface RecommendationPhase {
  excluded: ExclusionRecord[];
  recommended: SelectorRecommendation[];
  relaxedReasons: Set<ExclusionReason>;
}

/**
 * Look up a merged row from the data bag. Exported so tests and the
 * template-coverage gate can call it directly.
 *
 * @internal
 */
export function mergeRow(id: string, data: SelectorData): MergedRow | null {
  return data.rows.get(id) ?? null;
}

function selectUniverse(
  input: SelectorInput,
  data: SelectorData,
): MergedRow[] {
  const universe: MergedRow[] = [];
  for (const row of data.rows.values()) {
    if (row.pegCurrency !== input.pegCurrency) continue;
    if (HOWEY_UNCERTAIN_ASSETS.has(row.id)) continue;
    universe.push(row);
  }
  return universe;
}

function runEligibilityPhase(
  universe: readonly MergedRow[],
  input: SelectorInput,
): EligibilityPhase {
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
  return { excluded, skippedForCoverage, survivors };
}

function runScoringPhase(
  survivors: readonly MergedRow[],
  input: SelectorInput,
): ScoringPhase {
  const excluded: ExclusionRecord[] = [];
  const skippedForCoverage: SkippedCoin[] = [];
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
      confidenceReasons: result.confidenceReasons,
      redistributedSlots: result.redistributedSlots,
      recommendedSource: null,
      perInputStaleness: null,
      relaxedReason: null,
    });
  }
  return { excluded, skippedForCoverage, scored };
}

function runYieldSourcePhase(
  scored: readonly ScoredEntry[],
  input: SelectorInput,
): ScoringPhase {
  if (input.profile !== "yield") {
    return { excluded: [], skippedForCoverage: [], scored: [...scored] };
  }

  const excluded: ExclusionRecord[] = [];
  const skippedForCoverage: SkippedCoin[] = [];
  const withSources = scored.map((entry) => ({
    ...entry,
    recommendedSource: selectYieldSource(entry.row, input),
  }));
  const retained: ScoredEntry[] = [];
  for (const entry of withSources) {
    if (entry.recommendedSource != null) {
      retained.push(entry);
      continue;
    }
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
  }
  return { excluded, skippedForCoverage, scored: retained };
}

function tradingPerInputStaleness(row: MergedRow): Record<string, number> {
  const ages: Record<string, number> = {};
  if (row.pegSummaryAgeSec != null) ages.pegSummary = row.pegSummaryAgeSec;
  if (row.dexTvlAgeSec != null) ages.dexTvl = row.dexTvlAgeSec;
  if (row.dewsAgeSec != null) ages.dews = row.dewsAgeSec;
  return ages;
}

function runTradingStalenessPhase(
  scored: readonly ScoredEntry[],
  input: SelectorInput,
): ScoredEntry[] {
  if (input.profile !== "trading") return [...scored];
  return scored.map((entry) => ({
    ...entry,
    perInputStaleness: tradingPerInputStaleness(entry.row),
  }));
}

function computeCoverageState(
  universeLength: number,
  skippedForCoverage: readonly SkippedCoin[],
): CoverageState {
  const skippedFrac = universeLength > 0 ? skippedForCoverage.length / universeLength : 0;
  const sparse = skippedFrac > 0.25;
  const uneven = !sparse && skippedFrac > 0.15;
  return { sparse, uneven };
}

function relaxedFallbackReason(
  row: MergedRow,
  input: SelectorInput,
): ExclusionReason | null {
  const coverage = hasRequiredSignals(row, input.profile);
  if (!coverage.ok) return null;
  const exclusion = evaluateExclusions(row, input);
  if (exclusion == null) return null;
  if (!RELAXED_FALLBACK_ALLOWED_REASONS.has(exclusion.reason)) return null;
  if (input.profile === "treasury") return null;
  return exclusion.reason;
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
  return applyConcentrationSafeguard(sortScoredEntries(deduped));
}

function buildRecommendationPhase(
  ranked: readonly ScoredEntry[],
  universe: readonly MergedRow[],
  input: SelectorInput,
  excluded: readonly ExclusionRecord[],
): RecommendationPhase {
  const recommended: SelectorRecommendation[] = [];
  const nextExcluded = [...excluded];
  for (let i = 0; i < ranked.length; i += 1) {
    const entry = ranked[i]!;
    if (recommended.length >= 3) {
      break;
    }
    const rank = (recommended.length + 1) as 1 | 2 | 3;
    const rec = buildRecommendation(
      entry,
      rank,
      input.profile,
      [],
      rankRobustnessFor(ranked, i),
    );
    if (rec == null) {
      nextExcluded.push({
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
        ["coverage-thin"],
        rankRobustnessFor(relaxed, i),
      );
      if (rec == null) continue;
      recommended.push(rec);
      if (entry.relaxedReason != null) relaxedReasons.add(entry.relaxedReason);
    }
  }
  return { excluded: nextExcluded, recommended, relaxedReasons };
}

function appendSelectorDebug(
  output: SelectorOutput,
  ranked: readonly ScoredEntry[],
  input: SelectorInput,
): void {
  if (!SELECTOR_DEBUG) return;
  const allSurvivors: SelectorRecommendation[] = [];
  ranked.forEach((entry, index) => {
    const rank = Math.min(index + 1, 3) as 1 | 2 | 3;
    const rec = buildRecommendation(
      entry,
      rank,
      input.profile,
      [],
      rankRobustnessFor(ranked, index),
    );
    if (rec != null) allSurvivors.push(rec);
  });
  output.debug = { allSurvivors };
}

export function runSelector(
  input: SelectorInput,
  data: SelectorData,
  dataset: DatasetMetadata,
): SelectorOutput {
  const universe = selectUniverse(input, data);
  const eligibility = runEligibilityPhase(universe, input);
  const scoring = runScoringPhase(eligibility.survivors, input);
  const yieldSources = runYieldSourcePhase(scoring.scored, input);
  const scored = runTradingStalenessPhase(yieldSources.scored, input);
  let excluded = [
    ...eligibility.excluded,
    ...scoring.excluded,
    ...yieldSources.excluded,
  ];
  const skippedForCoverage = [
    ...eligibility.skippedForCoverage,
    ...scoring.skippedForCoverage,
    ...yieldSources.skippedForCoverage,
  ];
  const coverageState = computeCoverageState(universe.length, skippedForCoverage);
  const ranked = rankScoredEntries(scored, input);
  const recommendations = buildRecommendationPhase(ranked, universe, input, excluded);
  excluded = recommendations.excluded;
  const usedRelaxedFallback = recommendations.relaxedReasons.size > 0;
  const rowsById = new Map(universe.map((row) => [row.id, row]));
  const lowerRanked = selectLowerRanked(
    ranked,
    excluded,
    input,
    universe,
    new Set(recommendations.recommended.map((r) => r.id)),
    scoreIgnoringExclusion,
    rowsById,
  );

  const newListingCount = scored.filter((s) => s.row.isRecentListing).length;
  const redistributionCount = scored.reduce(
    (acc, s) => acc + s.redistributedSlots,
    0,
  );

  const lowConfidence =
    usedRelaxedFallback ||
    coverageState.sparse ||
    recommendations.recommended.length === 0 ||
    (recommendations.recommended[0]?.confidence ?? 100) < 70;

  const output: SelectorOutput = {
    profile: input.profile,
    input,
    universe: { active: universe.length, surviving: eligibility.survivors.length },
    recommended: recommendations.recommended,
    lowerRanked,
    coverageWarnings: {
      skippedForCoverageCount: skippedForCoverage.length,
      skippedForCoverage,
      sparse: coverageState.sparse,
      uneven: coverageState.uneven,
      newListingCount,
      redistributionCount,
    },
    lowConfidence,
    usedRelaxedFallback,
    relaxedReasons: Array.from(recommendations.relaxedReasons).sort(),
    exclusionSummary: buildExclusionSummary(excluded),
    closestSurvivors: buildClosestSurvivors(excluded, universe, input, scoreIgnoringExclusion, rowsById),
    relaxableConstraints: buildRelaxableConstraints(input, excluded),
    timestamp: dataset.timestamp,
    engineVersion: ENGINE_VERSION,
    methodologyVersions: dataset.methodologyVersions,
    datasetHash: dataset.datasetHash,
  };

  appendSelectorDebug(output, ranked, input);

  return output;
}
