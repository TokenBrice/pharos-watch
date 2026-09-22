import type {
  V9EvidenceResponsibility,
  V9FailureDomainRef,
  V9ReserveExposureFactV2,
} from "../../types/safety-score-v9-facts";
import type { V9ReasonCode } from "../../types/safety-score-v9";
import { clampScore } from "../math";
import { decimalSnap } from "./formula";
import { resolveV9ReasonPolicy } from "./policy";
import { createV9GapIndex, type V9GapIndex } from "./gap-index";
import { canonicalDomains, canonicalUniqueBy, compareText, domainKey, uniqueSorted } from "./primitives";
import { inheritedStablecoinReserveEvaluation } from "./backing-inheritance";
import {
  backingPolicy,
  createV9BackingStructuralReason,
  gapReasons,
  isV9MaterialShare,
  SCORE_EPSILON,
  v9StructuralResponsibilityForStatus,
  type ReserveAssetClass,
  type ReserveEvaluation,
  type V9BackingAssetInput,
  type V9BackingContribution,
  type V9BackingEvaluationPolicy,
  type V9BackingSemanticPolicy,
  type V9BackingStructuralReason,
  type V9BackingUnresolvedReason,
  type V9ResolvedUpstreamExposure,
} from "./backing-primitives";

const AVAILABILITY_REASON_CODES: ReadonlySet<V9ReasonCode> = new Set<V9ReasonCode>([
  "material-dependency-unavailable",
  "nonmaterial-dependency-unavailable",
]);

/**
 * Materiality-aggregation root keys for one exposure. An unavailable upstream
 * contributes its propagated terminal roots (so wrappers over one failed asset
 * aggregate); an available upstream or a directly tracked asset contributes its
 * own immediate identity (so same-asset row splits still aggregate — VER-004).
 * Cash-like rows with no tracked identity have no root.
 */
function materialityRootKeys(
  exposure: V9ReserveExposureFactV2,
  upstream: V9ResolvedUpstreamExposure | undefined,
): readonly string[] {
  if (upstream && upstream.score === null) {
    if (upstream.failureRootAssetIds && upstream.failureRootAssetIds.length > 0) {
      return uniqueSorted(upstream.failureRootAssetIds.map((id) => `asset:${id}`));
    }
    const domainRoots = upstream.failureDomains
      .filter((domain) => domain.kind === "reserve-issuer" || domain.kind === "reserve-custodian")
      .map(domainKey);
    if (domainRoots.length > 0) return uniqueSorted(domainRoots);
    return [`asset:${upstream.upstreamAssetId}`];
  }
  const identityId = upstream?.upstreamAssetId ?? exposure.trackedAssetId;
  return identityId === null ? [] : [`asset:${identityId}`];
}
/**
 * Reserve evaluation for an envelope whose absence the policy treats as
 * bounded: every exposure scores at the bounded-unknown quality and the
 * reason-coded ceiling bounds the final score. No composition is claimed.
 */
function boundedUnknownReserveEvaluation(
  asset: V9BackingAssetInput,
  unresolved: readonly V9BackingUnresolvedReason[],
  policy: V9BackingEvaluationPolicy,
): ReserveEvaluation {
  const backing = backingPolicy(policy);
  const quality = backing.boundedUnknownQuality;
  const evidenceRefIds = uniqueSorted(asset.reserveStatus.evidenceRefIds);
  return {
    score: quality,
    contributions: [
      {
        componentKey: "reserve:unclassified-residual",
        source: "reserve-exposure",
        score: quality,
        normalizedWeight: 1,
        weightedScore: quality,
        observationState: "bounded-unknown",
        provenance: null,
        evidenceRefIds,
        failureDomains: [],
        upstreamAssetId: null,
      },
      {
        componentKey: "reserve:concentration",
        source: "reserve-concentration",
        score: quality,
        normalizedWeight: backing.reserve.concentrationWeight,
        weightedScore: quality * backing.reserve.concentrationWeight,
        observationState: "bounded-unknown",
        provenance: null,
        evidenceRefIds,
        failureDomains: [],
        upstreamAssetId: null,
      },
    ],
    structuralReasons: [],
    unresolved,
    rateability: "rateable",
  };
}

