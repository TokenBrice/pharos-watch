import type { V9AssetFactsBase } from "../../../types/safety-score-v9-facts";
import type { V9MechanismRiskReview } from "../../../types/safety-score-v9-backing";
import { clampScore } from "../../math";
import { sha256Hex } from "../../sha256";
import { stableJsonStringifyV1 } from "../../stable-json";
import { evaluateV9ReserveExposures } from "../backing";
import { verifiedLiveInheritedExposure } from "../backing-inheritance";
import {
  assertV9BackingPolicy,
  backingPolicy,
  createV9BackingStructuralReason,
  gapReasons,
  SCORE_EPSILON,
  normalizeV9BackingContribution,
  v9BackingStatusCause,
  type V9ArchetypeBackingInput,
  type V9BackingAssetInput,
  type V9BackingContribution,
  type V9BackingEvaluationPolicy,
  type V9BackingResult,
  type V9EffectiveBackingContribution,
} from "../backing-primitives";
import { resolveV9ReasonTreatment } from "../policy";
import { createV9GapIndex } from "../gap-index";
import { canonicalDomains, canonicalUniqueBy, compareText, uniqueSorted } from "../primitives";

function effectiveBackingContributions(
  contributions: readonly V9BackingContribution[],
  reserveGroupWeight: number,
  mechanismGroupWeight: number,
  concentrationWeight: number,
): V9EffectiveBackingContribution[] {
  const hasConcentrationComponent = contributions.some(
    contribution => contribution.source === "reserve-concentration" && contribution.score !== null,
  );
  const hasReserveQuality = contributions.some(
    contribution => contribution.source !== "reserve-concentration" && contribution.source !== "mechanism" && contribution.score !== null,
  );
  const qualityGroupWeight = hasReserveQuality ? hasConcentrationComponent ? 1 - concentrationWeight : 1 : 0;
  const includedReserveWeight = qualityGroupWeight + (hasConcentrationComponent ? concentrationWeight : 0);
  return contributions.map((row) => {
    const contribution = normalizeV9BackingContribution(row);
    const effectiveWeight =
      contribution.source === "mechanism"
        ? contribution.effectiveScoringWeight * mechanismGroupWeight
        : contribution.source === "reserve-concentration"
          ? contribution.effectiveScoringWeight * reserveGroupWeight / (includedReserveWeight || 1)
          : contribution.effectiveScoringWeight * qualityGroupWeight /
            (includedReserveWeight || 1) * reserveGroupWeight;
    return { ...contribution, effectiveWeight, effectiveScoringWeight: effectiveWeight };
  });
}

function finalizeBackingResult(result: Omit<V9BackingResult, "traceDigest" | "aggregationDisposition" |
  "causeGapIds" | "limitedEvidenceCauses" | "supportedComponentKeys">): V9BackingResult {
  const unresolved = canonicalUniqueBy(
    result.unresolved.map((reason) => ({ ...reason, gapIds: uniqueSorted(reason.gapIds) })),
    (reason) =>
      [
        reason.code,
        reason.pathKey,
        reason.treatment,
        reason.gapIds.join(","),
        reason.causalKey ?? "",
        reason.responsibility ?? "",
      ].join("\u0000"),
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.pathKey, right.pathKey) ||
      compareText(left.causalKey ?? "", right.causalKey ?? "") ||
      compareText(left.responsibility ?? "", right.responsibility ?? ""),
    "last",
  );
  const canonical = {
    ...result,
    aggregationDisposition: result.score === null && result.rateability === "rateable" ? "excluded-a-b" as const : "included" as const,
    causeGapIds: uniqueSorted(result.contributions.flatMap(row => row.causeGapIds)),
    limitedEvidenceCauses: uniqueSorted(result.contributions.flatMap(row => row.effectiveScoringWeight > 0 ? [
      ...(row.score !== null && (row.cause === "C" || row.cause === "U" || row.cause === "D") ? [row.cause] : []),
      ...(row.factors ?? []).flatMap(factor => factor.score !== null && factor.effectiveScoringWeight > 0 &&
        (factor.cause === "C" || factor.cause === "U" || factor.cause === "D") ? [factor.cause] : []),
    ] : [])),
    supportedComponentKeys: uniqueSorted(result.contributions.filter(row => row.score !== null && row.effectiveScoringWeight > 0).map(row => row.componentKey)),
    contributions: [...result.contributions].sort((left, right) => compareText(left.componentKey, right.componentKey)),
    structuralReasons: [...result.structuralReasons].sort((left, right) =>
      compareText(`${left.kind}:${left.severity}:${left.pathKey}`, `${right.kind}:${right.severity}:${right.pathKey}`),
    ),
    unresolved,
    evidenceRefIds: uniqueSorted([
      ...result.evidenceRefIds,
      ...(result.collateralizationApplications ?? []).flatMap((application) => application.evidenceRefIds),
    ]),
    failureDomains: canonicalDomains(result.failureDomains),
  };
  return {
    ...canonical,
    traceDigest: sha256Hex(stableJsonStringifyV1({ domain: "safety-score-v9.backing-trace.v1", trace: canonical })),
  };
}

