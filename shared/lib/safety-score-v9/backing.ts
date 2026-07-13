import type {
  V9AssetFactsV2,
  V9FailureDomainRef,
  V9FactGapV2,
  V9FactStatusV2,
  V9ReserveExposureFactV2,
} from "../../types/safety-score-v9-facts";
import type {
  V9EvidenceLevel,
  V9ReasonCode,
  V9Severity,
  V9StructuralSignalKind,
  V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import type { MechanismArchetype } from "../../types/stablecoin-taxonomy";
export type { V9MechanismFactV1, V9MechanismQualityLevel } from "../../types/safety-score-v9-backing";
import type { V9MechanismFactV1 } from "../../types/safety-score-v9-backing";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";
import { assertV9ValidatedPolicyEnvelope } from "./policy";

type ReserveAssetClass = NonNullable<V9ReserveExposureFactV2["assetClass"]>;
export interface V9ResolvedUpstreamExposure {
  readonly exposureKey: string;
  readonly upstreamAssetId: string;
  readonly score: number | null;
  readonly evidenceLevel: V9EvidenceLevel;
  readonly reasonCodes: readonly V9ReasonCode[];
  readonly failureDomains: readonly V9FailureDomainRef[];
}

export interface V9BackingAssetInput {
  readonly assetId: string;
  readonly reserveStatus: V9AssetFactsV2["reserveStatus"];
  readonly reserveExposures: readonly V9ReserveExposureFactV2[];
  readonly gaps: readonly V9FactGapV2[];
  readonly resolvedUpstreamExposures: readonly V9ResolvedUpstreamExposure[];
  readonly seriallyResolvedUpstreamAssetIds?: readonly string[];
}

export type V9BackingEvaluationPolicy = V9ValidatedPolicyEnvelope;
type V9BackingSemanticPolicy = V9ValidatedPolicyEnvelope["policy"]["semantic"]["backing"];
export type V9BackingSignalRule = V9BackingSemanticPolicy["structural"]["unsafeExposureSignal"];

export interface V9BackingStructuralReason {
  readonly kind: V9StructuralSignalKind;
  readonly severity: V9Severity;
  readonly pathKey: string;
  readonly materialShare: number | null;
  readonly ceiling: number;
  readonly evidenceRefIds: readonly string[];
  readonly failureDomains: readonly V9FailureDomainRef[];
}

export interface V9BackingContribution {
  readonly componentKey: string;
  readonly source: "reserve-exposure" | "reserve-concentration" | "mechanism";
  readonly score: number;
  readonly normalizedWeight: number;
  readonly weightedScore: number;
  readonly observationState: V9FactStatusV2["observationState"];
  readonly provenance: V9ReserveExposureFactV2["provenance"] | null;
  readonly evidenceRefIds: readonly string[];
  readonly failureDomains: readonly V9FailureDomainRef[];
  readonly upstreamAssetId: string | null;
}

export interface V9BackingUnresolvedReason {
  readonly code: V9ReasonCode;
  readonly pathKey: string;
  readonly gapIds: readonly string[];
  readonly treatment: "pillar" | "ceiling" | "NR" | "diagnostic";
}

export interface V9BackingResult {
  readonly assetId: string;
  readonly archetype: string;
  readonly policyId: string;
  readonly policySemanticDigest: string;
  readonly rateability: "rateable" | "NR";
  readonly score: number | null;
  readonly pillarCeiling: number | null;
  readonly contributions: readonly V9BackingContribution[];
  readonly structuralReasons: readonly V9BackingStructuralReason[];
  readonly unresolved: readonly V9BackingUnresolvedReason[];
  readonly evidenceRefIds: readonly string[];
  readonly failureDomains: readonly V9FailureDomainRef[];
  readonly traceDigest: string;
}

export interface V9MechanismComponentInput {
  readonly componentKey: string;
  readonly fact: V9MechanismFactV1;
}

export interface V9ArchetypeBackingInput {
  readonly archetype: MechanismArchetype;
  readonly asset: V9BackingAssetInput;
  readonly components: readonly V9MechanismComponentInput[];
  readonly additionalStructuralReasons?: readonly V9BackingStructuralReason[];
}

const SCORE_EPSILON = 0.000001;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareText);
}

function domainKey(domain: V9FailureDomainRef): string {
  return `${domain.kind}:${domain.key}`;
}

