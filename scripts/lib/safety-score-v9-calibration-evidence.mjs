import { compileV9FactSetV2, compileV9FactSetV3 } from "../../shared/lib/safety-score-v9/compile.ts";
import { evaluateV9FactSet } from "../../shared/lib/safety-score-v9/evaluate-set.ts";
import { V9_CANDIDATE_POLICY_V1 } from "../../shared/lib/safety-score-v9/policy.ts";
import { domainDigest } from "../../shared/lib/safety-score-v9/primitives.ts";
import {
  CALIBRATION_GRADE_POLICY,
  compareText,
  requireExactKeys,
  requireRecord,
  stableStringify,
  uniqueAssetIds,
} from "./safety-score-v9-calibration-core.mjs";
import { assertReplay, reproduceCandidateReplay } from "./safety-score-v9-calibration-replay.mjs";
const MAX_UNEXPLAINED_CAPTURE_MOVEMENT = 3;
function addEvidenceRefs(value, refs) {
  if (Array.isArray(value)) {
    for (const entry of value) addEvidenceRefs(entry, refs);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value.evidenceRefIds)) {
    for (const evidenceId of value.evidenceRefIds) refs.add(evidenceId);
  }
  for (const child of Object.values(value)) addEvidenceRefs(child, refs);
}
function scoreBearingEvidenceFreshness(evaluated, facts) {
  const refs = new Set(evaluated?.backing?.evidenceRefIds ?? []);
  for (const value of [facts?.implementation, facts?.dependencies, facts?.supply, facts?.peg]) {
    addEvidenceRefs(value, refs);
  }
  const routesByKey = new Map((facts?.exitRoutes ?? []).map((route) => [route.routeKey, route]));
  for (const route of evaluated?.exit?.routes ?? []) {
    if (route.included) addEvidenceRefs(routesByKey.get(route.routeKey), refs);
  }
  addEvidenceRefs(facts?.controlStatus, refs);
  addEvidenceRefs(facts?.economicControlReview, refs);
  const controlsByKey = new Map((facts?.controls ?? []).map((control) => [control.controlKey, control]));
  for (const component of evaluated?.control?.components ?? []) {
    for (const controlKey of component.controlKeys ?? []) addEvidenceRefs(controlsByKey.get(controlKey), refs);
  }
  const scoreReasonCodes = new Set([
    ...Object.values(evaluated?.scoreInput?.pillars ?? {}).flatMap((pillar) =>
      (pillar?.reasons ?? []).map((reason) => reason.code),
    ),
    ...(evaluated?.scoreInput?.peg?.reasons ?? []).map((reason) => reason.code),
    ...(evaluated?.scoreInput?.dependencyReasons ?? []).map((reason) => reason.code),
    ...(evaluated?.scoreInput?.methodologyReasons ?? []).map((reason) => reason.code),
  ]);
  for (const gap of facts?.gaps ?? []) {
    if (scoreReasonCodes.has(gap.reasonCode)) addEvidenceRefs(gap, refs);
  }
  const evidenceById = new Map((facts?.evidence ?? []).map((reference) => [reference.evidenceId, reference]));
  const missingIds = [...refs].filter((evidenceId) => !evidenceById.has(evidenceId)).sort(compareText);
  const noncurrentIds = [...refs]
    .filter((evidenceId) => {
      const reference = evidenceById.get(evidenceId);
      return reference && (reference.disposition === "rejected" || reference.freshness?.state !== "current");
    })
    .sort(compareText);
  return {
    referencedCount: refs.size,
    missingIds,
    noncurrentIds,
    passed: refs.size > 0 && missingIds.length === 0 && noncurrentIds.length === 0,
  };
}
function resolvedStatus(status) {
  return (
    status !== null &&
    typeof status === "object" &&
    status.observationState === "known" &&
    status.applicability?.state !== "unresolved"
  );
}
function custodyStatuses(review) {
  if (review === null || typeof review !== "object") return [];
  return Object.entries(review).flatMap(([key, value]) =>
    /custod/i.test(key) && value !== null && typeof value === "object" && "status" in value ? [value.status] : [],
  );
}
function isAssetWideControlReason(reason, facts) {
  if (reason?.pathKind === "local-component" || reason?.controlKey == null) return true;
  const control = (facts?.controls ?? []).find((entry) => entry.controlKey === reason.controlKey);
  return control === undefined || control.scope === "global";
}
function assetWideControlsResolved(evaluated, facts) {
  const economic = facts?.economicControlReview;
  const typedStatuses = [
    facts?.controlStatus,
    economic?.mint?.status,
    economic?.oracle?.status,
    ...(economic?.oracle?.branches ?? []).map((branch) => branch.status),
    economic?.bridge?.status,
    ...custodyStatuses(facts?.mechanismRiskReview?.review),
  ].filter((status) => status !== undefined);
  const typedStatusesResolved = typedStatuses.length > 0 && typedStatuses.every(resolvedStatus);
  const upgradeResolved = economic?.mint?.upgrade?.state !== "unknown";
  const unresolvedReasons = (evaluated?.control?.reasons ?? []).filter((reason) =>
    isAssetWideControlReason(reason, facts),
  );
  const profileGaps = (facts?.gaps ?? []).filter(
    (gap) => gap.reasonCode === "missing-custody-profile" || gap.reasonCode === "missing-oracle-profile",
  );
  return {
    unresolvedReasonCodes: [...new Set(unresolvedReasons.map((reason) => reason.code))].sort(compareText),
    unresolvedProfileGapCodes: [...new Set(profileGaps.map((gap) => gap.reasonCode))].sort(compareText),
    passed: typedStatusesResolved && upgradeResolved && unresolvedReasons.length === 0 && profileGaps.length === 0,
  };
}
export function evaluateRealACandidateChecks(card, evaluated, facts) {
  const realARange = CALIBRATION_GRADE_POLICY.ranges.A;
  const supply = evaluated?.stressState?.exitPortfolio?.circulatingUsd ?? 0;
  const hasExecutableDexRoute =
    evaluated?.exit?.routes?.some(
      (route) => route.included && route.routeKey.startsWith("dex:") && (route.capacityPoint?.executableUsd ?? 0) > 0,
    ) ?? false;
  const evidenceFreshness = scoreBearingEvidenceFreshness(evaluated, facts);
  const controls = assetWideControlsResolved(evaluated, facts);
  const checks = {
    gradeAndRange:
      card.grade === "A" &&
      card.score >= realARange.minScore &&
      card.score <= realARange.maxScore,
    positiveSupply: supply > 0,
    executableDexRoute: hasExecutableDexRoute,
    strongEvidence:
      evaluated?.scoreInput?.pillars !== undefined &&
      Object.values(evaluated.scoreInput.pillars).every((pillar) => pillar.evidenceLevel === "strong"),
    currentEvidence: evidenceFreshness.passed,
    assetWideControlsResolved: controls.passed,
  };
  return { checks, evidenceFreshness, controls, passed: Object.values(checks).every(Boolean) };
}
export function realACandidatesForReplay(replay) {
  const realARange = CALIBRATION_GRADE_POLICY.ranges.A;
  const evaluatedById = new Map(replay.pipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));
  const factsById = new Map(replay.pipeline.compiledFacts.assets.map((asset) => [asset.assetId, asset]));
  return replay.pipeline.candidate.cards
    .filter(
      (card) =>
        card.grade === "A" ||
        (card.score >= realARange.minScore && card.score <= realARange.maxScore),
    )
    .map((card) => ({
      assetId: card.id,
      score: card.score,
      grade: card.grade,
      ...evaluateRealACandidateChecks(card, evaluatedById.get(card.id), factsById.get(card.id)),
    }));
}
function captureInputIsFresh(replay) {
  const input = replay.pipeline.fixedInput;
  return (
    input.captureKind === "exact-publication-inputs" &&
    input.liquidityStale === false &&
    input.redemptionStale === false &&
    Object.values(input.inputFreshness ?? {}).every((freshness) => freshness?.stale !== true)
  );
}
export function captureMovements(captures) {
  const movements = [];
  for (let index = 1; index < captures.length; index += 1) {
    const before = captures[index - 1];
    const after = captures[index];
    const beforeById = new Map(before.pipeline.candidate.cards.map((card) => [card.id, card]));
    const beforeEvaluated = new Map(before.pipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));
    const afterEvaluated = new Map(after.pipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));
    for (const card of after.pipeline.candidate.cards) {
      const previous = beforeById.get(card.id);
      if (!previous) continue;
      const delta = card.score - previous.score;
      if (Math.abs(delta) <= MAX_UNEXPLAINED_CAPTURE_MOVEMENT) continue;
      movements.push({
        assetId: card.id,
        fromResultDigest: before.pipeline.candidate.resultDigest,
        toResultDigest: after.pipeline.candidate.resultDigest,
        fromScore: previous.score,
        toScore: card.score,
        delta,
        scoreBearingInputChanged: compareScoreBearingInputs(beforeEvaluated.get(card.id), afterEvaluated.get(card.id))
          .changed,
      });
    }
  }
  return movements.sort(
    (left, right) =>
      compareText(left.fromResultDigest, right.fromResultDigest) || compareText(left.assetId, right.assetId),
  );
}
export function repeatedRealAAssetIds(candidateRealAIds, qualifyingByCapture) {
  if (qualifyingByCapture.length !== 3) return [];
  return [...candidateRealAIds]
    .filter((assetId) => qualifyingByCapture.every((assetIds) => assetIds.includes(assetId)))
    .sort(compareText);
}
export function validateFreshCaptureSeries(values, candidateAssetIds, candidateRealAIds) {
  const captures = Array.isArray(values) ? values : [];
  for (const [index, capture] of captures.entries()) {
    assertReplay(capture, `fresh capture ${index + 1}`);
    reproduceCandidateReplay(capture, `fresh capture ${index + 1}`);
  }
  const ordered = [...captures].sort(
    (left, right) => left.pipeline.fixedInput.clockSec - right.pipeline.fixedInput.clockSec,
  );
  const baseIds = ordered.map((capture) => capture.pipeline.fixedInput.baseInputGenerationId);
  const sourceGenerations = ordered.map((capture) => capture.pipeline.fixedInput.sourceGeneration);
  const clocks = ordered.map((capture) => capture.pipeline.fixedInput.clockSec);
  const identitiesMatch =
    ordered.length > 0 &&
    ordered.every(
      (capture) =>
        stableStringify(capture.pipeline.candidateIdentity) === stableStringify(ordered[0].pipeline.candidateIdentity),
    );
  const expectedAssetSet = stableStringify([...candidateAssetIds].sort(compareText));
  const assetSetsMatch =
    ordered.length > 0 &&
    ordered.every(
      (capture) =>
        stableStringify([...capture.pipeline.fixedInput.activeAssetIds].sort(compareText)) === expectedAssetSet,
    );
  const distinctAndOrdered =
    new Set(baseIds).size === 3 &&
    new Set(sourceGenerations).size === 3 &&
    new Set(clocks).size === 3 &&
    clocks.every((clock, index) => index === 0 || clocks[index - 1] < clock);
  const qualifyingByCapture = ordered.map((capture) =>
    realACandidatesForReplay(capture)
      .filter((entry) => entry.passed)
      .map((entry) => entry.assetId),
  );
  const repeatedRealAIds = repeatedRealAAssetIds(candidateRealAIds, qualifyingByCapture);
  return {
    providedCount: captures.length,
    ordered,
    baseInputGenerationIds: baseIds,
    resultDigests: ordered.map((capture) => capture.pipeline.candidate.resultDigest),
    distinctAndOrdered,
    identitiesMatch,
    assetSetsMatch,
    allInputsFresh: ordered.length === 3 && ordered.every(captureInputIsFresh),
    repeatedRealAIds,
    movementsOverThree: captureMovements(ordered),
  };
}
export function qualifyingCompositeCards(cards) {
  if (!Array.isArray(cards)) throw new Error("composite cards must be an array");
  const compositeMinimum = CALIBRATION_GRADE_POLICY.ranges["A+"].minScore;
  return cards
    .filter((card) => card.grade === "A+" && card.score >= compositeMinimum)
    .map((card) => ({ assetId: card.id, score: card.score, grade: card.grade }));
}
export function evaluateCompositeReplay(replay) {
  if (replay === undefined) return { provided: false, qualifyingCards: [], passed: false };
  assertReplay(replay, "composite");
  reproduceCandidateReplay(replay, "composite");
  const qualifyingCards = qualifyingCompositeCards(replay.pipeline.candidate.cards);
  return { provided: true, qualifyingCards, passed: qualifyingCards.length > 0 };
}
function currentSemanticsCounterfactual(baseline) {
  const { v9FactSetDigest: _historicalDigest, ...core } = baseline.pipeline.compiledFacts;
  const compiled =
    core.schemaVersion === 3
      ? compileV9FactSetV3(core)
      : core.schemaVersion === 2
        ? compileV9FactSetV2(core)
        : (() => {
            throw new Error("baseline compiled facts has an unsupported schema version");
          })();
  return evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1);
}
function projectedStructuralSignal(signal) {
  return {
    kind: signal.kind,
    severity: signal.severity,
    materialSharePct: signal.materialSharePct ?? null,
    failureDomainKeys: [...new Set(signal.failureDomainKeys ?? [])].sort(compareText),
  };
}
export function projectScoreBearingCalibrationInput(evaluatedAsset) {
  const scoreInput = requireRecord(evaluatedAsset?.scoreInput, "evaluated asset score input");
  const pillars = requireRecord(scoreInput.pillars, "evaluated asset pillars");
  const peg = requireRecord(scoreInput.peg, "evaluated asset peg input");
  const parent = requireRecord(scoreInput.parent, "evaluated asset parent input");
  const evidenceRank = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.rank;
  const evidenceLevel = ["backing", "exit", "control"]
    .map((pillar) => requireRecord(pillars[pillar], `${pillar} pillar`).evidenceLevel)
    .sort((left, right) => evidenceRank[right] - evidenceRank[left])[0];
  const reasonCodes = [
    ...["backing", "exit", "control"].flatMap(
      (pillar) => requireRecord(pillars[pillar], `${pillar} pillar`).reasons ?? [],
    ),
    ...(peg.reasons ?? []),
    ...(scoreInput.dependencyReasons ?? []),
    ...(scoreInput.methodologyReasons ?? []),
  ].map((reason) => reason.code);
  const structuralSignals = [
    ...["backing", "exit", "control"].flatMap(
      (pillar) => requireRecord(pillars[pillar], `${pillar} pillar`).structuralSignals ?? [],
    ),
    ...(scoreInput.dependencyStructuralSignals ?? []),
  ]
    .map(projectedStructuralSignal)
    .sort((left, right) => compareText(stableStringify(left), stableStringify(right)));
  return {
    pillars: Object.fromEntries(
      ["backing", "exit", "control"].map((pillar) => [
        pillar,
        requireRecord(pillars[pillar], `${pillar} pillar`).score,
      ]),
    ),
    pegApplicable: peg.applicable,
    pegScore: peg.score,
    activeDepegBps: peg.activeDepegBps,
    evidenceLevel,
    trackRecordMonths: scoreInput.trackRecordMonths,
    parentRequired: parent.required,
    parentScore: parent.score,
    structuralSignals,
    unresolvedReasonCodes: [...new Set(reasonCodes)].sort(compareText),
  };
}
function compareScoreBearingInputs(before, after) {
  const baseline = projectScoreBearingCalibrationInput(before);
  const candidate = projectScoreBearingCalibrationInput(after);
  const changedFields = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])]
    .filter((field) => stableStringify(baseline[field]) !== stableStringify(candidate[field]))
    .sort(compareText);
  return {
    changed: changedFields.length > 0,
    changedFields,
    baselineDigest: domainDigest("safety-score-v9.calibration-score-input.v1", baseline),
    candidateDigest: domainDigest("safety-score-v9.calibration-score-input.v1", candidate),
  };
}
export function causalDecomposition(baseline, candidate, changes) {
  try {
    const counterfactual = currentSemanticsCounterfactual(baseline);
    const counterfactualById = new Map(counterfactual.assets.map((asset) => [asset.assetId, asset]));
    const candidateById = new Map(candidate.pipeline.evaluatedSet.assets.map((asset) => [asset.assetId, asset]));
    const semanticIdentityChanged =
      baseline.pipeline.candidateIdentity.policyDigest !== candidate.pipeline.candidateIdentity.policyDigest ||
      baseline.pipeline.candidateIdentity.evaluationBuildDigest !==
        candidate.pipeline.candidateIdentity.evaluationBuildDigest;
    const globalFactSetChanged =
      baseline.pipeline.compiledFacts.v9FactSetDigest !== candidate.pipeline.compiledFacts.v9FactSetDigest;
    const improvements = changes
      .filter((change) => change.score.delta > 0)
      .map((change) => {
        const counterfactualAsset = counterfactualById.get(change.assetId);
        const candidateAsset = candidateById.get(change.assetId);
        const counterfactualScore = counterfactualAsset?.trace.finalScore;
        const semanticDelta = counterfactualScore === undefined ? null : counterfactualScore - change.score.from;
        const factDelta = counterfactualScore === undefined ? null : change.score.to - counterfactualScore;
        const scoreBearingInput =
          counterfactualAsset && candidateAsset
            ? compareScoreBearingInputs(counterfactualAsset, candidateAsset)
            : {
                changed: false,
                changedFields: [],
                baselineDigest: null,
                candidateDigest: null,
              };
        const causes = [
          ...(semanticDelta !== null && semanticDelta > 0 && semanticIdentityChanged
            ? ["cohort-wide-semantic-correction"]
            : []),
          ...(factDelta !== null && factDelta > 0 && scoreBearingInput.changed ? ["new-score-bearing-fact"] : []),
        ];
        return {
          assetId: change.assetId,
          baselineScore: change.score.from,
          currentSemanticsOnBaselineFacts: counterfactualScore ?? null,
          candidateScore: change.score.to,
          semanticDelta,
          factDelta,
          scoreBearingInput,
          causes,
          valid:
            counterfactualScore !== undefined && semanticDelta + factDelta === change.score.delta && causes.length > 0,
        };
      });
    return {
      available: true,
      semanticIdentityChanged,
      globalFactSetChanged,
      improvements,
      passed: improvements.length > 0 && improvements.every((entry) => entry.valid),
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      semanticIdentityChanged: false,
      globalFactSetChanged: false,
      improvements: [],
      passed: false,
    };
  }
}
function requireEvidenceRefs(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} evidenceRefs must be nonempty`);
  return uniqueAssetIds(value, `${label} evidenceRefs`);
}

export function validateCausalAttribution(input, baseline, candidate, decomposition, movements) {
  if (input === undefined) return { provided: false, explainedMovementKeys: new Set(), passed: false };
  const value = requireExactKeys(
    input,
    ["schemaVersion", "kind", "baselineResultDigest", "candidateResultDigest", "improvements", "captureMovements"],
    "causal attribution",
  );
  if (value.schemaVersion !== 1 || value.kind !== "safety-score-v9-friday-causal-attribution") {
    throw new Error("causal attribution has an unsupported schema or kind");
  }
  if (
    value.baselineResultDigest !== baseline.pipeline.candidate.resultDigest ||
    value.candidateResultDigest !== candidate.pipeline.candidate.resultDigest
  ) {
    throw new Error("causal attribution does not bind the analyzed baseline and candidate results");
  }
  if (!Array.isArray(value.improvements) || !Array.isArray(value.captureMovements)) {
    throw new Error("causal attribution rows must be arrays");
  }
  const expectedById = new Map(decomposition.improvements.map((entry) => [entry.assetId, entry]));
  const seenImprovementIds = new Set();
  let improvementsValid = value.improvements.length === expectedById.size;
  for (const raw of value.improvements) {
    const row = requireExactKeys(raw, ["assetId", "cause", "summary", "evidenceRefs"], "improvement attribution");
    if (typeof row.assetId !== "string" || seenImprovementIds.has(row.assetId)) {
      throw new Error("improvement attribution asset IDs must be unique strings");
    }
    seenImprovementIds.add(row.assetId);
    if (typeof row.summary !== "string" || row.summary.trim().length === 0) {
      throw new Error(`improvement attribution ${row.assetId} requires a summary`);
    }
    requireEvidenceRefs(row.evidenceRefs, `improvement attribution ${row.assetId}`);
    const expected = expectedById.get(row.assetId);
    const expectedCause = expected?.causes.length === 2 ? "both" : expected?.causes[0];
    if (!expected?.valid || row.cause !== expectedCause) improvementsValid = false;
  }
  if ([...expectedById.keys()].some((assetId) => !seenImprovementIds.has(assetId))) improvementsValid = false;

  const movementKey = (row) => `${row.fromResultDigest}\u0000${row.toResultDigest}\u0000${row.assetId}`;
  const expectedMovements = new Map(movements.map((entry) => [movementKey(entry), entry]));
  const explainedMovementKeys = new Set();
  let movementsValid = value.captureMovements.length === expectedMovements.size;
  for (const raw of value.captureMovements) {
    const row = requireExactKeys(
      raw,
      ["assetId", "fromResultDigest", "toResultDigest", "summary", "evidenceRefs"],
      "capture movement attribution",
    );
    if (typeof row.summary !== "string" || row.summary.trim().length === 0) {
      throw new Error(`capture movement attribution ${row.assetId} requires a summary`);
    }
    requireEvidenceRefs(row.evidenceRefs, `capture movement attribution ${row.assetId}`);
    const key = movementKey(row);
    if (explainedMovementKeys.has(key)) throw new Error("capture movement attributions must be unique");
    explainedMovementKeys.add(key);
    if (!expectedMovements.get(key)?.scoreBearingInputChanged) movementsValid = false;
  }
  if ([...expectedMovements.keys()].some((key) => !explainedMovementKeys.has(key))) movementsValid = false;
  return {
    provided: true,
    improvementRows: value.improvements.length,
    captureMovementRows: value.captureMovements.length,
    explainedMovementKeys,
    passed: decomposition.passed && improvementsValid && movementsValid,
  };
}