/**
 * Reserve composition identifies the assets, not how much liability they cover.
 * Price the measured uncovered share at zero after either local evaluation or
 * parent-quality inheritance; existing reserve/mechanism quality stays visible.
 */
export function applyV9MeasuredCollateralization(
  result: V9BackingResult,
  measurement: V9MechanismRiskReview["collateralizationMeasurement"],
  policy: V9BackingEvaluationPolicy,
  asOfSec?: number,
): V9BackingResult {
  if (
    measurement == null ||
    measurement.ratio >= 1 ||
    result.score === null ||
    measurement.status.observationState !== "known" ||
    measurement.status.applicability.state !== "required" ||
    measurement.status.evidenceRefIds.length === 0 ||
    measurement.measuredAt == null ||
    asOfSec === undefined ||
    !Number.isFinite(asOfSec)
  ) return result;
  const measuredAtSec = Date.parse(`${measurement.measuredAt}T00:00:00.000Z`) / 1_000;
  const maxAgeSec = policy.policy.semantic.evidence.evidenceExpiry.mechanismOverlayMaxAgeSec;
  if (
    !Number.isFinite(measuredAtSec) ||
    measuredAtSec + 86_400 > asOfSec ||
    measuredAtSec + maxAgeSec <= asOfSec ||
    result.collateralizationApplications?.some(
      (application) => application.measurementId === measurement.measurementId,
    )
  ) return result;
  const ratio = measurement.ratio;
  const score = result.score * ratio;
  const evidenceRefIds = measurement.status.evidenceRefIds;
  const { traceDigest: _traceDigest, ...trace } = result;
  return finalizeBackingResult({
    ...trace,
    score,
    pillarCeiling: Math.min(result.pillarCeiling ?? score, score),
    collateralizationApplications: [
      ...(result.collateralizationApplications ?? []),
      {
        measurementId: measurement.measurementId,
        measuredAt: measurement.measuredAt,
        ratio,
        evidenceRefIds,
        appliedByAssetId: result.assetId,
        inheritedFromAssetId: null,
      },
    ],
    contributions: [
      ...result.contributions.map(row => ({
        ...row, effectiveWeight: row.effectiveWeight * ratio,
        effectiveScoringWeight: row.effectiveScoringWeight * ratio,
      })),
      normalizeV9BackingContribution({
        componentKey: "mechanism:uncovered-liability", source: "mechanism", score: 0,
        normalizedWeight: 1, weightedScore: 0, effectiveWeight: 1 - ratio,
        effectiveScoringWeight: 1 - ratio, observationState: "known", provenance: null,
        evidenceRefIds, failureDomains: [], upstreamAssetId: null,
        cause: "D", causeGapIds: [], scoringDisposition: "measured-adverse",
      }) as V9EffectiveBackingContribution,
    ],
    structuralReasons: [
      ...result.structuralReasons,
      {
        kind: "unsafe-backing",
        severity: "critical",
        responsibility: "measured-adverse",
        pathKey: "mechanism:collateralization-ratio",
        materialShare: 1 - ratio,
        ceiling: score,
        evidenceRefIds,
        failureDomains: [],
      },
    ],
    evidenceRefIds: [...result.evidenceRefIds, ...evidenceRefIds],
  });
}

// Only the whole-review fallback may price missing serial components locally;
// an authored partial review remains fail-closed for the same missing claim.
type V9ArchetypeBackingEvaluationMode = "reviewed" | "bounded-whole-review-absence";