function canonicalDomains(domains: readonly V9FailureDomainRef[]): V9FailureDomainRef[] {
  return [...new Map(domains.map((domain) => [domainKey(domain), domain])).values()].sort((left, right) =>
    compareText(domainKey(left), domainKey(right)),
  );
}

function gapReasons(
  asset: V9BackingAssetInput,
  gapIds: readonly string[],
  pathKey: string,
  treatment: V9BackingUnresolvedReason["treatment"],
  fallbackCode: V9ReasonCode,
): V9BackingUnresolvedReason[] {
  if (gapIds.length === 0) return [{ code: fallbackCode, pathKey, gapIds: [], treatment }];
  const reasons = gapIds
    .map((gapId) => asset.gaps.find((gap) => gap.gapId === gapId))
    .filter((gap): gap is V9FactGapV2 => gap !== undefined)
    .map((gap) => ({ code: gap.reasonCode, pathKey, gapIds: [gap.gapId], treatment }));
  return reasons.length > 0 ? reasons : [{ code: fallbackCode, pathKey, gapIds: uniqueSorted(gapIds), treatment }];
}

function scoreFromMaturity(
  assetClass: ReserveAssetClass,
  maturityDaysMax: number | null,
  policy: V9BackingSemanticPolicy,
): number {
  if (policy.reserve.maturityNotApplicableClasses.includes(assetClass)) return 100;
  if (maturityDaysMax === null) return policy.boundedUnknownQuality;
  const ordered = [...policy.reserve.maturityBands].sort((left, right) => {
    if (left.maxDaysInclusive === null) return 1;
    if (right.maxDaysInclusive === null) return -1;
    return left.maxDaysInclusive - right.maxDaysInclusive;
  });
  return (
    ordered.find((band) => band.maxDaysInclusive === null || maturityDaysMax <= band.maxDaysInclusive)?.score ??
    policy.boundedUnknownQuality
  );
}

export function scoreV9ReserveExposureClassification(
  exposure: Pick<V9ReserveExposureFactV2, "assetClass" | "liquidityHorizon" | "maturityDaysMax">,
  policy: V9BackingEvaluationPolicy,
): number {
  const backing = backingPolicy(policy);
  if (exposure.assetClass === null) return backing.boundedUnknownQuality;
  const assetQuality = backing.reserve.assetClassQuality[exposure.assetClass];
  const liquidity =
    exposure.liquidityHorizon === null
      ? backing.boundedUnknownQuality
      : backing.reserve.liquidityQuality[exposure.liquidityHorizon];
  const maturity = scoreFromMaturity(exposure.assetClass, exposure.maturityDaysMax, backing);
  const weights = backing.reserve.factorWeights;
  const totalWeight = weights.assetQuality + weights.liquidity + weights.maturity;
  return (
    (assetQuality * weights.assetQuality + liquidity * weights.liquidity + maturity * weights.maturity) / totalWeight
  );
}

function concentrationScore(share: number, policy: V9BackingSemanticPolicy): number {
  const band = [...policy.reserve.concentrationBands]
    .sort((left, right) => right.minShareInclusive - left.minShareInclusive)
    .find((candidate) => share + SCORE_EPSILON >= candidate.minShareInclusive);
  return band?.score ?? policy.boundedUnknownQuality;
}

export function assertV9BackingPolicy(policy: V9BackingEvaluationPolicy): void {
  assertV9ValidatedPolicyEnvelope(policy);
}

function backingPolicy(policy: V9BackingEvaluationPolicy): V9BackingSemanticPolicy {
  assertV9BackingPolicy(policy);
  return policy.policy.semantic.backing;
}

export function createV9BackingStructuralReason(
  policy: V9BackingEvaluationPolicy,
  signal: V9BackingSignalRule,
  details: Omit<V9BackingStructuralReason, "kind" | "severity" | "ceiling">,
): V9BackingStructuralReason {
  assertV9BackingPolicy(policy);
  const ceiling = policy.policy.semantic.structural.signalLimits[signal.kind][signal.severity];
  if (ceiling === null) {
    throw new Error(`Safety Score v9 backing signal ${signal.kind}:${signal.severity} has no structural limit`);
  }
  return { ...details, kind: signal.kind, severity: signal.severity, ceiling };
}

interface ReserveEvaluation {
  readonly score: number | null;
  readonly contributions: readonly V9BackingContribution[];
  readonly structuralReasons: readonly V9BackingStructuralReason[];
  readonly unresolved: readonly V9BackingUnresolvedReason[];
  readonly rateability: "rateable" | "NR";
}

