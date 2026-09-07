import {
  CLIENT_TRACKED_META_BY_ID,
  CLIENT_TRACKED_STABLECOINS,
} from "../stablecoins/client-registry";
import { round1 } from "../math";
import { buildRelaxableConstraints } from "./output-helpers";
import {
  COVERAGE_SPARSE_FRACTION,
  COVERAGE_UNEVEN_FRACTION,
  LOW_CONFIDENCE_THRESHOLD,
} from "./coverage-policy";
import {
  CRITICAL_SIGNAL_SET_BY_PROFILE,
  missingSlotRedistributes,
  normalizeSelectorComponentValue,
} from "./scoring";
import {
  SELECTOR_SNAPSHOT_SUPPORTED_ENGINE_VERSIONS,
  SELECTOR_VERSION,
} from "./version";
import { getWeightVectorForInput } from "./weights";
import type {
  ExclusionReason,
  MethodologyVersions,
  SelectorComponent,
  SelectorConfidenceReason,
  SelectorExclusionSummaryItem,
  SelectorInput,
  SelectorLowerRanked,
  SelectorOutput,
  SelectorProfile,
  SelectorRecommendation,
  SelectorRankRobustness,
  WeightKey,
} from "./types";

const SUPPORTED_ENGINE_VERSIONS = new Set<string>(SELECTOR_SNAPSHOT_SUPPORTED_ENGINE_VERSIONS);

/**
 * Engine versions whose weight vectors, component projection, and critical
 * sets match the current engine.
 *
 * The read path used to test `engineVersion === SELECTOR_VERSION`, which is
 * only correct while there is exactly one post-`v2.0` version. `selector-v2.1`
 * changed the `MergedRow` shape and the custody data source; it did not touch
 * weights, components, or critical sets, so a stored `v2.0` snapshot must keep
 * replaying against the current sets rather than falling through to the legacy
 * `v1.x` ones. Add a version here only when it shares the current component
 * contract; a version that re-bases weights or critical sets starts a new
 * generation and needs its own branch.
 */
const CURRENT_GENERATION_ENGINE_VERSIONS = new Set<string>([
  "selector-v2.0",
  "selector-v2.1",
  SELECTOR_VERSION,
]);

function isCurrentGenerationEngine(engineVersion: string): boolean {
  return CURRENT_GENERATION_ENGINE_VERSIONS.has(engineVersion);
}

const KNOWN_MISSING_SIGNALS = new Set([
  "safetyGrade",
  "safetyScore",
  "safety-score-v9",
  "safety-score-v9-nr",
  "safetyResilienceScore",
  "safetyDependencyRiskScore",
  "dewsScore",
  "pegScore",
  "pharosYieldScore",
  "apy30d",
  "liquidityScore",
  "every-signal-null",
  "recommendedSource",
]);
/**
 * Critical-component sets belong to the engine version that produced a
 * snapshot, not to the engine reading it. They decide the 78 missing-critical
 * cap and the `missing-critical-*` confidence reasons, so replaying a stored
 * blob against the wrong set republishes a different number than the one that
 * was shared — and, for a SID-bound verified snapshot, permanently breaks the
 * link. `selector-v2.0` re-based the sets for the first time since they were
 * introduced (trading swapped `effectiveExit` for `safetyOverall`; treasury
 * dropped `resilience` and `dependencyRisk`), which is why the read path has to
 * gate them the same way it already gates the component projection.
 * Current-generation snapshots reuse the engine's exported critical sets;
 * only the pre-`selector-v2.0` sets stay local to this read path.
 */
/** The single pre-`selector-v2.0` set, shared by every `v1.0`-`v1.92` snapshot. */
const LEGACY_CRITICAL_COMPONENTS_BY_PROFILE: Readonly<
  Record<SelectorProfile, ReadonlySet<WeightKey>>
> = {
  treasury: new Set([
    "safetyOverall",
    "resilience",
    "dependencyRisk",
    "pegStabilityHistory",
    "dewsInverted",
  ]),
  yield: new Set([
    "pharosYieldScore",
    "yieldVariance",
    "safetyOverall",
    "sourceRiskInverted",
    "pegStabilityLive",
    "liquidity",
  ]),
  trading: new Set(["liquidity", "pegScoreNow", "dewsInverted", "effectiveExit"]),
};