function evaluateV9ArchetypeBackingInternal(
  input: V9ArchetypeBackingInput,
  policy: V9BackingEvaluationPolicy,
  mode: V9ArchetypeBackingEvaluationMode,
): V9BackingResult {
  const backing = backingPolicy(policy);
  const gapIndex = input.asset.gapIndex ?? createV9GapIndex(input.asset.gaps);
  const archetypePolicy = backing.archetypes[input.archetype];
  const expectedKeys = Object.keys(archetypePolicy.componentWeights).sort(compareText);
  const actualKeys = input.components.map((component) => component.componentKey).sort(compareText);
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`Safety Score v9 ${input.archetype} mechanism component contract does not match policy`);
  }

  const reserve = evaluateV9ReserveExposures(
    input.asset.gapIndex === undefined
      ? { ...input.asset, gapIndex }
      : input.asset,
    policy,
  );
  // Carry only applications actually embedded in inherited reserve quality,
  // not a parent measurement attached to an unused inheritance candidate.
  const inherited = input.asset.inheritedStablecoinBacking;
  const inheritedApplications =
    inherited !== undefined && reserve.contributions.some(
      (contribution) => contribution.componentKey === `reserve:inherited-backing:${inherited.parentAssetId}`,
    )
      ? inherited.collateralizationApplications?.map((application) => ({
          ...application,
          inheritedFromAssetId: inherited.parentAssetId,
        }))
      : undefined;
  const verifiedLiveInheritance =
    input.asset.inheritedStablecoinBacking === undefined
      ? undefined
      : verifiedLiveInheritedExposure(input.asset, input.asset.inheritedStablecoinBacking);
  if (
    archetypePolicy.allowCompleteLiveParentMechanismBypass &&
    verifiedLiveInheritance !== undefined &&
    reserve.contributions.some(
      (contribution) =>
        contribution.componentKey ===
        `reserve:inherited-backing:${input.asset.inheritedStablecoinBacking!.parentAssetId}`,
    )
  ) {
    return finalizeBackingResult({
      assetId: input.asset.assetId,
      archetype: input.archetype,
      policyId: policy.policy.policyId,
      policySemanticDigest: policy.semanticDigest,
      rateability: reserve.rateability,
      score: reserve.score,
      ...(inheritedApplications === undefined ? {} : { collateralizationApplications: inheritedApplications }),
      pillarCeiling:
        reserve.structuralReasons.length === 0
          ? null
          : Math.min(...reserve.structuralReasons.map((reason) => reason.ceiling)),
      contributions: effectiveBackingContributions(
        reserve.contributions,
        1,
        0,
        backing.reserve.concentrationWeight,
      ),
      structuralReasons: reserve.structuralReasons,
      unresolved: reserve.unresolved,
      evidenceRefIds: reserve.contributions.flatMap((contribution) => contribution.evidenceRefIds),
      failureDomains: reserve.contributions.flatMap((contribution) => contribution.failureDomains),
    });
  }
  const contributions = [...reserve.contributions];
  const unresolved = [...reserve.unresolved];
  const structuralReasons = [...reserve.structuralReasons, ...(input.additionalStructuralReasons ?? [])];
  const rateability = reserve.rateability;

  const applicableComponents = input.components.filter(
    (component) => component.fact.status.applicability.state !== "not-applicable",
  );
  const applicableComponentPolicyWeight = applicableComponents.reduce(
    (sum, component) => sum + archetypePolicy.componentWeights[component.componentKey], 0,
  );
  let mechanismWeightedScore = 0;
  let includedMechanismWeight = 0;
  for (const component of applicableComponents.sort((left, right) => compareText(left.componentKey, right.componentKey))) {
    const pathKey = `mechanism:${component.componentKey}`;
    const serial = archetypePolicy.serialComponentKeys.includes(component.componentKey);
    if (component.fact.scopedAssessments != null && (component.componentKey !== "assurance-and-reconciliation" ||
      (input.archetype !== "fiat-cash" && input.archetype !== "commodity-claim"))) {
      throw new Error("Scoped financial assurance is not applicable to this component");
    }
    const fragments = component.fact.scopedAssessments ?? [{
      scopeId: null, share: 1, quality: component.fact.quality, status: component.fact.status,
    }];
    const fullyAssured = fragments.every(fragment => fragment.quality !== null && fragment.status.observationState === "known");
    for (const fragment of fragments) {
      const attribution = v9BackingStatusCause(fragment.status, gapIndex,
        fragment.quality === null || fragment.status.observationState !== "known" || fragment.status.applicability.state === "unresolved");
      const excluded = attribution.cause === "A" || attribution.cause === "B";
      const measured = fragment.status.observationState === "known" && fragment.status.applicability.state === "required" &&
        fragment.status.evidenceRefIds.length > 0 && fragment.quality !== null;
      const tier = measured ? backing.componentQuality[fragment.quality!] : backing.boundedUnknownQuality;
      const seasoned = fullyAssured && component.componentKey === "assurance-and-reconciliation" &&
        (fragment.quality === "strong" || fragment.quality === "adequate") &&
        input.asset.trackRecordMonths !== undefined && input.asset.trackRecordMonths >= backing.assuranceSeasonedCredit.minMonths;
      const score = excluded ? null : seasoned ? Math.min(tier + backing.assuranceSeasonedCredit.points, backing.componentQuality.strong) : tier;
      const weight = applicableComponentPolicyWeight > 0
        ? archetypePolicy.componentWeights[component.componentKey] * fragment.share / applicableComponentPolicyWeight : 0;
      const fragmentPath = fragment.scopeId === null ? pathKey : `${pathKey}:scope:${fragment.scopeId}`;
      if (score !== null) { mechanismWeightedScore += score * weight; includedMechanismWeight += weight; }
      if (attribution.cause !== null) {
        unresolved.push(...gapReasons(gapIndex, fragment.status.gapIds, fragmentPath,
          mode === "bounded-whole-review-absence" ? "missing-pillar-evidence" : "critical-unresolved",
          (code, cause) => resolveV9ReasonTreatment(policy, code, cause).treatment));
      }
      const adverse = measured && fragment.quality === "failed";
      contributions.push({
        componentKey: fragmentPath, source: "mechanism", score, normalizedWeight: weight,
        effectiveScoringWeight: excluded ? 0 : weight, weightedScore: (score ?? 0) * weight,
        observationState: fragment.status.observationState, provenance: null,
        evidenceRefIds: uniqueSorted(fragment.status.evidenceRefIds), failureDomains: canonicalDomains(component.fact.failureDomains),
        upstreamAssetId: null, ...attribution, ...(adverse ? { cause: "D", scoringDisposition: "measured-adverse" } : {}),
        wholeAssetWeight: fragment.scopeId === null ? null : fragment.share,
      });
      const structuralSignal = archetypePolicy.structuralComponents[component.componentKey] ??
        (serial ? backing.structural.nonSubstitutableFailureSignal : undefined);
      if (adverse && structuralSignal !== undefined) {
        structuralReasons.push(createV9BackingStructuralReason(policy, structuralSignal, {
          responsibility: "measured-adverse", pathKey: fragmentPath, materialShare: null,
          evidenceRefIds: uniqueSorted(fragment.status.evidenceRefIds), failureDomains: canonicalDomains(component.fact.failureDomains),
        }));
      }
    }
  }
  if (includedMechanismWeight > 0) {
    mechanismWeightedScore /= includedMechanismWeight;
    for (let index = reserve.contributions.length; index < contributions.length; index++) {
      const row = contributions[index]!;
      contributions[index] = { ...row, effectiveScoringWeight: (row.effectiveScoringWeight ?? 0) / includedMechanismWeight };
    }
  }

  const mechanismAvailable = includedMechanismWeight > 0;
  const reserveAvailable = reserve.score !== null && archetypePolicy.reserveWeight > SCORE_EPSILON;
  const activeReserveWeight = reserveAvailable ? archetypePolicy.reserveWeight : 0;
  const activeMechanismWeight = mechanismAvailable ? 1 - archetypePolicy.reserveWeight : 0;
  const combinedWeight = activeReserveWeight + activeMechanismWeight;
  const score = rateability === "NR" || combinedWeight <= SCORE_EPSILON ? null : clampScore(
    ((reserve.score ?? 0) * activeReserveWeight + mechanismWeightedScore * activeMechanismWeight) / combinedWeight,
  );
  const pillarCeiling =
    structuralReasons.length === 0 ? null : Math.min(...structuralReasons.map((reason) => reason.ceiling));
  return finalizeBackingResult({
    assetId: input.asset.assetId,
    archetype: input.archetype,
    policyId: policy.policy.policyId,
    policySemanticDigest: policy.semanticDigest,
    rateability,
    score,
    ...(inheritedApplications === undefined ? {} : { collateralizationApplications: inheritedApplications }),
    pillarCeiling,
    contributions: effectiveBackingContributions(
      contributions,
      combinedWeight > SCORE_EPSILON ? activeReserveWeight / combinedWeight : 0,
      combinedWeight > SCORE_EPSILON ? activeMechanismWeight / combinedWeight : 0,
      backing.reserve.concentrationWeight,
    ),
    structuralReasons,
    unresolved,
    evidenceRefIds: contributions.flatMap((contribution) => contribution.evidenceRefIds),
    failureDomains: [
      ...contributions.flatMap((contribution) => contribution.failureDomains),
      ...structuralReasons.flatMap((reason) => reason.failureDomains),
    ],
  });
}