export function evaluateV9ReserveExposures(
  asset: V9BackingAssetInput,
  policy: V9BackingEvaluationPolicy,
): ReserveEvaluation {
  const backing = backingPolicy(policy);
  if (asset.reserveStatus.applicability.state === "not-applicable") {
    return { score: null, contributions: [], structuralReasons: [], unresolved: [], rateability: "rateable" };
  }
  if (asset.reserveStatus.applicability.state === "unresolved") {
    return {
      score: null,
      contributions: [],
      structuralReasons: [],
      unresolved: gapReasons(
        asset,
        asset.reserveStatus.gapIds,
        "reserve-envelope",
        "NR",
        "unreviewed-reserve-envelope",
      ),
      rateability: "NR",
    };
  }
  if (asset.reserveStatus.observationState === "missing" || asset.reserveStatus.observationState === "unsupported") {
    return {
      score: null,
      contributions: [],
      structuralReasons: [],
      unresolved: gapReasons(
        asset,
        asset.reserveStatus.gapIds,
        "reserve-envelope",
        "NR",
        "missing-reserve-composition",
      ),
      rateability: "NR",
    };
  }

  const upstreamByExposure = new Map(
    [...asset.resolvedUpstreamExposures]
      .sort((left, right) => compareText(left.exposureKey, right.exposureKey))
      .map((projection) => [projection.exposureKey, projection]),
  );
  const seriallyResolvedUpstreamAssetIds = new Set(asset.seriallyResolvedUpstreamAssetIds ?? []);
  const exposures = [...asset.reserveExposures].sort((left, right) => compareText(left.exposureKey, right.exposureKey));
  const totalWeight = exposures.reduce((sum, exposure) => sum + exposure.weight, 0);
  if (totalWeight > 1 + SCORE_EPSILON) {
    return {
      score: null,
      contributions: [],
      structuralReasons: [],
      unresolved: [{ code: "critical-unresolved", pathKey: "reserve-envelope:weight", gapIds: [], treatment: "NR" }],
      rateability: "NR",
    };
  }

  const contributions: V9BackingContribution[] = [];
  const unresolved: V9BackingUnresolvedReason[] = [];
  const structuralReasons: V9BackingStructuralReason[] = [];
  if (asset.reserveStatus.observationState === "stale" || asset.reserveStatus.observationState === "bounded-unknown") {
    unresolved.push(
      ...gapReasons(asset, asset.reserveStatus.gapIds, "reserve-envelope", "ceiling", "partial-reserve-review"),
    );
  }
  for (const exposure of exposures) {
    const pathKey = `reserve:${exposure.exposureKey}`;
    const state = exposure.status.observationState;
    const upstream = upstreamByExposure.get(exposure.exposureKey);
    const requiredUnknown = exposure.status.applicability.state === "unresolved";
    let score =
      state === "known" || state === "stale"
        ? scoreV9ReserveExposureClassification(exposure, policy)
        : backing.boundedUnknownQuality;
    if (upstream) {
      score = Math.min(score, upstream.score ?? backing.boundedUnknownQuality);
      unresolved.push(
        ...uniqueSorted(upstream.reasonCodes).map((code) => ({
          code,
          pathKey,
          gapIds: [],
          treatment: "pillar" as const,
        })),
      );
    } else if (
      exposure.trackedAssetId !== null &&
      !seriallyResolvedUpstreamAssetIds.has(exposure.trackedAssetId)
    ) {
      score = Math.min(score, backing.boundedUnknownQuality);
      unresolved.push({
        code:
          exposure.weight + SCORE_EPSILON >= backing.structural.materialExposureShare
            ? "material-dependency-unavailable"
            : "nonmaterial-dependency-unavailable",
        pathKey,
        gapIds: [],
        treatment: "pillar",
      });
    }
    if (state !== "known" || requiredUnknown) {
      const material = exposure.weight + SCORE_EPSILON >= backing.structural.materialExposureShare;
      unresolved.push(
        ...gapReasons(
          asset,
          exposure.status.gapIds,
          pathKey,
          material ? "ceiling" : "pillar",
          material ? "material-unknown-reserve-exposure" : "bounded-unknown-reserve-exposure",
        ),
      );
    }
    const failureDomains = canonicalDomains([...exposure.failureDomains, ...(upstream?.failureDomains ?? [])]);
    contributions.push({
      componentKey: pathKey,
      source: "reserve-exposure",
      score: clampScore(score),
      normalizedWeight: exposure.weight,
      weightedScore: exposure.weight * clampScore(score),
      observationState: state,
      provenance: exposure.provenance,
      evidenceRefIds: uniqueSorted(exposure.status.evidenceRefIds),
      failureDomains,
      upstreamAssetId: upstream?.upstreamAssetId ?? exposure.trackedAssetId,
    });

    const material = exposure.weight + SCORE_EPSILON >= backing.structural.materialExposureShare;
    if (material && exposure.assetClass === "private-credit") {
      structuralReasons.push(
        createV9BackingStructuralReason(policy, backing.structural.speculativeCreditSignal, {
          pathKey,
          materialShare: exposure.weight,
          evidenceRefIds: uniqueSorted(exposure.status.evidenceRefIds),
          failureDomains,
        }),
      );
    }
    if (material && score <= backing.structural.unsafeExposureQuality) {
      structuralReasons.push(
        createV9BackingStructuralReason(policy, backing.structural.unsafeExposureSignal, {
          pathKey,
          materialShare: exposure.weight,
          evidenceRefIds: uniqueSorted(exposure.status.evidenceRefIds),
          failureDomains,
        }),
      );
    }
  }

  const residualWeight = Math.max(0, 1 - totalWeight);
  if (residualWeight > SCORE_EPSILON) {
    const material = residualWeight + SCORE_EPSILON >= backing.structural.materialExposureShare;
    contributions.push({
      componentKey: "reserve:unclassified-residual",
      source: "reserve-exposure",
      score: backing.boundedUnknownQuality,
      normalizedWeight: residualWeight,
      weightedScore: residualWeight * backing.boundedUnknownQuality,
      observationState: "bounded-unknown",
      provenance: null,
      evidenceRefIds: uniqueSorted(asset.reserveStatus.evidenceRefIds),
      failureDomains: [],
      upstreamAssetId: null,
    });
    unresolved.push({
      code: material ? "material-unknown-reserve-exposure" : "bounded-unknown-reserve-exposure",
      pathKey: "reserve:unclassified-residual",
      gapIds: uniqueSorted(asset.reserveStatus.gapIds),
      treatment: material ? "ceiling" : "pillar",
    });
  }

  const domainGroups = new Map<
    string,
    { domain: V9FailureDomainRef; share: number; exposures: string[]; evidence: string[] }
  >();
  for (const contribution of contributions.filter((entry) => entry.source === "reserve-exposure")) {
    for (const domain of contribution.failureDomains) {
      if (domain.kind !== "reserve-issuer" && domain.kind !== "reserve-custodian") continue;
      const key = domainKey(domain);
      const group = domainGroups.get(key) ?? { domain, share: 0, exposures: [], evidence: [] };
      group.share += contribution.normalizedWeight;
      group.exposures.push(contribution.componentKey);
      group.evidence.push(...contribution.evidenceRefIds);
      domainGroups.set(key, group);
    }
  }
  const commonModes = [...domainGroups.values()]
    .filter(
      (group) =>
        group.exposures.length >= backing.structural.commonModeMinExposures &&
        group.share + SCORE_EPSILON >= backing.structural.commonModeShare,
    )
    .sort((left, right) => compareText(domainKey(left.domain), domainKey(right.domain)));
  for (const group of commonModes) {
    structuralReasons.push(
      createV9BackingStructuralReason(policy, backing.structural.commonModeSignal, {
        pathKey: `common-mode:${domainKey(group.domain)}`,
        materialShare: group.share,
        evidenceRefIds: uniqueSorted(group.evidence),
        failureDomains: [group.domain],
      }),
    );
  }
  const maximumDomainShare = [...domainGroups.values()].reduce((maximum, group) => Math.max(maximum, group.share), 0);
  const concentration = concentrationScore(maximumDomainShare, backing);
  contributions.push({
    componentKey: "reserve:concentration",
    source: "reserve-concentration",
    score: concentration,
    normalizedWeight: backing.reserve.concentrationWeight,
    weightedScore: concentration * backing.reserve.concentrationWeight,
    observationState: asset.reserveStatus.observationState,
    provenance: null,
    evidenceRefIds: uniqueSorted(asset.reserveStatus.evidenceRefIds),
    failureDomains: canonicalDomains([...domainGroups.values()].map((group) => group.domain)),
    upstreamAssetId: null,
  });

  const exposureScore = contributions
    .filter((entry) => entry.source === "reserve-exposure")
    .reduce((sum, contribution) => sum + contribution.weightedScore, 0);
  const reserveScore =
    exposureScore * (1 - backing.reserve.concentrationWeight) + concentration * backing.reserve.concentrationWeight;
  return {
    score: clampScore(reserveScore),
    contributions,
    structuralReasons,
    unresolved,
    rateability: "rateable",
  };
}