function criticalComponentsFor(
  engineVersion: string,
  profile: SelectorProfile,
): ReadonlySet<WeightKey> {
  return isCurrentGenerationEngine(engineVersion)
    ? CRITICAL_SIGNAL_SET_BY_PROFILE[profile]
    : LEGACY_CRITICAL_COMPONENTS_BY_PROFILE[profile];
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function canonicalIdentity(id: string): { id: string; symbol: string; name: string } | null {
  const meta = CLIENT_TRACKED_META_BY_ID.get(id);
  return meta ? { id: meta.id, symbol: meta.symbol, name: meta.name } : null;
}

export function normalizeSelectorInput(input: SelectorInput): SelectorInput {
  return {
    profile: input.profile,
    pegCurrency: input.pegCurrency,
    horizon: input.horizon,
    depegTolerance: input.depegTolerance,
    composability: input.composability,
    ...(input.venuePreferences === undefined
      ? {}
      : { venuePreferences: [...input.venuePreferences] }),
    exitSpeed: input.exitSpeed,
    minApy: input.minApy,
    yieldNativeOnly: input.yieldNativeOnly,
    decentralization: input.decentralization,
    custodyOk: input.custodyOk,
  } as SelectorInput;
}

function projectCurrentComponents(
  input: SelectorInput,
  components: readonly SelectorComponent[],
): SelectorComponent[] | null {
  const suppliedByKey = new Map(components.map((component) => [component.key, component]));
  if (suppliedByKey.size !== components.length) return null;

  const expected = Object.entries(getWeightVectorForInput(input))
    .filter((entry): entry is [WeightKey, number] => typeof entry[1] === "number" && entry[1] > 0);
  if (suppliedByKey.size !== expected.length || expected.some(([key]) => !suppliedByKey.has(key))) {
    return null;
  }

  const normalized = expected.map(([key, baseWeight]) => {
    const supplied = suppliedByKey.get(key)!;
    const normalizedValue = normalizeSelectorComponentValue(key, supplied.rawValue);
    const present = normalizedValue !== null && (supplied.rawValue !== null || key === "sourceRiskInverted");
    return { key, baseWeight, rawValue: supplied.rawValue, normalizedValue, present };
  });
  const totalPresentWeight = normalized.reduce(
    (total, component) => total + (component.present ? component.baseWeight : 0),
    0,
  );
  if (totalPresentWeight <= 0) return null;

  const project = (component: (typeof normalized)[number]): SelectorComponent => {
    if (!component.present) {
      return {
        key: component.key,
        weight: 0,
        rawValue: component.rawValue,
        normalizedValue: component.normalizedValue,
        contribution: 0,
        redistributed: missingSlotRedistributes(input.profile, component.key),
      };
    }
    const weight = (component.baseWeight / totalPresentWeight) * 100;
    return {
      key: component.key,
      weight,
      rawValue: component.rawValue,
      normalizedValue: component.normalizedValue,
      contribution: (weight * (component.normalizedValue ?? 0)) / 100,
      redistributed: component.rawValue === null,
    };
  };

  return [
    ...normalized.filter((component) => component.present).map(project),
    ...normalized.filter((component) => !component.present).map(project),
  ];
}

function projectLegacyComponents(components: readonly SelectorComponent[]): SelectorComponent[] | null {
  if (components.length === 0 || hasDuplicates(components.map((component) => component.key))) return null;
  const positiveWeight = components.reduce((total, component) => total + component.weight, 0);
  if (Math.abs(positiveWeight - 100) > 0.01) return null;
  return components.map((component) => ({
    key: component.key,
    weight: component.weight,
    rawValue: component.rawValue,
    normalizedValue: component.normalizedValue,
    contribution: component.normalizedValue === null
      ? 0
      : (component.weight * component.normalizedValue) / 100,
    redistributed: component.redistributed,
  }));
}

function projectConfidenceReasons(
  recommendation: SelectorRecommendation,
  components: readonly SelectorComponent[],
  engineVersion: string,
): SelectorConfidenceReason[] | undefined {
  const reasons = new Set(recommendation.confidenceReasons ?? []);
  const critical = criticalComponentsFor(engineVersion, recommendation.profile);
  for (const component of components) {
    if (component.rawValue === null && critical.has(component.key)) {
      reasons.add(`missing-critical-${component.key}`);
    }
  }
  if (components.some((component) => component.redistributed)) reasons.add("redistributed-missing-data");
  if (recommendation.isRecentListing) reasons.add("recent-listing");
  if (recommendation.relaxedReason != null) reasons.add("relaxed-fallback");
  if (recommendation.profile === "yield") {
    const sourceRisk = components.find((component) => component.key === "sourceRiskInverted");
    if (sourceRisk?.rawValue === null) reasons.add("source-risk-missing");
  }
  const projected = Array.from(reasons).sort();
  return projected.length === 0 ? undefined : projected;
}

function scoreFromComponents(
  profile: SelectorProfile,
  components: readonly SelectorComponent[],
  engineVersion: string,
): number {
  const rawScore = components.reduce((total, component) => total + component.contribution, 0);
  const critical = criticalComponentsFor(engineVersion, profile);
  const hasMissingCritical = components.some(
    (component) => component.rawValue === null && critical.has(component.key),
  );
  return round1(Math.min(rawScore, hasMissingCritical ? 78 : 100));
}

function projectRecommendation(
  recommendation: SelectorRecommendation,
  input: SelectorInput,
  engineVersion: string,
  rank: 1 | 2 | 3,
): SelectorRecommendation | null {
  const identity = canonicalIdentity(recommendation.id);
  if (!identity) return null;
  if (
    isCurrentGenerationEngine(engineVersion)
    && recommendation.relaxedReason != null
    && recommendation.relaxedReason !== "peg-score-floor"
  ) {
    return null;
  }
  const components = isCurrentGenerationEngine(engineVersion)
    ? projectCurrentComponents(input, recommendation.components)
    : projectLegacyComponents(recommendation.components);
  if (!components || hasDuplicates(recommendation.whyKeys)) return null;

  const common = {
    ...identity,
    profile: recommendation.profile,
    rank,
    score: scoreFromComponents(recommendation.profile, components, engineVersion),
    confidence: round1(recommendation.confidence),
    ...(() => {
      const reasons = projectConfidenceReasons(recommendation, components, engineVersion);
      return reasons ? { confidenceReasons: reasons } : {};
    })(),
    components,
    whyKeys: [...recommendation.whyKeys],
    lowestSubDimension: {
      key: recommendation.lowestSubDimension.key,
      score: round1(recommendation.lowestSubDimension.score),
      contextKeys: Array.from(new Set(recommendation.lowestSubDimension.contextKeys)).sort(),
    },
    chainHints: {
      topByLiquidity: [...recommendation.chainHints.topByLiquidity],
      topByYield: [...recommendation.chainHints.topByYield],
      primary: recommendation.chainHints.primary,
    },
    ...(recommendation.relaxedReason === undefined
      ? {}
      : { relaxedReason: recommendation.relaxedReason }),
    isRecentListing: recommendation.isRecentListing,
    bluechipGrade: recommendation.bluechipGrade,
    safetyGrade: recommendation.safetyGrade,
    supplyUsd: recommendation.supplyUsd,
    isBeta: true as const,
  };

  if (recommendation.profile === "treasury") {
    return { ...common, profile: "treasury", recommendedSource: null, perInputStaleness: null };
  }
  if (recommendation.profile === "trading") {
    return {
      ...common,
      profile: "trading",
      recommendedSource: null,
      perInputStaleness: { ...recommendation.perInputStaleness },
    };
  }
  return {
    ...common,
    profile: "yield",
    recommendedSource: {
      ...(recommendation.recommendedSource.sourceKey === undefined
        ? {}
        : { sourceKey: recommendation.recommendedSource.sourceKey }),
      protocol: recommendation.recommendedSource.protocol,
      chain: recommendation.recommendedSource.chain,
      ...(recommendation.recommendedSource.yieldType === undefined
        ? {}
        : { yieldType: recommendation.recommendedSource.yieldType }),
      apy30d: recommendation.recommendedSource.apy30d,
      pharosYieldScore: recommendation.recommendedSource.pharosYieldScore,
      ...(recommendation.recommendedSource.sourceTvlUsd === undefined
        ? {}
        : { sourceTvlUsd: recommendation.recommendedSource.sourceTvlUsd }),
      sourceRiskTier: recommendation.recommendedSource.sourceRiskTier,
      freshness: {
        capturedAt: recommendation.recommendedSource.freshness.capturedAt,
        ageSeconds: recommendation.recommendedSource.freshness.ageSeconds,
      },
    },
    perInputStaleness: null,
  };
}

function projectRankRobustness(
  recommendation: SelectorRecommendation,
  next: SelectorRecommendation | undefined,
): SelectorRankRobustness {
  if (!next) {
    return {
      label: recommendation.rankRobustness?.label === "concentration-adjusted"
        ? "concentration-adjusted"
        : "clear-margin",
      scoreMargin: null,
    };
  }
  const scoreMargin = round1(Math.max(0, recommendation.score - next.score));
  const label = recommendation.rankRobustness?.label === "concentration-adjusted"
    ? "concentration-adjusted"
    : scoreMargin < 1.5
      ? "narrow-margin"
      : scoreMargin < 3
        ? "crowded-field"
        : "clear-margin";
  return { label, scoreMargin };
}

function projectRecommendations(
  recommendations: readonly SelectorRecommendation[],
  input: SelectorInput,
  engineVersion: string,
): SelectorRecommendation[] | null {
  if (hasDuplicates(recommendations.map((recommendation) => recommendation.id))) return null;
  const projected: SelectorRecommendation[] = [];
  for (let index = 0; index < recommendations.length; index += 1) {
    const recommendation = projectRecommendation(
      recommendations[index]!,
      input,
      engineVersion,
      (index + 1) as 1 | 2 | 3,
    );
    if (!recommendation) return null;
    projected.push(recommendation);
  }
  return projected.map((recommendation, index) => ({
    ...recommendation,
    rankRobustness: projectRankRobustness(recommendation, projected[index + 1]),
  })) as SelectorRecommendation[];
}

function projectLowerRanked(
  entries: readonly SelectorLowerRanked[],
  recommendedIds: ReadonlySet<string>,
): SelectorLowerRanked[] | null {
  if (hasDuplicates(entries.map((entry) => entry.id)) || hasDuplicates(entries.map((entry) => entry.slot))) {
    return null;
  }
  const projected: SelectorLowerRanked[] = [];
  for (const entry of entries) {
    const identity = canonicalIdentity(entry.id);
    if (!identity || recommendedIds.has(entry.id)) return null;
    projected.push({
      ...identity,
      slot: entry.slot,
      reasonKey: entry.reasonKey,
      failedComponent: entry.failedComponent,
      hypotheticalScore: entry.hypotheticalScore === null ? null : round1(entry.hypotheticalScore),
    });
  }
  return projected.sort((left, right) => left.slot.localeCompare(right.slot));
}

function projectExclusionSummary(
  summary: readonly SelectorExclusionSummaryItem[],
): SelectorExclusionSummaryItem[] | null {
  if (hasDuplicates(summary.map((entry) => entry.reason))) return null;
  const projected: SelectorExclusionSummaryItem[] = [];
  for (const entry of summary) {
    if (
      entry.sampleIds.length > 3
      || entry.sampleIds.length > entry.count
      || hasDuplicates(entry.sampleIds)
      || entry.sampleIds.some((id) => !canonicalIdentity(id))
    ) {
      return null;
    }
    projected.push({
      reason: entry.reason,
      count: entry.count,
      severity: entry.severity,
      sampleIds: [...entry.sampleIds],
    });
  }
  return projected.sort((left, right) =>
    right.count - left.count || left.reason.localeCompare(right.reason));
}

function buildCanonicalRelaxableConstraints(
  input: SelectorInput,
  summary: readonly SelectorExclusionSummaryItem[],
): SelectorOutput["relaxableConstraints"] {
  return buildRelaxableConstraints(
    input,
    summary.map((entry) => ({
      id: entry.sampleIds[0] ?? "snapshot-summary",
      reason: entry.reason,
      severity: entry.severity,
    })),
  );
}

function projectMethodologyVersions(
  versions: MethodologyVersions,
  engineVersion: string,
): MethodologyVersions | null {
  if (versions.exclusionFilters !== engineVersion) return null;
  return {
    safetyScore: versions.safetyScore,
    pegScoreAndDews: versions.pegScoreAndDews,
    yieldIntelligence: versions.yieldIntelligence,
    bluechipAlignment: versions.bluechipAlignment,
    exclusionFilters: engineVersion,
  };
}

export function normalizeSelectorSnapshot(snapshot: SelectorOutput): SelectorOutput | null {
  if (!SUPPORTED_ENGINE_VERSIONS.has(snapshot.engineVersion) || !/^[0-9a-f]{64}$/.test(snapshot.datasetHash)) {
    return null;
  }
  const input = normalizeSelectorInput(snapshot.input);
  const methodologyVersions = projectMethodologyVersions(snapshot.methodologyVersions, snapshot.engineVersion);
  const recommended = projectRecommendations(snapshot.recommended, input, snapshot.engineVersion);
  if (!methodologyVersions || !recommended) return null;

  const recommendedIds = new Set(recommended.map((entry) => entry.id));
  const lowerRanked = projectLowerRanked(snapshot.lowerRanked, recommendedIds);
  const exclusionSummary = projectExclusionSummary(snapshot.exclusionSummary);
  if (!lowerRanked || !exclusionSummary) return null;

  const { active, surviving } = snapshot.universe;
  if (
    active > CLIENT_TRACKED_STABLECOINS.length
    || surviving > active
    || surviving < recommended.length
    || exclusionSummary.reduce((total, entry) => total + entry.count, 0) > active
  ) {
    return null;
  }

  const skippedForCoverage = [];
  for (const skipped of snapshot.coverageWarnings.skippedForCoverage) {
    const identity = canonicalIdentity(skipped.id);
    if (
      !identity
      || recommendedIds.has(skipped.id)
      || hasDuplicates(skipped.missingSignals)
      || skipped.missingSignals.some(
        (signal) => !KNOWN_MISSING_SIGNALS.has(signal) && !signal.startsWith("safety-nr: "),
      )
    ) {
      return null;
    }
    skippedForCoverage.push({
      id: identity.id,
      symbol: identity.symbol,
      missingSignals: [...skipped.missingSignals].sort(),
    });
  }
  if (hasDuplicates(skippedForCoverage.map((entry) => entry.id))) return null;
  const coverageExclusionCount = exclusionSummary.find((entry) => entry.reason === "coverage-too-thin")?.count ?? 0;
  if (coverageExclusionCount !== skippedForCoverage.length) return null;

  const closestSurvivors = [];
  const summarizedReasons = new Set(exclusionSummary.map((entry) => entry.reason));
  for (const entry of snapshot.closestSurvivors) {
    const identity = canonicalIdentity(entry.id);
    if (!identity || recommendedIds.has(entry.id) || !summarizedReasons.has(entry.reason)) return null;
    closestSurvivors.push({
      id: identity.id,
      symbol: identity.symbol,
      failingDimension: entry.reason,
      liveReading: `Recorded profile gate: ${entry.reason.replaceAll("-", " ")}`,
      reason: entry.reason,
      hypotheticalScore: entry.hypotheticalScore === null ? null : round1(entry.hypotheticalScore),
    });
  }
  if (closestSurvivors.length > 3 || hasDuplicates(closestSurvivors.map((entry) => entry.id))) return null;

  const relaxedReasons = Array.from(new Set(
    recommended
      .map((entry) => entry.relaxedReason)
      .filter((reason): reason is ExclusionReason => reason != null),
  )).sort();
  const usedRelaxedFallback = relaxedReasons.length > 0;
  const skippedFraction = active > 0 ? skippedForCoverage.length / active : 0;
  const sparse = skippedFraction > COVERAGE_SPARSE_FRACTION;
  const uneven = !sparse && skippedFraction > COVERAGE_UNEVEN_FRACTION;
  const minimumRedistributionCount = recommended.reduce(
    (total, entry) => total + entry.components.filter((component) => component.redistributed).length,
    0,
  );
  if (
    snapshot.coverageWarnings.newListingCount > surviving
    || snapshot.coverageWarnings.redistributionCount < minimumRedistributionCount
    || snapshot.coverageWarnings.redistributionCount > surviving * 16
  ) {
    return null;
  }

  return {
    profile: input.profile,
    input,
    universe: { active, surviving },
    recommended,
    lowerRanked,
    coverageWarnings: {
      skippedForCoverageCount: skippedForCoverage.length,
      skippedForCoverage,
      sparse,
      uneven,
      newListingCount: snapshot.coverageWarnings.newListingCount,
      redistributionCount: snapshot.coverageWarnings.redistributionCount,
    },
    lowConfidence:
      usedRelaxedFallback
      || sparse
      || recommended.length === 0
      || (recommended[0]?.confidence ?? 100) < LOW_CONFIDENCE_THRESHOLD,
    usedRelaxedFallback,
    relaxedReasons,
    exclusionSummary,
    closestSurvivors,
    relaxableConstraints: buildCanonicalRelaxableConstraints(input, exclusionSummary),
    timestamp: snapshot.timestamp,
    engineVersion: snapshot.engineVersion,
    methodologyVersions,
    datasetHash: snapshot.datasetHash,
    provenance: "client-unverified",
    snapshotSchemaVersion: 2,
  };
}
