import { evaluateV9ReserveEligibilityEnvelope, resolveV9ReserveFactorBounds } from "./reserve-bound-facts";
import type {
  V9EvidenceResponsibility,
  V9FailureDomainRef,
  V9ReserveExposureFactV2,
} from "../../types/safety-score-v9-facts";
import type { V9ReasonCode } from "../../types/safety-score-v9";
import { clampScore } from "../math";
import { decimalSnap } from "./formula";
import { resolveV9ReasonTreatment } from "./policy";
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
  v9BackingStatusCause,
  normalizeV9BackingContribution,
  type ReserveAssetClass,
  type ReserveEvaluation,
  type V9BackingAssetInput,
  type V9BackingFactorContribution,
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
  const bounded = evaluateV9ReserveEligibilityEnvelope(asset.reserveBoundFacts ?? [], backing, asset.asOfSec ?? 0);
  const quality = bounded?.quality ?? backing.boundedUnknownQuality;
  const evidenceRefIds = uniqueSorted([...asset.reserveStatus.evidenceRefIds, ...(bounded?.evidenceRefIds ?? [])]);
  return {
    score: quality * (1 - backing.reserve.concentrationWeight) + backing.boundedUnknownQuality * backing.reserve.concentrationWeight,
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
        score: backing.boundedUnknownQuality,
        normalizedWeight: backing.reserve.concentrationWeight,
        weightedScore: backing.boundedUnknownQuality * backing.reserve.concentrationWeight,
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
    (code, cause) => resolveV9ReasonTreatment(policy, code, cause).treatment,
  );
  const attribution = v9BackingStatusCause(asset.reserveStatus, gapIndex);
  if (attribution.cause === "A" || attribution.cause === "B") {
    return { score: null, contributions: [{
      componentKey: "reserve:unclassified-residual", source: "reserve-exposure", score: null,
      normalizedWeight: 1, weightedScore: 0, observationState: asset.reserveStatus.observationState,
      provenance: null, evidenceRefIds: asset.reserveStatus.evidenceRefIds, failureDomains: [],
      upstreamAssetId: null, ...attribution, wholeAssetWeight: 1, effectiveScoringWeight: 0,
    }], structuralReasons: [], unresolved, rateability: "rateable" };
  }
  const bounded = boundedUnknownReserveEvaluation(asset, unresolved, policy);
  return { ...bounded, contributions: bounded.contributions.map(row => ({ ...row, ...attribution })) };
}