function finalizeBackingResult(result: Omit<V9BackingResult, "traceDigest">): V9BackingResult {
  const unresolved = [
    ...new Map(
      result.unresolved.map((reason) => [
        `${reason.code}:${reason.pathKey}:${reason.treatment}:${uniqueSorted(reason.gapIds).join(",")}`,
        { ...reason, gapIds: uniqueSorted(reason.gapIds) },
      ]),
    ).values(),
  ];
  const canonical = {
    ...result,
    contributions: [...result.contributions].sort((left, right) => compareText(left.componentKey, right.componentKey)),
    structuralReasons: [...result.structuralReasons].sort((left, right) =>
      compareText(`${left.kind}:${left.severity}:${left.pathKey}`, `${right.kind}:${right.severity}:${right.pathKey}`),
    ),
    unresolved: unresolved.sort((left, right) =>
      compareText(`${left.code}:${left.pathKey}`, `${right.code}:${right.pathKey}`),
    ),
    evidenceRefIds: uniqueSorted(result.evidenceRefIds),
    failureDomains: canonicalDomains(result.failureDomains),
  };
  return {
    ...canonical,
    traceDigest: sha256Hex(stableJsonStringifyV1({ domain: "safety-score-v9.backing-trace.v1", trace: canonical })),
  };
}