function boundedReserveForStatus(
  asset: V9BackingAssetInput,
  gapIndex: V9GapIndex,
  policy: V9BackingEvaluationPolicy,
  fallbackCode: V9ReasonCode,
): ReserveEvaluation {
  const unresolved = gapReasons(
    gapIndex,
    asset.reserveStatus.gapIds,
    "reserve-envelope",
    fallbackCode,
    (code) => resolveV9ReasonPolicy(policy, code).reason.defaultTreatment,
  );
  return unresolved.some((reason) => reason.treatment === "NR")
    ? { score: null, contributions: [], structuralReasons: [], unresolved, rateability: "NR" }
    : boundedUnknownReserveEvaluation(asset, unresolved, policy);
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

function scoreV9ReserveExposureClassification(
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


type ReserveMaterialityWeightFor = (exposure: V9ReserveExposureFactV2) => number;

function buildReserveMaterialityWeightFor(
  exposures: readonly V9ReserveExposureFactV2[],
  upstreamByExposure: ReadonlyMap<string, V9ResolvedUpstreamExposure>,
): ReserveMaterialityWeightFor {
  // Materiality is judged on the AGGREGATE exposure to a shared FAILED
  // dependency root, not the immediate reserve row: splitting one exposure
  // across several rows — or across several wrappers that all terminate at the
  // same unavailable asset — must not demote it below the structural threshold
  // (VER-004, VER2-001). Each exposure contributes its full weight to every
  // root it reaches; its materiality is the strongest (max) root aggregate.
  const rootAggregateWeight = new Map<string, number>();
  const rootsByExposure = new Map<string, readonly string[]>();
  for (const exposure of exposures) {
    const roots = materialityRootKeys(exposure, upstreamByExposure.get(exposure.exposureKey));
    rootsByExposure.set(exposure.exposureKey, roots);
    for (const root of roots) {
      rootAggregateWeight.set(root, (rootAggregateWeight.get(root) ?? 0) + exposure.weight);
    }
  }
  return (exposure) => {
    const roots = rootsByExposure.get(exposure.exposureKey) ?? [];
    return roots.length === 0
      ? exposure.weight
      : Math.max(...roots.map((root) => rootAggregateWeight.get(root) ?? exposure.weight));
  };
}

type UpstreamBackingReason = {
  readonly code: V9ReasonCode;
  readonly path?: string;
  readonly responsibility?: V9EvidenceResponsibility;
};

function canonicalUpstreamBackingReasons(
  upstream: V9ResolvedUpstreamExposure,
): UpstreamBackingReason[] {
  return canonicalUniqueBy<UpstreamBackingReason>(
    upstream.reasons ?? upstream.reasonCodes.map((code) => ({
      code,
      path: undefined,
      responsibility: undefined,
    })),
    (reason) => `${reason.code}\u0000${reason.path ?? ""}\u0000${reason.responsibility ?? ""}`,
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.path ?? "", right.path ?? "") ||
      compareText(left.responsibility ?? "", right.responsibility ?? ""),
    "last",
  );
}

function projectResolvedUpstreamReserveExposure(params: {
  backing: V9BackingSemanticPolicy;
  policy: V9BackingEvaluationPolicy;
  upstream: V9ResolvedUpstreamExposure;
  pathKey: string;
  score: number;
  materialityWeight: number;
  materialityThreshold: number;
}): { score: number; unresolved: V9BackingUnresolvedReason[] } {
  const {
    backing,
    policy,
    upstream,
    pathKey,
    score: localScore,
    materialityWeight,
    materialityThreshold,
  } = params;
  const score = Math.min(localScore, upstream.score ?? backing.boundedUnknownQuality);
  // For an UNAVAILABLE upstream backing owns the availability decision: drop
  // any projected availability code and recompute it from the root aggregate.
  // An available upstream's projected codes pass through after whole-upstream
  // ceilings are narrowed to this basket exposure.
  const upstreamReasons = canonicalUpstreamBackingReasons(upstream);
  const projectedSources =
    upstream.score === null
      ? upstreamReasons.filter((reason) => !AVAILABILITY_REASON_CODES.has(reason.code))
      : upstreamReasons;
  // One projected reason per upstream code and owner. An upstream raises one
  // gap per reserve slice its stale composition covers; this exposure holds
  // one unresolved claim on that upstream, not one per slice, so the paths
  // fold into a single reason (9.47) and survive only in its causal key.
  const projectedByCause = new Map<
    string,
    { reason: UpstreamBackingReason; code: V9ReasonCode; paths: string[] }
  >();
  for (const reason of projectedSources) {
    const code: V9ReasonCode =
      upstream.score !== null &&
      resolveV9ReasonPolicy(policy, reason.code).reason.defaultTreatment === "ceiling"
        ? "bounded-unknown-reserve-exposure"
        : reason.code;
    const key = `${code}\u0000${reason.code}\u0000${reason.responsibility ?? ""}`;
    const path = reason.path ?? "unattributed";
    const entry = projectedByCause.get(key);
    if (entry) entry.paths.push(path);
    else projectedByCause.set(key, { reason, code, paths: [path] });
  }
  const projected = [...projectedByCause.values()];
  const projectedCodeCounts = new Map<V9ReasonCode, number>();
  for (const { code } of projected) {
    projectedCodeCounts.set(code, (projectedCodeCounts.get(code) ?? 0) + 1);
  }

  const unresolved: V9BackingUnresolvedReason[] = projected.map(({ reason, code, paths }) => ({
    code,
    pathKey,
    gapIds: [],
    treatment: resolveV9ReasonPolicy(policy, code).reason.defaultTreatment,
    ...(reason.responsibility === undefined ? {} : { responsibility: reason.responsibility }),
    ...((projectedCodeCounts.get(code) ?? 0) > 1
      ? {
          causalKey: `upstream:${upstream.upstreamAssetId}:${reason.code}:${[...new Set(paths)]
            .sort(compareText)
            .join("+")}`,
        }
      : {}),
  }));

  if (upstream.score === null) {
    const unavailableCode = isV9MaterialShare(materialityWeight, materialityThreshold)
      ? ("material-dependency-unavailable" as const)
      : ("nonmaterial-dependency-unavailable" as const);
    const nrCausalReasons = upstreamReasons.filter(
      (reason) =>
        resolveV9ReasonPolicy(policy, reason.code).reason.defaultTreatment === "NR" &&
        reason.responsibility !== undefined,
    );
    const causalReasons =
      nrCausalReasons.length > 0
        ? nrCausalReasons
        : upstreamReasons.filter(
            (reason) => reason.responsibility !== undefined,
          );
    const byResponsibility = new Map<
      V9EvidenceResponsibility,
      UpstreamBackingReason[]
    >();
    for (const reason of causalReasons) {
      if (reason.responsibility === undefined) continue;
      byResponsibility.set(reason.responsibility, [
        ...(byResponsibility.get(reason.responsibility) ?? []),
        reason,
      ]);
    }
    const attributions = [...byResponsibility]
      .sort(([left], [right]) => compareText(left, right))
      .map(([responsibility, reasons]) => ({
        responsibility,
        causalKey: `upstream:${upstream.upstreamAssetId}:${reasons
          .map((reason) => `${reason.code}:${reason.path ?? "unattributed"}`)
          .sort(compareText)
          .join("+")}`,
      }));
    unresolved.push(
      ...(attributions.length > 0 ? attributions : [undefined]).map((attribution) => ({
        code: unavailableCode,
        pathKey,
        gapIds: [],
        treatment: resolveV9ReasonPolicy(policy, unavailableCode).reason.defaultTreatment,
        ...(attribution === undefined ? {} : attribution),
      })),
    );
  }

  return { score, unresolved };
}

function projectUnresolvedTrackedReserveExposure(params: {
  asset: V9BackingAssetInput;
  policy: V9BackingEvaluationPolicy;
  trackedAssetId: string;
  pathKey: string;
  materialityWeight: number;
  materialityThreshold: number;
}): V9BackingUnresolvedReason[] {
  const {
    asset,
    policy,
    trackedAssetId,
    pathKey,
    materialityWeight,
    materialityThreshold,
  } = params;
  const unavailableCode = isV9MaterialShare(materialityWeight, materialityThreshold)
    ? ("material-dependency-unavailable" as const)
    : ("nonmaterial-dependency-unavailable" as const);
  const attributions = canonicalUniqueBy(
    asset.unresolvedUpstreamProjectionAttributions ?? [],
    (attribution) => `${attribution.causalKey}\u0000${attribution.responsibility}`,
    (left, right) =>
      compareText(left.causalKey, right.causalKey) ||
      compareText(left.responsibility, right.responsibility),
    "last",
  );
  return (
    attributions.length > 0
      ? attributions
      : [{
          causalKey: `dependency-projection:${trackedAssetId}`,
          responsibility: "method-unsupported" as const,
        }]
  ).map((attribution) => ({
    code: unavailableCode,
    pathKey,
    gapIds: [],
    treatment: resolveV9ReasonPolicy(policy, unavailableCode).reason.defaultTreatment,
    ...attribution,
  }));
}

function collectPrivateCreditObligorStructuralReasons(
  exposures: readonly V9ReserveExposureFactV2[],
  policy: V9BackingEvaluationPolicy,
  backing: V9BackingSemanticPolicy,
  threshold: number,
): V9BackingStructuralReason[] {
  // Speculative-credit materiality aggregates private-credit rows that share
  // one obligor: three 4% rows to one borrower are as material as a single
  // 12% row, so a named split cannot dodge the structural cap (VER2-002). One
  // reason is emitted per crossing obligor group with the union of evidence
  // and failure domains.
  const obligorGroups = new Map<
    string,
    {
      share: number;
      evidence: string[];
      failureDomains: V9FailureDomainRef[];
      measured: boolean;
    }
  >();
  for (const exposure of exposures) {
    if (exposure.assetClass !== "private-credit" || exposure.issuerOrObligorKey === null) continue;
    const key = exposure.issuerOrObligorKey;
    const group = obligorGroups.get(key) ?? {
      share: 0,
      evidence: [],
      failureDomains: [],
      measured: true,
    };
    group.share += exposure.weight;
    group.evidence.push(...exposure.status.evidenceRefIds);
    group.failureDomains.push(...exposure.failureDomains);
    group.measured =
      group.measured &&
      v9StructuralResponsibilityForStatus(exposure.status) === "measured-adverse";
    obligorGroups.set(key, group);
  }
  return [...obligorGroups]
    .sort((left, right) => compareText(left[0], right[0]))
    .flatMap(([key, group]) =>
      isV9MaterialShare(group.share, threshold)
        ? [createV9BackingStructuralReason(policy, backing.structural.speculativeCreditSignal, {
            responsibility: group.measured ? "measured-adverse" : "integration-missing",
            pathKey: `same-obligor:${key}`,
            materialShare: group.share,
            evidenceRefIds: uniqueSorted(group.evidence),
            failureDomains: canonicalDomains(group.failureDomains),
          })]
        : [],
    );
}

function appendReserveExposureEvaluation(params: {
  asset: V9BackingAssetInput;
  exposure: V9ReserveExposureFactV2;
  upstream: V9ResolvedUpstreamExposure | undefined;
  seriallyResolvedUpstreamAssetIds: ReadonlySet<string>;
  materialityWeight: number;
  threshold: number;
  policy: V9BackingEvaluationPolicy;
  backing: V9BackingSemanticPolicy;
  issuerConcentrationExemptClasses: ReadonlySet<ReserveAssetClass>;
  issuerConcentrationExemptComponentKeys: Set<string>;
  measuredFailureDomainsByComponent: Map<string, ReadonlySet<string>>;
  gapIndex: V9GapIndex;
  contributions: V9BackingContribution[];
  unresolved: V9BackingUnresolvedReason[];
  structuralReasons: V9BackingStructuralReason[];
}): void {
  const {
    asset,
    exposure,
    upstream,
    seriallyResolvedUpstreamAssetIds,
    materialityWeight,
    threshold,
    policy,
    backing,
    issuerConcentrationExemptClasses,
    issuerConcentrationExemptComponentKeys,
    measuredFailureDomainsByComponent,
    gapIndex,
    contributions,
    unresolved,
    structuralReasons,
  } = params;
  const pathKey = `reserve:${exposure.exposureKey}`;
  const state = exposure.status.observationState;
  const requiredUnknown = exposure.status.applicability.state === "unresolved";
  const confidenceMultiplier =
    exposure.provenance === "live" || exposure.evidenceClass === "independent"
      ? 1
      : backing.reserve.issuerAttestedConfidenceMultiplier;
  const classifiedScore = scoreV9ReserveExposureClassification(exposure, policy) * confidenceMultiplier;
  let score =
    state === "known" || state === "stale"
      ? classifiedScore
      : backing.boundedUnknownQuality;

  if (upstream) {
    const upstreamProjection = projectResolvedUpstreamReserveExposure({
      backing,
      policy,
      upstream,
      pathKey,
      score,
      materialityWeight,
      materialityThreshold: threshold,
    });
    score = upstreamProjection.score;
    unresolved.push(...upstreamProjection.unresolved);
  } else if (exposure.trackedAssetId !== null && !seriallyResolvedUpstreamAssetIds.has(exposure.trackedAssetId)) {
    score = Math.min(score, backing.boundedUnknownQuality);
    unresolved.push(
      ...projectUnresolvedTrackedReserveExposure({
        asset,
        policy,
        trackedAssetId: exposure.trackedAssetId,
        pathKey,
        materialityWeight,
        materialityThreshold: threshold,
      }),
    );
  }

  if (state !== "known" || requiredUnknown) {
    const material = isV9MaterialShare(exposure.weight, threshold);
    unresolved.push(
      ...gapReasons(
        gapIndex,
        exposure.status.gapIds,
        pathKey,
        material ? "material-unknown-reserve-exposure" : "bounded-unknown-reserve-exposure",
        () => (material ? "ceiling" : "pillar"),
      ),
    );
  }

  const failureDomains = canonicalDomains([...exposure.failureDomains, ...(upstream?.failureDomains ?? [])]);
  const responsibility = v9StructuralResponsibilityForStatus(exposure.status);
  measuredFailureDomainsByComponent.set(
    pathKey,
    new Set(
      responsibility === "measured-adverse"
        ? exposure.failureDomains.map(domainKey)
        : [],
    ),
  );
  // These classes do not represent a counterparty obligation at the
  // reserve-issuer layer. Custodian domains remain fully counted.
  if (exposure.assetClass !== null && issuerConcentrationExemptClasses.has(exposure.assetClass)) {
    issuerConcentrationExemptComponentKeys.add(pathKey);
  }
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

  const material = isV9MaterialShare(materialityWeight, threshold);
  if (material && exposure.assetClass === "private-credit" && exposure.issuerOrObligorKey === null) {
    structuralReasons.push(
      createV9BackingStructuralReason(policy, backing.structural.speculativeCreditSignal, {
        responsibility,
        pathKey,
        materialShare: materialityWeight,
        evidenceRefIds: uniqueSorted(exposure.status.evidenceRefIds),
        failureDomains,
      }),
    );
  }
  if (material && score <= backing.structural.unsafeExposureQuality) {
    structuralReasons.push(
      createV9BackingStructuralReason(policy, backing.structural.unsafeExposureSignal, {
        responsibility:
          responsibility === "measured-adverse" &&
          classifiedScore <= backing.structural.unsafeExposureQuality
            ? "measured-adverse"
            : "integration-missing",
        pathKey,
        materialShare: materialityWeight,
        evidenceRefIds: uniqueSorted(exposure.status.evidenceRefIds),
        failureDomains,
      }),
    );
  }
}

function appendResidualReserveExposure(params: {
  asset: V9BackingAssetInput;
  backing: V9BackingSemanticPolicy;
  residualWeight: number;
  threshold: number;
  contributions: V9BackingContribution[];
  unresolved: V9BackingUnresolvedReason[];
}): void {
  const { asset, backing, residualWeight, threshold, contributions, unresolved } = params;
  if (residualWeight <= SCORE_EPSILON) return;
  const material = isV9MaterialShare(residualWeight, threshold);
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

interface ReserveDomainConcentrationGroup {
  readonly domain: V9FailureDomainRef;
  share: number;
  exposures: string[];
  evidence: string[];
  measured: boolean;
}

function collectReserveDomainConcentrationGroups(params: {
  contributions: readonly V9BackingContribution[];
  measuredFailureDomainsByComponent: ReadonlyMap<string, ReadonlySet<string>>;
  issuerConcentrationExemptComponentKeys: ReadonlySet<string>;
}): ReserveDomainConcentrationGroup[] {
  const domainGroups = new Map<string, ReserveDomainConcentrationGroup>();
  for (const contribution of params.contributions.filter((entry) => entry.source === "reserve-exposure")) {
    for (const domain of contribution.failureDomains) {
      if (domain.kind !== "reserve-issuer" && domain.kind !== "reserve-custodian") continue;
      if (
        domain.kind === "reserve-issuer" &&
        params.issuerConcentrationExemptComponentKeys.has(contribution.componentKey)
      ) {
        continue;
      }
      const key = domainKey(domain);
      const group = domainGroups.get(key) ?? {
        domain,
        share: 0,
        exposures: [],
        evidence: [],
        measured: true,
      };
      group.share += contribution.normalizedWeight;
      group.exposures.push(contribution.componentKey);
      group.evidence.push(...contribution.evidenceRefIds);
      group.measured =
        group.measured &&
        (params.measuredFailureDomainsByComponent.get(contribution.componentKey)?.has(key) ?? false);
      domainGroups.set(key, group);
    }
  }
  return [...domainGroups.values()];
}

function collectReserveCommonModeStructuralReasons(
  domainGroups: readonly ReserveDomainConcentrationGroup[],
  policy: V9BackingEvaluationPolicy,
  backing: V9BackingSemanticPolicy,
): V9BackingStructuralReason[] {
  return domainGroups
    .filter(
      (group) =>
        group.exposures.length >= backing.structural.commonModeMinExposures &&
        group.share + SCORE_EPSILON >= backing.structural.commonModeShare,
    )
    .sort((left, right) => compareText(domainKey(left.domain), domainKey(right.domain)))
    .map((group) =>
      createV9BackingStructuralReason(policy, backing.structural.commonModeSignal, {
        responsibility: group.measured ? "measured-adverse" : "integration-missing",
        pathKey: `common-mode:${domainKey(group.domain)}`,
        materialShare: group.share,
        evidenceRefIds: uniqueSorted(group.evidence),
        failureDomains: [group.domain],
      }),
    );
}

function appendReserveConcentrationContribution(params: {
  asset: V9BackingAssetInput;
  backing: V9BackingSemanticPolicy;
  domainGroups: readonly ReserveDomainConcentrationGroup[];
  contributions: V9BackingContribution[];
}): number {
  const { asset, backing, domainGroups, contributions } = params;
  const maximumDomainShare = domainGroups.reduce((maximum, group) => Math.max(maximum, group.share), 0);
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
    failureDomains: canonicalDomains(domainGroups.map((group) => group.domain)),
    upstreamAssetId: null,
  });
  return concentration;
}