export function evaluateV9ArchetypeBacking(
  input: V9ArchetypeBackingInput,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  return evaluateV9ArchetypeBackingInternal(input, policy, "reviewed");
}

export function createUnknownArchetypeV9BackingResult(
  assetId: string,
  archetype: string,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  assertV9BackingPolicy(policy);
  return finalizeBackingResult({
    assetId,
    archetype,
    policyId: policy.policy.policyId,
    policySemanticDigest: policy.semanticDigest,
    rateability: "rateable",
    score: backingPolicy(policy).boundedUnknownQuality,
    pillarCeiling: null,
    contributions: [normalizeV9BackingContribution({
      componentKey: "mechanism:archetype", source: "mechanism",
      score: backingPolicy(policy).boundedUnknownQuality, normalizedWeight: 1,
      weightedScore: backingPolicy(policy).boundedUnknownQuality, effectiveWeight: 1,
      observationState: "bounded-unknown", provenance: null, evidenceRefIds: [],
      failureDomains: [], upstreamAssetId: null, cause: "U",
    })],
    structuralReasons: [],
    unresolved: [{ code: "missing-archetype", pathKey: "mechanism:archetype", gapIds: [], treatment: "pillar", cause: "U" }],
    evidenceRefIds: [],
    failureDomains: [],
  });
}

