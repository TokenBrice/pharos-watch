import { GRADE_ORDER, stableStringify } from "./safety-score-v9-calibration-core.mjs";
import {
  assertReplay,
  CALIBRATION_BASELINE,
  reproduceCandidateReplay,
} from "./safety-score-v9-calibration-replay.mjs";
import {
  changesFromBaseline,
  distributionGates,
  summarizeDistribution,
  uncertaintyLedger,
} from "./safety-score-v9-calibration-metrics.mjs";
import {
  causalDecomposition,
  evaluateCompositeReplay,
  realACandidatesForReplay,
  validateCausalAttribution,
  validateFreshCaptureSeries,
} from "./safety-score-v9-calibration-evidence.mjs";
const ADVERSE_IDS = Object.keys(CALIBRATION_BASELINE.adverseCards);
const EXPECTED_BASELINE = CALIBRATION_BASELINE.distribution;
const EXPECTED_ADVERSE_BASELINE = new Map(Object.entries(CALIBRATION_BASELINE.adverseCards));
const EXPECTED_BASELINE_BINDINGS = CALIBRATION_BASELINE.bindings;
function baselineMatchesContract(distribution, cards, replay) {
  const anchor = EXPECTED_BASELINE.anchorCard;
  const anchorCard = cards.find((card) => card.id === anchor.assetId);
  return (
    distribution.expectedCount === EXPECTED_BASELINE.expectedCount &&
    distribution.ratedCount === EXPECTED_BASELINE.ratedCount &&
    JSON.stringify(distribution.nrIds) === JSON.stringify(EXPECTED_BASELINE.nrIds) &&
    JSON.stringify(distribution.histogram) === JSON.stringify(EXPECTED_BASELINE.histogram) &&
    JSON.stringify(distribution.largestPillarTuple) === JSON.stringify(EXPECTED_BASELINE.largestPillarTuple) &&
    JSON.stringify(distribution.largestScoreBucket) === JSON.stringify(EXPECTED_BASELINE.largestScoreBucket) &&
    distribution.scoreQuartiles.iqr === EXPECTED_BASELINE.scoreIqr &&
    anchorCard?.score === anchor.score &&
    anchorCard.grade === anchor.grade &&
    stableStringify(replay.pipeline.candidateIdentity) ===
      stableStringify(EXPECTED_BASELINE_BINDINGS.candidateIdentity) &&
    replay.pipeline.candidate.candidateId === EXPECTED_BASELINE_BINDINGS.candidateId &&
    replay.pipeline.fixedInput.baseInputGenerationId === EXPECTED_BASELINE_BINDINGS.baseInputGenerationId &&
    replay.pipeline.fixedInput.sourceGeneration === EXPECTED_BASELINE_BINDINGS.sourceGeneration &&
    replay.pipeline.fixedInput.registryFingerprint === EXPECTED_BASELINE_BINDINGS.registryFingerprint &&
    replay.pipeline.candidate.factSetDigest === EXPECTED_BASELINE_BINDINGS.factSetDigest &&
    replay.pipeline.candidate.resultDigest === EXPECTED_BASELINE_BINDINGS.resultDigest
  );
}
export function analyzeV9Calibration(baseline, candidate, fridayEvidence = {}) {
  assertReplay(baseline, "baseline");
  assertReplay(candidate, "candidate");
  reproduceCandidateReplay(candidate, "candidate");
  const baselineDistribution = summarizeDistribution(baseline);
  const distribution = summarizeDistribution(candidate);
  const candidateById = new Map(candidate.pipeline.candidate.cards.map((card) => [card.id, card]));
  const baselineById = new Map(baseline.pipeline.candidate.cards.map((card) => [card.id, card]));
  const realACandidates = realACandidatesForReplay(candidate);
  const realA = realACandidates.filter((candidate) => candidate.passed);
  const adverseControls = ADVERSE_IDS.map((assetId) => {
    const before = baselineById.get(assetId);
    const after = candidateById.get(assetId);
    const expected = EXPECTED_ADVERSE_BASELINE.get(assetId);
    return {
      assetId,
      baseline: before ? { score: before.score, grade: before.grade } : null,
      candidate: after ? { score: after.score, grade: after.grade } : null,
      baselineLocked: before?.score === expected?.score && before?.grade === expected?.grade,
      lifted:
        before && after
          ? after.score > before.score ||
            (after.score === before.score && GRADE_ORDER.indexOf(after.grade) < GRADE_ORDER.indexOf(before.grade))
          : true,
    };
  });
  const sameInput =
    baseline.pipeline.fixedInput.baseInputGenerationId === candidate.pipeline.fixedInput.baseInputGenerationId &&
    baseline.pipeline.fixedInput.sourceGeneration === candidate.pipeline.fixedInput.sourceGeneration &&
    baseline.pipeline.fixedInput.registryFingerprint === candidate.pipeline.fixedInput.registryFingerprint;
  const changes = changesFromBaseline(baseline, candidate);
  const captureSeries = validateFreshCaptureSeries(
    fridayEvidence.freshCaptures,
    candidate.pipeline.fixedInput.activeAssetIds,
    realA.map((entry) => entry.assetId),
  );
  const composite = evaluateCompositeReplay(fridayEvidence.composite);
  const decomposition = causalDecomposition(baseline, candidate, changes);
  const attribution = validateCausalAttribution(
    fridayEvidence.causalAttribution,
    baseline,
    candidate,
    decomposition,
    captureSeries.movementsOverThree,
  );
  const movementKey = (row) => `${row.fromResultDigest}\u0000${row.toResultDigest}\u0000${row.assetId}`;
  const unexplainedMovements = captureSeries.movementsOverThree.filter(
    (movement) => !attribution.explainedMovementKeys.has(movementKey(movement)),
  );
  const threeFreshCaptures =
    captureSeries.providedCount === 3 &&
    captureSeries.distinctAndOrdered &&
    captureSeries.identitiesMatch &&
    captureSeries.assetSetsMatch &&
    captureSeries.allInputsFresh;
  const gates = {
    candidateReproduced: true,
    baselineLocked:
      baselineMatchesContract(baselineDistribution, baseline.pipeline.candidate.cards, baseline) &&
      adverseControls.every((control) => control.baselineLocked),
    sameInput,
    coverage:
      distribution.ratedCount === EXPECTED_BASELINE.ratedCount &&
      distribution.expectedCount === EXPECTED_BASELINE.expectedCount &&
      JSON.stringify(distribution.nrIds) === JSON.stringify(baselineDistribution.nrIds) &&
      distribution.ratedSupplyShare !== null &&
      distribution.ratedSupplyShare >= 0.9999,
    realA: realA.length > 0,
    ...distributionGates(distribution.distributionMetrics),
    adverseControlsUnchanged: adverseControls.every((control) => !control.lifted),
    compositeAPlus: composite.passed,
    threeFreshCaptures,
    repeatedRealA: threeFreshCaptures && captureSeries.repeatedRealAIds.length > 0,
    captureStability: threeFreshCaptures && unexplainedMovements.length === 0,
    causalAttribution: attribution.passed,
  };
  return {
    schemaVersion: 1,
    kind: "safety-score-v9-real-a-calibration-analysis",
    identities: {
      baseline: baseline.pipeline.candidateIdentity,
      candidate: candidate.pipeline.candidateIdentity,
    },
    baseline: baselineDistribution,
    candidate: distribution,
    gates: { ...gates, allPassed: Object.values(gates).every(Boolean) },
    realA: realA.map(({ assetId, score, grade }) => ({ assetId, score, grade })),
    realACandidates,
    adverseControls,
    changes,
    fridayEvidence: {
      composite,
      freshCaptures: {
        providedCount: captureSeries.providedCount,
        baseInputGenerationIds: captureSeries.baseInputGenerationIds,
        resultDigests: captureSeries.resultDigests,
        distinctAndOrdered: captureSeries.distinctAndOrdered,
        identitiesMatch: captureSeries.identitiesMatch,
        assetSetsMatch: captureSeries.assetSetsMatch,
        allInputsFresh: captureSeries.allInputsFresh,
        repeatedRealAIds: captureSeries.repeatedRealAIds,
        movementsOverThree: captureSeries.movementsOverThree,
        unexplainedMovements,
      },
      causalAttribution: {
        provided: attribution.provided,
        improvementRows: attribution.improvementRows ?? 0,
        captureMovementRows: attribution.captureMovementRows ?? 0,
        passed: attribution.passed,
        decomposition,
      },
    },
    uncertaintyLedger: uncertaintyLedger(candidate),
  };
}
