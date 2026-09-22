import type { V9AssetFactsBase } from "../../../types/safety-score-v9-facts";
import type { V9ReasonCode } from "../../../types/safety-score-v9";
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
  v9StructuralResponsibilityForStatus,
  type V9ArchetypeBackingInput,
  type V9BackingAssetInput,
  type V9BackingContribution,
  type V9BackingEvaluationPolicy,
  type V9BackingResult,
  type V9BackingUnresolvedReason,
  type V9EffectiveBackingContribution,
} from "../backing-primitives";
import { resolveV9ReasonPolicy } from "../policy";
import { createV9GapIndex, gapsForV9Ids } from "../gap-index";
import { canonicalDomains, canonicalUniqueBy, compareText, uniqueSorted } from "../primitives";

function effectiveBackingContributions(
  contributions: readonly V9BackingContribution[],
  reserveGroupWeight: number,
  mechanismGroupWeight: number,
  concentrationWeight: number,
): V9EffectiveBackingContribution[] {
  const hasConcentrationComponent = contributions.some(
    (contribution) => contribution.source === "reserve-concentration",
  );
  return contributions.map((contribution) => {
    const effectiveWeight =
      contribution.source === "mechanism"
        ? contribution.normalizedWeight * mechanismGroupWeight
        : contribution.source === "reserve-concentration"
          ? contribution.normalizedWeight * reserveGroupWeight
          : contribution.normalizedWeight *
            (hasConcentrationComponent ? 1 - concentrationWeight : 1) *
            reserveGroupWeight;
    return { ...contribution, effectiveWeight };
  });
}