export function evaluateV9ArchetypeBacking(
  input: V9ArchetypeBackingInput,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  const backing = backingPolicy(policy);
  const archetypePolicy = backing.archetypes[input.archetype];
  const expectedKeys = Object.keys(archetypePolicy.componentWeights).sort(compareText);
  const actualKeys = input.components.map((component) => component.componentKey).sort(compareText);
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`Safety Score v9 ${input.archetype} mechanism component contract does not match policy`);
  }

  const reserve = evaluateV9ReserveExposures(input.asset, policy);
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
    if (missing && serial) {
      rateability = "NR";
      unresolved.push(...gapReasons(input.asset, component.fact.status.gapIds, pathKey, "NR", "critical-unresolved"));
    } else if (state !== "known") {
      unresolved.push(
        ...gapReasons(
          input.asset,
          component.fact.status.gapIds,
          pathKey,
          state === "stale" ? "ceiling" : "pillar",
          state === "stale" ? "insufficient-evidence" : "critical-unresolved",
        ),
      );
    }
    const score =
      component.fact.quality === null
        ? backing.boundedUnknownQuality
        : backing.componentQuality[component.fact.quality];
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
    contributions,
    structuralReasons,
    unresolved,
    evidenceRefIds: contributions.flatMap((contribution) => contribution.evidenceRefIds),
    failureDomains: [
      ...contributions.flatMap((contribution) => contribution.failureDomains),
      ...structuralReasons.flatMap((reason) => reason.failureDomains),
    ],
  });
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
  asset: Pick<V9AssetFactsV2, "assetId" | "archetype" | "mechanismRiskReview" | "gaps">,
  policy: V9BackingEvaluationPolicy,
): V9BackingResult {
  assertV9BackingPolicy(policy);
  const gapCodes = asset.mechanismRiskReview.status.gapIds.flatMap((gapId) => {
    const gap = asset.gaps.find((candidate) => candidate.gapId === gapId);
    return gap ? [gap.reasonCode] : [];
  });
  const reasonCodes = uniqueSorted(gapCodes.length > 0 ? gapCodes : ["missing-pillar-evidence"]);
  return finalizeBackingResult({
    assetId: asset.assetId,
    archetype: asset.archetype,
    policyId: policy.policy.policyId,
    policySemanticDigest: policy.semanticDigest,
    rateability: "NR",
    score: null,
    pillarCeiling: null,
    contributions: [],
    structuralReasons: [],
    unresolved: reasonCodes.map((code) => ({
      code,
      pathKey: "mechanism:review",
      gapIds: uniqueSorted(asset.mechanismRiskReview.status.gapIds),
      treatment: "NR" as const,
    })),
    evidenceRefIds: uniqueSorted(asset.mechanismRiskReview.status.evidenceRefIds),
    failureDomains: [],
  });
}
