import { V9_CANDIDATE_POLICY_V1 } from "../../shared/lib/safety-score-v9/policy.ts";
import { sumKnownSupplyUsdOrNull } from "../../shared/lib/safety-score-v9/supply-weighting.mjs";
import {
  GRADE_BOUNDARIES,
  GRADE_ORDER,
  compareText,
  countsBy,
  quantile,
  round,
} from "./safety-score-v9-calibration-core.mjs";
// Frozen D1-D6 thresholds; changing these is a methodology decision.
const DISTRIBUTION_GATE_THRESHOLDS = {
  materialEvidenceCoverageExTop2Min: 0.4,
  supplyObservationCoverageMin: 0.95,
  maxNrSupplyUsd: 50_000_000,
  unattributedFCountMax: 25,
  unattributedFSupplyShareMax: 0.001,
  freeFloatingLargestBucketShareMax: 0.12,
  freeFloatingLargestTupleShareMax: 0.12,
  materialCohortCMinusOrBetterShareMin: 0.5,
  materialCohortBMinusOrBetterCountMin: 8,
  scoreIqrMin: 12,
};
const MATERIAL_COHORT_EXCLUDED_TOP_RANKS = 2;
const MATERIAL_COHORT_MIN_SUPPLY_USD = 100_000_000;
const WINSORIZED_WEIGHT_CAP = 0.05;
const PILLAR_KEYS = ["backing", "exit", "control"];
const PILLAR_BOUNDED_UNKNOWN_FLOORS = {
  backing: V9_CANDIDATE_POLICY_V1.policy.semantic.backing.boundedUnknownQuality,
  exit: V9_CANDIDATE_POLICY_V1.policy.semantic.exit.boundedUnknownScore,
  control: V9_CANDIDATE_POLICY_V1.policy.semantic.control.boundedUnknownQuality,
};
const COMPROMISED_MINT_POSTURE_QUALITY =
  V9_CANDIDATE_POLICY_V1.policy.semantic.control.mintPostureQuality["unbounded-or-compromised"];