function finalizeBackingResult(result: Omit<V9BackingResult, "traceDigest">): V9BackingResult {
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
    contributions: [...result.contributions].sort((left, right) => compareText(left.componentKey, right.componentKey)),
    structuralReasons: [...result.structuralReasons].sort((left, right) =>
      compareText(`${left.kind}:${left.severity}:${left.pathKey}`, `${right.kind}:${right.severity}:${right.pathKey}`),
    ),
    unresolved,
    evidenceRefIds: uniqueSorted(result.evidenceRefIds),
    failureDomains: canonicalDomains(result.failureDomains),
  };
  return {
    ...canonical,
    traceDigest: sha256Hex(stableJsonStringifyV1({ domain: "safety-score-v9.backing-trace.v1", trace: canonical })),
  };
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
  const verifiedLiveInheritance =
    input.asset.inheritedStablecoinBacking === undefined
      ? undefined
      : verifiedLiveInheritedExposure(input.asset, input.asset.inheritedStablecoinBacking);
  if (
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
  let rateability = reserve.rateability;

  const applicableComponents = input.components.filter(
    (component) => component.fact.status.applicability.state !== "not-applicable",
  );
  const applicableComponentPolicyWeight = applicableComponents.reduce(
    (sum, component) => sum + archetypePolicy.componentWeights[component.componentKey],
    0,
  );
  let mechanismWeightedScore = 0;
  for (const component of applicableComponents.sort((left, right) =>
    compareText(left.componentKey, right.componentKey),
  )) {
    const pathKey = `mechanism:${component.componentKey}`;
    const serial = archetypePolicy.serialComponentKeys.includes(component.componentKey);
    const state = component.fact.status.observationState;
    const unresolvedApplicability = component.fact.status.applicability.state === "unresolved";
    const missing = state === "missing" || state === "unsupported" || unresolvedApplicability;
    if (missing && serial && mode === "reviewed") {
      rateability = "NR";
      unresolved.push(
        ...gapReasons(
          gapIndex,
          component.fact.status.gapIds,
          pathKey,
          "critical-unresolved",
          () => "NR",
        ),
      );
    } else if (state !== "known") {
      unresolved.push(
        ...(mode === "bounded-whole-review-absence"
          ? gapReasons(
              gapIndex,
              component.fact.status.gapIds,
              pathKey,
              "missing-pillar-evidence",
              (code) => resolveV9ReasonPolicy(policy, code).reason.defaultTreatment,
            )
          : gapReasons(
              gapIndex,
              component.fact.status.gapIds,
              pathKey,
              state === "stale" ? "insufficient-evidence" : "critical-unresolved",
              () => (state === "stale" ? "ceiling" : "pillar"),
            )),
      );
    }
    const tierScore =
      component.fact.quality === null
        ? backing.boundedUnknownQuality
        : backing.componentQuality[component.fact.quality];
    // T5 seasoned-issuer credit (owner ruling 2026-07-22, R2), assurance half:
    // a sustained attestation cadence proven over the credit window earns the
    // policy's points on the assurance-and-reconciliation component when its
    // measured quality is already adequate-or-better, capped at the strong
    // tier — seasoning can close the adequate->strong gap, never exceed the
    // evidence ceiling.
    const score =
      component.componentKey === "assurance-and-reconciliation" &&
      (component.fact.quality === "strong" || component.fact.quality === "adequate") &&
      input.asset.trackRecordMonths !== undefined &&
      input.asset.trackRecordMonths >= backing.assuranceSeasonedCredit.minMonths
        ? Math.min(tierScore + backing.assuranceSeasonedCredit.points, backing.componentQuality.strong)
        : tierScore;
    const baseWeight = archetypePolicy.componentWeights[component.componentKey];
    const normalizedWithinMechanism =
      applicableComponentPolicyWeight > 0 ? baseWeight / applicableComponentPolicyWeight : 0;
    mechanismWeightedScore += score * normalizedWithinMechanism;
    contributions.push({
      componentKey: pathKey,
      source: "mechanism",
      score,
      normalizedWeight: normalizedWithinMechanism,
      weightedScore: score * normalizedWithinMechanism,
      observationState: state,
      provenance: null,
      evidenceRefIds: uniqueSorted(component.fact.status.evidenceRefIds),
      failureDomains: canonicalDomains(component.fact.failureDomains),
      upstreamAssetId: null,
    });
    const structuralSignal =
      archetypePolicy.structuralComponents[component.componentKey] ??
      (serial ? backing.structural.nonSubstitutableFailureSignal : undefined);
    if (component.fact.quality === "failed" && structuralSignal !== undefined) {
      structuralReasons.push(
        createV9BackingStructuralReason(policy, structuralSignal, {
          responsibility: v9StructuralResponsibilityForStatus(component.fact.status),
          pathKey,
          materialShare: null,
          evidenceRefIds: uniqueSorted(component.fact.status.evidenceRefIds),
          failureDomains: canonicalDomains(component.fact.failureDomains),
        }),
      );
    }
  }

  const mechanismAvailable = applicableComponentPolicyWeight > SCORE_EPSILON;
  const reserveAvailable = reserve.score !== null && archetypePolicy.reserveWeight > SCORE_EPSILON;
  const activeReserveWeight = reserveAvailable ? archetypePolicy.reserveWeight : 0;
  const activeMechanismWeight = mechanismAvailable ? 1 - activeReserveWeight : 0;
  const combinedWeight = activeReserveWeight + activeMechanismWeight;
  const score =
    rateability === "NR" || combinedWeight <= SCORE_EPSILON
      ? null
      : clampScore(
          ((reserve.score ?? 0) * activeReserveWeight + mechanismWeightedScore * activeMechanismWeight) /
            combinedWeight,
        );
  if (combinedWeight <= SCORE_EPSILON) {
    rateability = "NR";
    unresolved.push({ code: "missing-pillar-evidence", pathKey: "backing", gapIds: [], treatment: "NR" });
  }
  const pillarCeiling =
    structuralReasons.length === 0 ? null : Math.min(...structuralReasons.map((reason) => reason.ceiling));
  return finalizeBackingResult({
    assetId: input.asset.assetId,
    archetype: input.archetype,
    policyId: policy.policy.policyId,
    policySemanticDigest: policy.semanticDigest,
    rateability,
    score,
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
    rateability: "NR",
    score: null,
    pillarCeiling: null,
    contributions: [],
    structuralReasons: [],
    unresolved: [{ code: "missing-archetype", pathKey: "mechanism:archetype", gapIds: [], treatment: "NR" }],
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
  const gapCodes = gapsForV9Ids(
    gapIndex,
    unavailableReview.mechanismRiskReview.status.gapIds,
  ).map((gap) => gap.reasonCode);
  const reasonCodes = uniqueSorted(gapCodes.length > 0 ? gapCodes : (["missing-pillar-evidence"] as V9ReasonCode[]));
  const unresolved: V9BackingUnresolvedReason[] = reasonCodes.map((code) => ({
    code,
    pathKey: "mechanism:review",
    gapIds: uniqueSorted(unavailableReview.mechanismRiskReview.status.gapIds),
    treatment: resolveV9ReasonPolicy(policy, code).reason.defaultTreatment,
  }));
  if (
    unavailableReview.archetype === "unresolved" &&
    !unresolved.some((reason) => reason.code === "missing-archetype")
  ) {
    unresolved.push({ code: "missing-archetype", pathKey: "mechanism:archetype", gapIds: [], treatment: "NR" });
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
  if (unresolved.some((reason) => reason.treatment === "NR")) {
    return finalizeBackingResult({
      ...shared,
      rateability: "NR",
      score: null,
      pillarCeiling: null,
      contributions: [],
    });
  }
  if (unavailableReview.archetype === "unresolved") {
    throw new Error("Safety Score v9 unresolved archetype passed the unavailable-review NR guard");
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