function scoreFromMaturity(
  assetClass: ReserveAssetClass,
  maturityDaysMax: number | null,
  policy: V9BackingSemanticPolicy,
): number {
  if (policy.reserve.maturityNotApplicableClasses.includes(assetClass)) return 100;
  if (maturityDaysMax === null) return policy.reserve.maturityUnknownQuality;
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
  exposure: V9ReserveExposureFactV2,
  policy: V9BackingEvaluationPolicy,
  asset: V9BackingAssetInput,
  sourceMultiplier: number,
): { score: number | null; adverseSupportScore: number; evidenceRefIds: string[];
  cause: V9BackingContribution["cause"]; causeGapIds: readonly string[]; factors: readonly V9BackingFactorContribution[] } {
  const backing = backingPolicy(policy);
  const index = asset.gapIndex ?? createV9GapIndex(asset.gaps);
  const classStatus = exposure.factorStatuses?.assetClass ?? exposure.status;
  const liquidityStatus = exposure.factorStatuses?.liquidity ?? exposure.status;
  const maturityStatus = exposure.factorStatuses?.maturity ?? exposure.status;
  const missingClass = exposure.assetClass === null || classStatus.observationState !== "known" || classStatus.applicability.state === "unresolved";
  const missingLiquidity = exposure.liquidityHorizon === null || exposure.liquidityHorizon === "unknown" ||
    liquidityStatus.observationState !== "known" || liquidityStatus.applicability.state === "unresolved";
  const missingMaturity = (exposure.maturityDaysMax === null || maturityStatus.observationState !== "known" ||
    maturityStatus.applicability.state === "unresolved") &&
    (missingClass || !backing.reserve.maturityNotApplicableClasses.some(value => value === exposure.assetClass));
  const suppliedClassQuality = exposure.assetClass === null ? backing.boundedUnknownQuality
    : backing.reserve.assetClassQuality[exposure.assetClass];
  const suppliedLiquidityQuality = exposure.liquidityHorizon === null ? backing.reserve.liquidityQuality.unknown
    : backing.reserve.liquidityQuality[exposure.liquidityHorizon];
  const suppliedMaturityQuality = scoreFromMaturity(exposure.assetClass ?? "other", exposure.maturityDaysMax, backing);
  // C/U labels do not erase an already supplied rung; they still prevent an adverse claim.
  const baseline = {
    liquidity: missingLiquidity ? Math.max(backing.reserve.liquidityQuality.unknown, suppliedLiquidityQuality) : suppliedLiquidityQuality,
    maturity: missingMaturity ? Math.max(backing.reserve.maturityUnknownQuality, suppliedMaturityQuality) : suppliedMaturityQuality,
  };
  const bounds = resolveV9ReserveFactorBounds(exposure, asset.reserveBoundFacts ?? [], backing, asset.asOfSec ?? 0, baseline);
  const weights = backing.reserve.factorWeights;
  const factors = [
    { key: "assetClass" as const, missing: missingClass, value: missingClass
      ? Math.max(backing.boundedUnknownQuality, suppliedClassQuality) : suppliedClassQuality, baseline: backing.boundedUnknownQuality,
      best: 100, coveredShare: 0, coveredQuality: null, weight: weights.assetQuality },
    { key: "liquidity" as const, missing: missingLiquidity, value: bounds.liquidity, baseline: baseline.liquidity,
      best: backing.reserve.liquidityQuality.immediate, coveredShare: bounds.liquidityCoveredShare,
      coveredQuality: bounds.liquidityCoveredQuality, weight: weights.liquidity },
    { key: "maturity" as const, missing: missingMaturity, value: bounds.maturity, baseline: baseline.maturity,
      best: 100, coveredShare: bounds.maturityCoveredShare, coveredQuality: bounds.maturityCoveredQuality, weight: weights.maturity },
  ];
  let weighted = 0, includedWeight = 0, adverseSupport = 0;
  const causes: NonNullable<V9BackingContribution["cause"]>[] = [];
  const causeGapIds: string[] = [];
  const traces: V9BackingFactorContribution[] = [];
  for (const factor of factors) {
    const status = exposure.factorStatuses?.[factor.key] ?? exposure.status;
    // A datum the policy marks not-applicable (maturity of cash-like classes) is
    // still scored at its policy rung, so it contributes as an included factor.
    const attribution = status.applicability.state === "not-applicable" && !factor.missing
      ? { cause: null, causeGapIds: [] as readonly string[], scoringDisposition: "included" as const }
      : v9BackingStatusCause(status, index, factor.missing && factor.coveredShare < 1);
    const excluded = attribution.cause === "A" || attribution.cause === "B";
    const coverage = factor.missing ? factor.coveredShare : 0;
    const remainingShare = 1 - coverage;
    if (remainingShare > 0 && attribution.cause !== null) {
      causes.push(attribution.cause); causeGapIds.push(...attribution.causeGapIds);
    }
    const coveredScore = coverage > 0 ? factor.coveredQuality! : 0;
    const remainingScore = excluded ? null : coverage > 0 ? factor.baseline : factor.value;
    const effectiveFactorWeight = factor.weight * (excluded ? coverage : 1);
    weighted += (coveredScore * coverage + (remainingScore ?? 0) * remainingShare) * factor.weight;
    includedWeight += effectiveFactorWeight;
    adverseSupport += (factor.missing ? coveredScore * coverage + factor.best * remainingShare : factor.value) * factor.weight;
    if (coverage > 0) traces.push({
      componentKey: `reserve:${exposure.exposureKey}:${factor.key}:covered`, score: coveredScore * sourceMultiplier,
      normalizedWeight: factor.weight * coverage, effectiveScoringWeight: factor.weight * coverage,
      cause: null, causeGapIds: [], scoringDisposition: "included",
    });
    if (remainingShare > 0) traces.push({
      componentKey: `reserve:${exposure.exposureKey}:${factor.key}${coverage > 0 ? ":uncovered" : ""}`,
      score: remainingScore === null ? null : remainingScore * sourceMultiplier, normalizedWeight: factor.weight * remainingShare,
      effectiveScoringWeight: excluded ? 0 : factor.weight * remainingShare, ...attribution,
    });
  }
  const totalWeight = weights.assetQuality + weights.liquidity + weights.maturity;
  // A/B factors are excluded from the row's renormalized score, so they control
  // the row only when every factor is excluded; otherwise only scored C/U/D can.
  const controllingCauses = includedWeight > 0 ? (["D", "C", "U"] as const) : (["A", "B"] as const);
  return { score: includedWeight > 0 ? weighted / includedWeight : null,
    adverseSupportScore: adverseSupport / totalWeight, evidenceRefIds: bounds.evidenceRefIds,
    cause: controllingCauses.find(cause => causes.includes(cause)) ?? null,
    causeGapIds: uniqueSorted(causeGapIds), factors: traces.map(row => ({ ...row,
      effectiveScoringWeight: includedWeight > 0 ? row.effectiveScoringWeight / includedWeight : 0 })) };
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
  readonly cause?: V9ResolvedUpstreamExposure["cause"];
  readonly causeGapIds?: readonly string[];
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
  knownFactorBound: number;
  materialityWeight: number;
  materialityThreshold: number;
}): { score: number | null; unresolved: V9BackingUnresolvedReason[] } {
  const {
    backing,
    policy,
    upstream,
    pathKey,
    knownFactorBound,
    materialityWeight,
    materialityThreshold,
  } = params;
  const cause = upstream.cause ?? "U";
  const upstreamScore = upstream.score ?? backing.boundedUnknownQuality;
  const score = upstream.score === null && (cause === "A" || cause === "B")
    ? null : Math.min(knownFactorBound, upstreamScore);
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
      resolveV9ReasonTreatment(policy, reason.code, reason.cause ?? "U").treatment === "ceiling"
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
    treatment: resolveV9ReasonTreatment(policy, code, reason.cause ?? "U").treatment,
    cause: reason.cause ?? "U",
    causeGapIds: reason.causeGapIds ?? [],
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
        resolveV9ReasonTreatment(policy, reason.code, reason.cause ?? "U").treatment === "NR" &&
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
        treatment: resolveV9ReasonTreatment(policy, unavailableCode, cause).treatment,
        cause,
        causeGapIds: upstream.causeGapIds ?? [],
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
    treatment: resolveV9ReasonTreatment(policy, unavailableCode).treatment,
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
    const classStatus = exposure.factorStatuses?.assetClass ?? exposure.status;
    const obligorStatus = exposure.factorStatuses?.obligorConcentration ?? exposure.status;
    if (exposure.assetClass !== "private-credit" || exposure.issuerOrObligorKey === null ||
      classStatus.observationState !== "known" || classStatus.evidenceRefIds.length === 0 ||
      obligorStatus.observationState !== "known" || obligorStatus.evidenceRefIds.length === 0) continue;
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
      group.measured && isV9MaterialShare(group.share, threshold)
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
  const classification = scoreV9ReserveExposureClassification(exposure, policy, asset, confidenceMultiplier);
  const rowCause = v9BackingStatusCause(exposure.status, gapIndex);
  const classificationCause = classification.cause;
  let cause = rowCause.cause ?? classificationCause ?? null;
  let causeGapIds = uniqueSorted([...rowCause.causeGapIds, ...classification.causeGapIds]);
  let excluded = (rowCause.cause === "A" || rowCause.cause === "B") || classification.score === null;
  const classifiedScore = (classification.score ?? backing.boundedUnknownQuality) * confidenceMultiplier;
  let score = state === "known" || state === "stale" ? classifiedScore : backing.boundedUnknownQuality * confidenceMultiplier;

  if (upstream) {
    const knownLocalAdverse = exposure.status.observationState === "known" &&
      exposure.status.evidenceRefIds.length > 0 &&
      classification.adverseSupportScore * confidenceMultiplier <= backing.structural.unsafeExposureQuality;
    const upstreamProjection = projectResolvedUpstreamReserveExposure({
      backing,
      policy,
      upstream,
      pathKey,
      // Missing factors cannot bind inheritance; independently known quality
      // and source strength still bound it without requiring an unsafe signal.
      knownFactorBound: classification.adverseSupportScore * confidenceMultiplier,
      materialityWeight,
      materialityThreshold: threshold,
    });
    const upstreamLimitBinds = upstreamProjection.score !== null && upstreamProjection.score < score - SCORE_EPSILON;
    if (upstreamProjection.score === null && !knownLocalAdverse) {
      excluded = true;
      cause = upstream.cause ?? "U";
    } else {
      score = upstreamProjection.score === null ? score : upstreamProjection.score;
      cause = knownLocalAdverse ? "D" : upstream.score === null ? upstream.cause ?? "U"
        : upstreamLimitBinds && (upstream.cause === "C" || upstream.cause === "U" || upstream.cause === "D") ? upstream.cause : cause;
    }
    causeGapIds = uniqueSorted([...causeGapIds, ...(upstream.causeGapIds ?? [])]);
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
        (code, cause) => resolveV9ReasonTreatment(policy, code, cause).treatment,
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
  if (exposure.assetClass !== null && (exposure.factorStatuses?.assetClass ?? exposure.status).observationState === "known" &&
    issuerConcentrationExemptClasses.has(exposure.assetClass)) {
    issuerConcentrationExemptComponentKeys.add(pathKey);
  }
  contributions.push({
    componentKey: pathKey,
    source: "reserve-exposure",
    score: excluded ? null : clampScore(score),
    normalizedWeight: exposure.weight,
    weightedScore: excluded ? 0 : exposure.weight * clampScore(score),
    observationState: state,
    provenance: exposure.provenance,
    evidenceRefIds: uniqueSorted([...exposure.status.evidenceRefIds, ...classification.evidenceRefIds]),
    failureDomains,
    upstreamAssetId: upstream?.upstreamAssetId ?? exposure.trackedAssetId,
    cause,
    causeGapIds,
    scoringDisposition: excluded ? cause === "B" ? "excluded-uncurated" : "excluded-pipeline"
      : cause === "C" || cause === "U" ? "bounded-uncertainty" : cause === "D" ? "measured-adverse" : "included",
    wholeAssetWeight: exposure.weight,
    effectiveScoringWeight: excluded ? 0 : exposure.weight,
    ...(state === "known" && !requiredUnknown && exposure.trackedAssetId === null ? { factors: classification.factors } : {}),
  });

  const material = isV9MaterialShare(materialityWeight, threshold);
  if (material && responsibility === "measured-adverse" && exposure.status.evidenceRefIds.length > 0 &&
    (exposure.factorStatuses?.assetClass ?? exposure.status).observationState === "known" &&
    exposure.assetClass === "private-credit" && exposure.issuerOrObligorKey === null) {
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
  if (!excluded && material && responsibility === "measured-adverse" &&
    exposure.status.evidenceRefIds.length > 0 &&
    classification.adverseSupportScore * confidenceMultiplier <= backing.structural.unsafeExposureQuality) {
    structuralReasons.push(
      createV9BackingStructuralReason(policy, backing.structural.unsafeExposureSignal, {
        responsibility: "measured-adverse",
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
  gapIndex: V9GapIndex;
  policy: V9BackingEvaluationPolicy;
  residual: NonNullable<V9BackingAssetInput["reserveResiduals"]>[number];
  threshold: number;
  contributions: V9BackingContribution[];
  unresolved: V9BackingUnresolvedReason[];
}): void {
  const { asset, backing, gapIndex, policy, residual, threshold, contributions, unresolved } = params;
  if (residual.weight <= 0) return;
  const material = isV9MaterialShare(residual.weight, threshold);
  const attribution = v9BackingStatusCause(residual.status, gapIndex, true);
  // Current admission prohibits D remainders: measured holdings are identified rows.
  const cause = attribution.cause as Exclude<NonNullable<V9BackingContribution["cause"]>, "D">;
  const excluded = cause === "A" || cause === "B";
  const pathKey = `reserve:unclassified-residual:${residual.residualId}`;
  const noAdmittedEnvelope = asset.reserveStatus.observationState !== "known" && asset.reserveExposures.length === 0 &&
    asset.reserveCompositionProvenance === undefined && asset.reserveCompositionEvidenceClass === undefined;
  const multiplier = noAdmittedEnvelope || asset.reserveCompositionProvenance === "live" || asset.reserveCompositionEvidenceClass === "independent"
    ? 1 : backing.reserve.issuerAttestedConfidenceMultiplier;
  const score = excluded ? null : backing.boundedUnknownQuality * multiplier;
  contributions.push({
    componentKey: pathKey, source: "reserve-exposure", score,
    normalizedWeight: residual.weight, weightedScore: (score ?? 0) * residual.weight,
    observationState: "bounded-unknown", provenance: asset.reserveCompositionProvenance ?? null,
    evidenceRefIds: uniqueSorted(residual.status.evidenceRefIds), failureDomains: [], upstreamAssetId: null,
    cause, causeGapIds: attribution.causeGapIds, wholeAssetWeight: residual.weight,
    effectiveScoringWeight: excluded ? 0 : residual.weight,
    scoringDisposition: excluded ? cause === "A" ? "excluded-pipeline" : "excluded-uncurated" : "bounded-uncertainty",
  });
  unresolved.push(...gapReasons(gapIndex, residual.status.gapIds, pathKey,
    material ? "material-unknown-reserve-exposure" : "bounded-unknown-reserve-exposure",
    (code) => resolveV9ReasonTreatment(policy, code, cause).treatment));
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
        group.measured &&
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
  gapIndex: V9GapIndex;
  domainGroups: readonly ReserveDomainConcentrationGroup[];
  contributions: V9BackingContribution[];
}): number | null {
  const { asset, backing, gapIndex, domainGroups, contributions } = params;
  const maximumDomainShare = domainGroups.reduce((maximum, group) => Math.max(maximum, group.share), 0);
  const measuredConcentration = concentrationScore(maximumDomainShare, backing);
  let includedShare = 0, boundedShare = 0, unidentifiedShare = 0;
  const causeGapIds: string[] = [];
  const causes: NonNullable<V9BackingContribution["cause"]>[] = [];
  for (const row of contributions.filter(entry => entry.source === "reserve-exposure")) {
    const exposure = asset.reserveExposures.find(entry => `reserve:${entry.exposureKey}` === row.componentKey);
    const classStatus = exposure?.factorStatuses?.assetClass ?? exposure?.status;
    const exempt = classStatus?.observationState === "known" && exposure?.assetClass != null &&
      (backing.reserve.sovereignConcentrationExemptClasses.some(value => value === exposure.assetClass) ||
        backing.reserve.nonCounterpartyReserveIssuerConcentrationExemptClasses.some(value => value === exposure.assetClass));
    const status = exposure?.factorStatuses?.obligorConcentration ?? exposure?.status;
    const unknown = exposure === undefined || (!exempt && (exposure.issuerOrObligorKey === null ||
      status?.observationState !== "known" || status.applicability.state === "unresolved"));
    const attribution = row.scoringDisposition === "excluded-pipeline" || row.scoringDisposition === "excluded-uncurated" || exposure === undefined
      ? { cause: row.cause ?? "U", causeGapIds: row.causeGapIds ?? [] }
      : v9BackingStatusCause(status!, gapIndex, unknown);
    if (attribution.cause !== null) { causes.push(attribution.cause); causeGapIds.push(...attribution.causeGapIds); }
    if (attribution.cause === "A" || attribution.cause === "B") continue;
    includedShare += row.normalizedWeight;
    if (unknown) boundedShare += row.normalizedWeight;
    if (exposure === undefined) unidentifiedShare += row.normalizedWeight;
  }
  // An empty issuer/custodian census proves no diversification. Keep the
  // identified-domain baseline for partial frames; wholly unknown domains
  // use the bounded rung rather than concentrationScore(0)'s best credit.
  const unknownDomainShare = domainGroups.length === 0 ? boundedShare : unidentifiedShare;
  const concentration = includedShare > 0
    ? (measuredConcentration * (includedShare - unknownDomainShare) + backing.boundedUnknownQuality * unknownDomainShare) / includedShare : null;
  // A/B rows are excluded from the concentration share, so they control it only when nothing is included.
  const cause = (concentration === null ? (["A", "B"] as const) : (["D", "C", "U"] as const))
    .find(candidate => causes.includes(candidate)) ?? null;
  contributions.push({
    componentKey: "reserve:concentration", source: "reserve-concentration", score: concentration,
    normalizedWeight: backing.reserve.concentrationWeight,
    weightedScore: (concentration ?? 0) * backing.reserve.concentrationWeight,
    observationState: boundedShare > 0 ? "bounded-unknown" : asset.reserveStatus.observationState,
    provenance: null, evidenceRefIds: uniqueSorted(asset.reserveStatus.evidenceRefIds),
    failureDomains: canonicalDomains(domainGroups.map((group) => group.domain)), upstreamAssetId: null,
    cause, causeGapIds: uniqueSorted(causeGapIds), wholeAssetWeight: null,
    effectiveScoringWeight: concentration === null ? 0 : backing.reserve.concentrationWeight,
    scoringDisposition: concentration === null ? cause === "B" ? "excluded-uncurated" : "excluded-pipeline"
      : cause === "C" || cause === "U" ? "bounded-uncertainty" : cause === "D" ? "measured-adverse" : "included",
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
        (code, cause) => resolveV9ReasonTreatment(policy, code, cause).treatment,
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

  const residuals = asset.reserveResiduals ?? (totalWeight < 1
    ? [{ residualId: "unidentified", weight: 1 - totalWeight, status: asset.reserveStatus }] : []);
  if (Math.abs(totalWeight + residuals.reduce((sum, row) => sum + row.weight, 0) - 1) > SCORE_EPSILON) {
    throw new Error("Reserve holdings and disjoint remainders do not conserve the whole-asset denominator");
  }
  for (const residual of residuals) appendResidualReserveExposure({
    asset, backing, gapIndex, policy, residual, threshold, contributions, unresolved,
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
    gapIndex,
    domainGroups,
    contributions,
  });

  const exposureContributions = contributions.filter((entry) => entry.source === "reserve-exposure");
  const qualityWeight = exposureContributions.reduce((sum, row) => sum + (row.effectiveScoringWeight ?? row.normalizedWeight), 0);
  const exposureScore = qualityWeight > 0
    ? exposureContributions.reduce((sum, row) => sum + row.weightedScore, 0) / qualityWeight : null;
  const concentrationWeight = concentration === null ? 0 : backing.reserve.concentrationWeight;
  const exposureGroupWeight = exposureScore === null ? 0 : 1 - backing.reserve.concentrationWeight;
  const groupWeight = exposureGroupWeight + concentrationWeight;
  const reserveScore = groupWeight > 0 ? ((exposureScore ?? 0) * exposureGroupWeight +
    (concentration ?? 0) * concentrationWeight) / groupWeight : null;
  return {
    score: reserveScore === null ? null : clampScore(decimalSnap(reserveScore)),
    contributions: contributions.map(row => normalizeV9BackingContribution(row.source === "reserve-exposure"
      ? { ...row, effectiveScoringWeight: qualityWeight > 0 ? (row.effectiveScoringWeight ?? row.normalizedWeight) / qualityWeight : 0 }
      : row)),
    structuralReasons,
    unresolved,
    rateability: "rateable",
  };
}