const MEASURED_PEG_MULTIPLIER_FLOOR = 0.9;
const UNSUPPORTED_DESIGN_REASON_CODES = new Set(
  V9_CANDIDATE_POLICY_V1.policy.reasonRegistry
    .filter((entry) => entry.auditClassification === "unsupported-design")
    .map((entry) => entry.code),
);
const UNRESOLVED_METHODOLOGY_REASON_CODES = new Set(
  V9_CANDIDATE_POLICY_V1.policy.reasonRegistry
    .filter((entry) => entry.auditClassification === "unresolved-methodology")
    .map((entry) => entry.code),
);
const METHODOLOGY_BLOCKED_ARCHETYPES = new Set(["rwa-credit-fund", "synthetic-delta-neutral"]);
const METHODOLOGY_BLOCKED_RESIDUAL_REASON = "bounded-mechanism-review";
const GRADE_BANDS = { A: ["A+", "A", "A-"], B: ["B+", "B", "B-"], C: ["C+", "C", "C-"], D: ["D"], F: ["F"] };
function nextBoundary(score) {
  return GRADE_BOUNDARIES.find((boundary) => boundary > score) ?? 100;
}
function pillarsAtOrBelowFloor(card) {
  return PILLAR_KEYS.filter((pillar) => card.pillars[pillar].score <= PILLAR_BOUNDED_UNKNOWN_FLOORS[pillar]).length;
}
function knownSupplyUsd(facts) {
  const supply = facts?.supply;
  return supply?.status?.observationState === "known" && typeof supply.circulatingUsd === "number"
    ? supply.circulatingUsd
    : null;
}
function isAdverseStructuralCapKind(kind) {
  return (
    kind === "parent" || kind.startsWith("active-depeg:") || (kind.startsWith("signal:") && kind.endsWith(":critical"))
  );
}
// D3 treats every F not held by a measured adverse fact as unattributed.
export function measuredAdverseFDrivers(card) {
  return {
    compromisedMintPosture: card.pillars.control.score <= COMPROMISED_MINT_POSTURE_QUALITY,
    subFloorPillar: PILLAR_KEYS.some((pillar) => card.pillars[pillar].score < PILLAR_BOUNDED_UNKNOWN_FLOORS[pillar]),
    measuredPegHistory: typeof card.pegMultiplier === "number" && card.pegMultiplier < MEASURED_PEG_MULTIPLIER_FLOOR,
    bindingAdverseCap: card.caps.some((cap) => cap.binding && isAdverseStructuralCapKind(cap.kind)),
    unsupportedExitDesign: (card.reasonCodes ?? []).some((code) => UNSUPPORTED_DESIGN_REASON_CODES.has(code)),
  };
}
function isMeasuredAdverseF(card) {
  return Object.values(measuredAdverseFDrivers(card)).some(Boolean);
}
function isMethodologyBlockedF(card, facts) {
  const reasonCodes = card.reasonCodes ?? [];
  return (
    reasonCodes.some((code) => UNRESOLVED_METHODOLOGY_REASON_CODES.has(code)) ||
    (METHODOLOGY_BLOCKED_ARCHETYPES.has(facts?.archetype) && reasonCodes.includes(METHODOLOGY_BLOCKED_RESIDUAL_REASON))
  );
}
function supplyBuckets(entries, keyOf, totalSupply) {
  const buckets = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    const bucket = buckets.get(key) ?? { count: 0, supplyUsd: 0 };
    bucket.count += 1;
    bucket.supplyUsd += entry.supplyUsd ?? 0;
    buckets.set(key, bucket);
  }
  return Object.fromEntries(
    [...buckets.entries()]
      .sort((left, right) => compareText(left[0], right[0]))
      .map(([key, bucket]) => [
        key,
        {
          count: bucket.count,
          supplyUsd: round(bucket.supplyUsd, 2),
          supplyShare: totalSupply > 0 ? round(bucket.supplyUsd / totalSupply) : null,
        },
      ]),
  );
}
function distributionGateMetrics(replay, rated, scoreQuartiles) {
  const cards = replay.pipeline.candidate.cards;
  const factsById = new Map(replay.pipeline.compiledFacts.assets.map((asset) => [asset.assetId, asset]));
  const ratedRows = rated.map((card) => ({
    card,
    supplyUsd: knownSupplyUsd(factsById.get(card.id)),
    floorCount: pillarsAtOrBelowFloor(card),
  }));
  const observed = ratedRows.filter((row) => row.supplyUsd !== null);
  const observedSupply = observed.reduce((sum, row) => sum + row.supplyUsd, 0);
  const bySupply = [...observed].sort(
    (left, right) => right.supplyUsd - left.supplyUsd || compareText(left.card.id, right.card.id),
  );
  const exTopRanks = bySupply.slice(MATERIAL_COHORT_EXCLUDED_TOP_RANKS);
  const exTopSupply = exTopRanks.reduce((sum, row) => sum + row.supplyUsd, 0);
  const exTopEvidenced = exTopRanks.filter((row) => row.floorCount === 0).reduce((sum, row) => sum + row.supplyUsd, 0);
  const nrSupplies = cards
    .filter((card) => card.grade === "NR")
    .map((card) => knownSupplyUsd(factsById.get(card.id)));
  const allNrSuppliesObserved = nrSupplies.every((supply) => supply !== null);
  const maxNrSupplyUsd =
    nrSupplies.length === 0
      ? 0
      : allNrSuppliesObserved
        ? round(Math.max(...nrSupplies), 2)
        : null;
  const fCards = rated.filter((card) => card.grade === "F");
  const unattributedF = fCards.filter((card) => !isMeasuredAdverseF(card));
  const unattributedFSupply = sumKnownSupplyUsdOrNull(
    unattributedF.map((card) => knownSupplyUsd(factsById.get(card.id))),
  );
  const freeFloating = rated.filter((card) => !card.caps.some((cap) => cap.binding));
  const freeFloatingBuckets = countsBy(freeFloating, (card) => String(card.score));
  const freeFloatingTuples = countsBy(
    freeFloating,
    (card) => `${card.pillars.backing.score}/${card.pillars.exit.score}/${card.pillars.control.score}`,
  );
  const freeFloatingShare = (entries) =>
    freeFloating.length > 0 && entries.length > 0 ? round(entries[0].count / freeFloating.length) : null;
  const materialCohort = bySupply
    .filter((row) => row.supplyUsd >= MATERIAL_COHORT_MIN_SUPPLY_USD)
    .map((row) => row.card);
  const atOrAbove = (grade) =>
    materialCohort.filter((card) => GRADE_ORDER.indexOf(card.grade) <= GRADE_ORDER.indexOf(grade)).length;
  const winsorizedWeights = observed.map((row) => ({
    row,
    weight: observedSupply > 0 ? Math.min(row.supplyUsd / observedSupply, WINSORIZED_WEIGHT_CAP) : 0,
  }));
  const winsorizedTotal = winsorizedWeights.reduce((sum, entry) => sum + entry.weight, 0);
  const winsorizedEvidenced = winsorizedWeights
    .filter((entry) => entry.row.floorCount === 0)
    .reduce((sum, entry) => sum + entry.weight, 0);
  return {
    gated: {
      materialEvidenceCoverageExTop2: exTopSupply > 0 ? round(exTopEvidenced / exTopSupply) : null,
      supplyObservationCoverage: rated.length > 0 ? round(observed.length / rated.length) : null,
      maxNrSupplyUsd,
      unattributedFCount: unattributedF.length,
      unattributedFSupplyShare:
        unattributedFSupply !== null && observedSupply > 0
          ? round(unattributedFSupply / observedSupply)
          : null,
      freeFloatingLargestBucketShare: freeFloatingShare(freeFloatingBuckets),
      freeFloatingLargestTupleShare: freeFloatingShare(freeFloatingTuples),
      materialCohortCMinusOrBetterShare: materialCohort.length > 0 ? round(atOrAbove("C-") / materialCohort.length) : null,
      materialCohortBMinusOrBetterCount: atOrAbove("B-"),
      scoreIqr: scoreQuartiles.iqr,
    },
    diagnostics: {
      observedSupplyUsd: round(observedSupply, 2),
      observedSupplyAssetCount: observed.length,
      freeFloatingCount: freeFloating.length,
      freeFloatingLargestBucket: freeFloatingBuckets[0] ?? null,
      freeFloatingLargestTuple: freeFloatingTuples[0] ?? null,
      materialCohortSize: materialCohort.length,
      unattributedFAssetIds: unattributedF.map((card) => card.id).sort(compareText),
      capLimitPinCounts: countsBy(
        rated.filter((card) => card.bindingCap !== null),
        (card) => String(card.bindingCap.limit),
      ),
      supplyShareByGradeBand: supplyBuckets(
        ratedRows,
        (row) => Object.keys(GRADE_BANDS).find((band) => GRADE_BANDS[band].includes(row.card.grade)) ?? "other",
        observedSupply,
      ),
      supplyShareByFloorState: supplyBuckets(ratedRows, (row) => String(row.floorCount), observedSupply),
      fCohortClassCounts: {
        a: fCards.filter((card) => isMeasuredAdverseF(card)).length,
        b: unattributedF.filter((card) => !isMethodologyBlockedF(card, factsById.get(card.id))).length,
        c: unattributedF.filter((card) => isMethodologyBlockedF(card, factsById.get(card.id))).length,
      },
      winsorizedEvidenceCoverage: winsorizedTotal > 0 ? round(winsorizedEvidenced / winsorizedTotal) : null,
    },
  };
}
export function distributionGates(metrics) {
  const atLeast = (value, minimum) => value !== null && value >= minimum;
  const atMost = (value, maximum) => value !== null && value <= maximum;
  return {
    d1MaterialEvidenceCoverageExTop2: atLeast(
      metrics.materialEvidenceCoverageExTop2,
      DISTRIBUTION_GATE_THRESHOLDS.materialEvidenceCoverageExTop2Min,
    ),
    d2aSupplyObservationCoverage: atLeast(
      metrics.supplyObservationCoverage,
      DISTRIBUTION_GATE_THRESHOLDS.supplyObservationCoverageMin,
    ),
    d2bMaxNrSupplyUsd: atMost(metrics.maxNrSupplyUsd, DISTRIBUTION_GATE_THRESHOLDS.maxNrSupplyUsd),
    d3aUnattributedFCount: atMost(metrics.unattributedFCount, DISTRIBUTION_GATE_THRESHOLDS.unattributedFCountMax),
    d3bUnattributedFSupplyShare: atMost(
      metrics.unattributedFSupplyShare,
      DISTRIBUTION_GATE_THRESHOLDS.unattributedFSupplyShareMax,
    ),
    d4aFreeFloatingLargestBucketShare: atMost(
      metrics.freeFloatingLargestBucketShare,
      DISTRIBUTION_GATE_THRESHOLDS.freeFloatingLargestBucketShareMax,
    ),
    d4bFreeFloatingLargestTupleShare: atMost(
      metrics.freeFloatingLargestTupleShare,
      DISTRIBUTION_GATE_THRESHOLDS.freeFloatingLargestTupleShareMax,
    ),
    d5aMaterialCohortCMinusOrBetterShare: atLeast(
      metrics.materialCohortCMinusOrBetterShare,
      DISTRIBUTION_GATE_THRESHOLDS.materialCohortCMinusOrBetterShareMin,
    ),
    d5bMaterialCohortBMinusOrBetterCount: atLeast(
      metrics.materialCohortBMinusOrBetterCount,
      DISTRIBUTION_GATE_THRESHOLDS.materialCohortBMinusOrBetterCountMin,
    ),
    d6ScoreIqr: atLeast(metrics.scoreIqr, DISTRIBUTION_GATE_THRESHOLDS.scoreIqrMin),
  };
}
export function summarizeDistribution(replay) {
  const cards = replay.pipeline.candidate.cards;
  const evaluatedById = new Map(replay.pipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));
  const rated = cards.filter((card) => card.grade !== "NR");
  const scores = rated.map((card) => card.score).sort((left, right) => left - right);
  const histogram = Object.fromEntries(
    GRADE_ORDER.map((grade) => [grade, cards.filter((card) => card.grade === grade).length]),
  );
  const pillarTuples = countsBy(
    rated,
    (card) => `${card.pillars.backing.score}/${card.pillars.exit.score}/${card.pillars.control.score}`,
  );
  const scoreBuckets = countsBy(rated, (card) => String(card.score));
  const totalSupply = cards.reduce(
    (sum, card) => sum + (evaluatedById.get(card.id)?.stressState?.exitPortfolio?.circulatingUsd ?? 0),
    0,
  );
  const ratedSupply = rated.reduce(
    (sum, card) => sum + (evaluatedById.get(card.id)?.stressState?.exitPortfolio?.circulatingUsd ?? 0),
    0,
  );
  const scoreQuartiles = {
    p25: quantile(scores, 0.25),
    p75: quantile(scores, 0.75),
    iqr: scores.length > 0 ? round(quantile(scores, 0.75) - quantile(scores, 0.25)) : null,
  };
  const rawLargestTupleShare = pillarTuples.length > 0 ? pillarTuples[0].count / rated.length : null;
  const rawLargestBucketShare = scoreBuckets.length > 0 ? scoreBuckets[0].count / rated.length : null;
  const gateMetrics = distributionGateMetrics(replay, rated, scoreQuartiles);
  return {
    expectedCount: cards.length,
    ratedCount: rated.length,
    nrIds: cards
      .filter((card) => card.grade === "NR")
      .map((card) => card.id)
      .sort(compareText),
    ratedSupplyShare: totalSupply > 0 ? ratedSupply / totalSupply : null,
    histogram,
    cMinusOrBetter: rated.filter((card) => GRADE_ORDER.indexOf(card.grade) <= GRADE_ORDER.indexOf("C-")).length,
    bMinusOrBetter: rated.filter((card) => GRADE_ORDER.indexOf(card.grade) <= GRADE_ORDER.indexOf("B-")).length,
    largestPillarTuple: pillarTuples[0] ?? null,
    largestPillarTupleShare: rawLargestTupleShare,
    largestScoreBucket: scoreBuckets[0] ?? null,
    largestScoreBucketShare: rawLargestBucketShare,
    scoreQuartiles,
    distributionMetrics: gateMetrics.gated,
    distributionDiagnostics: {
      ...gateMetrics.diagnostics,
      rawLargestBucketShare: rawLargestBucketShare === null ? null : round(rawLargestBucketShare),
      rawLargestTupleShare: rawLargestTupleShare === null ? null : round(rawLargestTupleShare),
      gradeHistogram: histogram,
    },
  };
}

