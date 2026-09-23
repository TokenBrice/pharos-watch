/**
 * `runSelector(input, data, dataset)` — pure synchronous pipeline.
 *
 * Binding: see `docs/screener-picker-page.md` for the maintained engine contract.
 * The engine reads no clocks and no randomness; `dataset.timestamp` is the
 * single time input, threaded by the caller.
 */
import {
  COVERAGE_SPARSE_FRACTION,
  COVERAGE_UNEVEN_FRACTION,
  LOW_CONFIDENCE_THRESHOLD,
} from "./coverage-policy";
import {
  applyInputDrivenExclusions,
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
import { selectYieldSourceRail, type SelectedYieldSourceRail } from "./yield-source";

export const ENGINE_VERSION = SELECTOR_VERSION;
export { scoreIgnoringExclusion };

const RELAXED_FALLBACK_ALLOWED_REASONS: ReadonlySet<ExclusionReason> = new Set([
  "peg-score-floor",
]);

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

function tradingPerInputStaleness(row: MergedRow): Record<string, number> {
  const ages: Record<string, number> = {};
  if (row.pegSummaryAgeSec != null) ages.pegSummary = row.pegSummaryAgeSec;
  if (row.dexTvlAgeSec != null) ages.dexTvl = row.dexTvlAgeSec;
  if (row.dewsAgeSec != null) ages.dews = row.dewsAgeSec;
  return ages;
}

interface ScoredEntryResult {
  entry: ScoredEntry | null;
  /** The `skippedForCoverage` signal when the row could not become an entry. */
  missingSignal: "every-signal-null" | "recommendedSource" | null;
}

/**
 * The single `ScoredEntry` constructor. Scoring, the yield rail and the
 * trading staleness map used to be three passes that each rebuilt the entry,
 * so a new field had to be added in every one of them.
 */
function toScoredEntry(row: MergedRow, input: SelectorInput): ScoredEntryResult {
  const rail = input.profile === "yield" ? selectYieldSourceRail(row, input) : null;
  const result = scoreRow(rowForRailHistory(row, rail), input.profile, input);
  if (result == null || result.degenerate) {
    return { entry: null, missingSignal: "every-signal-null" };
  }
  if (input.profile === "yield" && rail == null) {
    return { entry: null, missingSignal: "recommendedSource" };
  }
  return {
    entry: {
      row,
      score: result.score,
      components: result.components,
      confidence: result.confidence,
      confidenceReasons: result.confidenceReasons,
      redistributedSlots: result.redistributedSlots,
      recommendedSource: rail?.source ?? null,
      perInputStaleness: input.profile === "trading" ? tradingPerInputStaleness(row) : null,
      relaxedReason: null,
    },
    missingSignal: null,
  };
}

/**
 * The yield profile's `< 21` observation-day confidence rule must judge the
 * rail the run actually recommends: a mature primary can no longer lend its
 * history to a venue-preferred alternate that published only a few
 * observation days. Rows without a selected rail, or rails without a
 * published count, keep the row-level primary reading.
 */
function rowForRailHistory(row: MergedRow, rail: SelectedYieldSourceRail | null): MergedRow {
  if (rail?.observationDays30d == null) return row;
  if (rail.observationDays30d === row.yieldObservationDays30d) return row;
  return { ...row, yieldObservationDays30d: rail.observationDays30d };
}

function runScoringPhase(
  survivors: readonly MergedRow[],
  input: SelectorInput,
): ScoringPhase {
  const excluded: ExclusionRecord[] = [];
  const skippedForCoverage: SkippedCoin[] = [];
  const railExcluded: ExclusionRecord[] = [];
  const railSkipped: SkippedCoin[] = [];
  const scored: ScoredEntry[] = [];
  for (const row of survivors) {
    const result = toScoredEntry(row, input);
    if (result.entry != null) {
      scored.push(result.entry);
      continue;
    }
    if (result.missingSignal === "recommendedSource") {
      railExcluded.push({
        id: row.id,
        reason: "coverage-too-thin",
        severity: "info",
        detail: "missing-recommended-source",
      });
      railSkipped.push({
        id: row.id,
        symbol: row.symbol,
        missingSignals: ["recommendedSource"],
      });
      continue;
    }
    excluded.push({ id: row.id, reason: "coverage-too-thin", severity: "info" });
    skippedForCoverage.push({
      id: row.id,
      symbol: row.symbol,
      missingSignals: ["every-signal-null"],
    });
  }
  // Records stay grouped by cause, in the order the two passes emitted them:
  // every degenerate row, then every row with no resolvable rail.
  return {
    excluded: [...excluded, ...railExcluded],
    skippedForCoverage: [...skippedForCoverage, ...railSkipped],
    scored,
  };
}

function computeCoverageState(
  universeLength: number,
  skippedForCoverage: readonly SkippedCoin[],
): CoverageState {
  const skippedFrac = universeLength > 0 ? skippedForCoverage.length / universeLength : 0;
  const sparse = skippedFrac > COVERAGE_SPARSE_FRACTION;
  const uneven = !sparse && skippedFrac > COVERAGE_UNEVEN_FRACTION;
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
  if (applyInputDrivenExclusions(row, input) != null) return null;
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
    const { entry } = toScoredEntry(row, input);
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

export function runSelector(
  input: SelectorInput,
  data: SelectorData,
  dataset: DatasetMetadata,
): SelectorOutput {
  const universe = selectUniverse(input, data);
  const eligibility = runEligibilityPhase(universe, input);
  const scoring = runScoringPhase(eligibility.survivors, input);
  const scored = scoring.scored;
  let excluded = [...eligibility.excluded, ...scoring.excluded];
  const skippedForCoverage = [
    ...eligibility.skippedForCoverage,
    ...scoring.skippedForCoverage,
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
    (recommendations.recommended[0]?.confidence ?? 100) < LOW_CONFIDENCE_THRESHOLD;

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

  return output;
}