export function evaluateV9ReserveExposures(
  asset: V9BackingAssetInput,
  policy: V9BackingEvaluationPolicy,
): ReserveEvaluation {
  const backing = backingPolicy(policy);
  const gapIndex = asset.gapIndex ?? createV9GapIndex(asset.gaps);
  if (asset.reserveStatus.applicability.state === "not-applicable") {
    return { score: null, contributions: [], structuralReasons: [], unresolved: [], rateability: "rateable" };
  }
  // A ~100% single-parent wrapper inherits its parent's backing quality instead
  // of the fail-closed bounded-unknown floor a missing live/attested composition
  // otherwise gets. Only applied when the inherited (discounted) quality beats
  // that floor: a weak parent yields no positive evidence to credit above it, so
  // the wrapper falls through to the existing bounded path byte-identically.
  const inheritedReserve =
    asset.inheritedStablecoinBacking !== undefined
      ? inheritedStablecoinReserveEvaluation(
          asset,
          asset.inheritedStablecoinBacking,
          policy,
          gapIndex,
        )
      : null;
  if (inheritedReserve !== null) return inheritedReserve;
  if (asset.reserveStatus.applicability.state === "unresolved") {
    return boundedReserveForStatus(asset, gapIndex, policy, "unreviewed-reserve-envelope");
  }
  if (asset.reserveStatus.observationState === "missing" || asset.reserveStatus.observationState === "unsupported") {
    return boundedReserveForStatus(asset, gapIndex, policy, "missing-reserve-composition");
  }

  const upstreamByExposure = new Map(
    canonicalUniqueBy(
      asset.resolvedUpstreamExposures,
      (projection) => projection.exposureKey,
      (left, right) => compareText(left.exposureKey, right.exposureKey),
      "last",
    )
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
  const issuerConcentrationExemptClasses = new Set<ReserveAssetClass>([
    ...backing.reserve.sovereignConcentrationExemptClasses,
    ...backing.reserve.nonCounterpartyReserveIssuerConcentrationExemptClasses,
  ]);
  const issuerConcentrationExemptComponentKeys = new Set<string>();
  const measuredFailureDomainsByComponent = new Map<string, ReadonlySet<string>>();
  const unresolved: V9BackingUnresolvedReason[] = [];
  const structuralReasons: V9BackingStructuralReason[] = [];
  if (asset.reserveStatus.observationState === "stale" || asset.reserveStatus.observationState === "bounded-unknown") {
    unresolved.push(
      ...gapReasons(
        gapIndex,
        asset.reserveStatus.gapIds,
        "reserve-envelope",
        "partial-reserve-review",
        () => "ceiling",
      ),
    );
  }
  const threshold = backing.structural.materialExposureShare;
  const materialityWeightFor = buildReserveMaterialityWeightFor(exposures, upstreamByExposure);
  for (const exposure of exposures) {
    const upstream = upstreamByExposure.get(exposure.exposureKey);
    appendReserveExposureEvaluation({
      asset,
      exposure,
      upstream,
      seriallyResolvedUpstreamAssetIds,
      materialityWeight: materialityWeightFor(exposure),
      threshold,
      policy,
      backing,
      issuerConcentrationExemptClasses,
      issuerConcentrationExemptComponentKeys,
      measuredFailureDomainsByComponent,
      gapIndex,
      contributions,
      unresolved,
      structuralReasons,
    });
  }

  structuralReasons.push(
    ...collectPrivateCreditObligorStructuralReasons(exposures, policy, backing, threshold),
  );

  const residualWeight = Math.max(0, 1 - totalWeight);
  appendResidualReserveExposure({
    asset,
    backing,
    residualWeight,
    threshold,
    contributions,
    unresolved,
  });

  const domainGroups = collectReserveDomainConcentrationGroups({
    contributions,
    measuredFailureDomainsByComponent,
    issuerConcentrationExemptComponentKeys,
  });
  structuralReasons.push(...collectReserveCommonModeStructuralReasons(domainGroups, policy, backing));
  const concentration = appendReserveConcentrationContribution({
    asset,
    backing,
    domainGroups,
    contributions,
  });

  const exposureScore = contributions
    .filter((entry) => entry.source === "reserve-exposure")
    .reduce((sum, contribution) => sum + contribution.weightedScore, 0);
  const reserveScore =
    exposureScore * (1 - backing.reserve.concentrationWeight) + concentration * backing.reserve.concentrationWeight;
  return {
    // Snap binary-float summation noise (per the formula convention) so an
    // exposure split across rows yields the same reserve score as one row
    // (VER2-002); the 15-digit window never crosses a genuine boundary.
    score: clampScore(decimalSnap(reserveScore)),
    contributions,
    structuralReasons,
    unresolved,
    rateability: "rateable",
  };
}