export function uncertaintyLedger(replay) {
  const cards = replay.pipeline.candidate.cards;
  const evaluatedById = new Map(replay.pipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));
  const factsById = new Map(replay.pipeline.compiledFacts.assets.map((asset) => [asset.assetId, asset]));
  const rows = cards.map((card) => {
    const evaluated = evaluatedById.get(card.id);
    const facts = factsById.get(card.id);
    if (!evaluated || !facts) throw new Error(`Missing evaluated or compiled asset ${card.id}`);
    return {
      assetId: card.id,
      supplyUsd: evaluated.stressState?.exitPortfolio?.circulatingUsd ?? null,
      score: card.score,
      grade: card.grade,
      nextBoundary: card.grade === "NR" ? null : nextBoundary(card.score),
      distanceToNextBoundary: card.grade === "NR" ? null : nextBoundary(card.score) - card.score,
      evidenceLevel: card.evidence.level,
      pillars: Object.fromEntries(
        Object.entries(card.pillars).map(([pillar, value]) => [
          pillar,
          { score: value.score, evidence: value.evidenceLevel },
        ]),
      ),
      uncertainBackingComponents: evaluated.backing.contributions
        .filter((component) => component.observationState !== "known")
        .map((component) => ({
          componentKey: component.componentKey,
          source: component.source,
          score: component.score,
          scopeWeight: component.normalizedWeight,
          observationState: component.observationState,
        })),
      excludedOrUnscoredExitRoutes: evaluated.exit.routes
        .filter((route) => !route.included || route.score === null)
        .map((route) => ({ routeKey: route.routeKey, exclusionReason: route.exclusionReason })),
      conservativeControlComponents: evaluated.control.components
        .filter((component) => component.score <= 45 || component.posture.includes("unknown"))
        .map((component) => ({
          componentKey: component.componentKey,
          score: component.score,
          posture: component.posture,
        })),
      gaps: facts.gaps.map((gap) => ({
        gapId: gap.gapId,
        ownerDomain: gap.ownerDomain,
        reasonCode: gap.reasonCode,
        observationState: gap.observationState,
      })),
      caps: card.caps.map((cap) => ({ source: cap.source, kind: cap.kind, limit: cap.limit })),
    };
  });
  const bySupply = [...rows]
    .sort((left, right) => (right.supplyUsd ?? -1) - (left.supplyUsd ?? -1) || compareText(left.assetId, right.assetId))
    .slice(0, 80);
  const byFrontier = rows
    .filter((row) => row.distanceToNextBoundary !== null)
    .sort(
      (left, right) =>
        left.distanceToNextBoundary - right.distanceToNextBoundary ||
        (right.supplyUsd ?? -1) - (left.supplyUsd ?? -1) ||
        compareText(left.assetId, right.assetId),
    )
    .slice(0, 80);
  return { top80BySupply: bySupply, top80ByFrontier: byFrontier };
}

export function changesFromBaseline(baseline, candidate) {
  const beforeById = new Map(baseline.pipeline.candidate.cards.map((card) => [card.id, card]));
  return candidate.pipeline.candidate.cards
    .flatMap((card) => {
      const before = beforeById.get(card.id);
      if (!before || (before.score === card.score && before.grade === card.grade)) return [];
      return [
        {
          assetId: card.id,
          score: { from: before?.score ?? null, to: card.score, delta: before ? card.score - before.score : null },
          grade: { from: before?.grade ?? null, to: card.grade },
          pillars: Object.fromEntries(
            Object.keys(card.pillars).map((pillar) => [
              pillar,
              {
                from: before?.pillars[pillar]?.score ?? null,
                to: card.pillars[pillar].score,
                delta: before ? card.pillars[pillar].score - before.pillars[pillar].score : null,
              },
            ]),
          ),
          bindingCap: { from: before?.bindingCap ?? null, to: card.bindingCap },
        },
      ];
    })
    .sort((left, right) => compareText(left.assetId, right.assetId));
}