export function createUnavailableV9BackingResult(
  asset: V9BackingAssetInput,
  unavailableReview: Pick<V9AssetFactsBase, "archetype" | "mechanismRiskReview">,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  assertV9BackingPolicy(policy);
  const gapIndex = asset.gapIndex ?? createV9GapIndex(asset.gaps);
  const unresolved = gapReasons(gapIndex, unavailableReview.mechanismRiskReview.status.gapIds,
    "mechanism:review", "missing-pillar-evidence",
    (code, cause) => resolveV9ReasonTreatment(policy, code, cause).treatment);
  if (
    unavailableReview.archetype === "unresolved" &&
    !unresolved.some((reason) => reason.code === "missing-archetype")
  ) {
    unresolved.push({ code: "missing-archetype", pathKey: "mechanism:archetype", gapIds: [], treatment: "diagnostic", cause: "U" });
  }
  const shared = {
    assetId: asset.assetId,
    archetype: unavailableReview.archetype,
    policyId: policy.policy.policyId,
    policySemanticDigest: policy.semanticDigest,
    structuralReasons: [],
    unresolved,
    evidenceRefIds: uniqueSorted(unavailableReview.mechanismRiskReview.status.evidenceRefIds),
    failureDomains: [],
  } as const;
  if (unavailableReview.archetype === "unresolved") {
    const reserve = evaluateV9ReserveExposures(asset, policy);
    const attribution = v9BackingStatusCause(unavailableReview.mechanismRiskReview.status, gapIndex, true);
    if (attribution.cause === "A" || attribution.cause === "B") {
      return finalizeBackingResult({ ...shared, rateability: "rateable", score: reserve.score,
        pillarCeiling: null, contributions: effectiveBackingContributions(reserve.contributions, 1, 0,
          backingPolicy(policy).reserve.concentrationWeight), unresolved: [...unresolved, ...reserve.unresolved] });
    }
    const bounded = createUnknownArchetypeV9BackingResult(asset.assetId, unavailableReview.archetype, policy);
    return finalizeBackingResult({
      ...shared, rateability: "rateable", score: bounded.score, pillarCeiling: null,
      contributions: [
        ...effectiveBackingContributions(reserve.contributions, 0, 0, backingPolicy(policy).reserve.concentrationWeight),
        ...bounded.contributions.map(row => ({ ...row, ...attribution, scoringDisposition: "bounded-uncertainty" as const })),
      ],
      unresolved: [...unresolved, ...reserve.unresolved],
    });
  }

  const archetypePolicy = backingPolicy(policy).archetypes[unavailableReview.archetype];
  const components = Object.keys(archetypePolicy.componentWeights).map((componentKey) => ({
    componentKey,
    fact: {
      status: unavailableReview.mechanismRiskReview.status,
      quality: null,
      failureDomains: [],
    },
  }));
  return evaluateV9ArchetypeBackingInternal(
    {
      archetype: unavailableReview.archetype,
      asset,
      components,
    },
    policy,
    "bounded-whole-review-absence",
  );
}
