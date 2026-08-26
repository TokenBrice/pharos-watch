import type {
  V9AssetFactsBase,
  V9EvidenceResponsibility,
  V9FailureDomainRef,
  V9FactGapV2,
  V9FactGapV3,
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
export type { V9MechanismFactV1 } from "../../types/safety-score-v9-backing";
import type { V9MechanismFactV1 } from "../../types/safety-score-v9-backing";
import { clampScore } from "../math";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";
import { decimalSnap } from "./formula";
import { assertV9ValidatedPolicyEnvelope, resolveV9ReasonPolicy } from "./policy";
import { canonicalDomains, compareText, domainKey, uniqueSorted } from "./primitives";

type ReserveAssetClass = NonNullable<V9ReserveExposureFactV2["assetClass"]>;
export interface V9ResolvedUpstreamExposure {
  readonly exposureKey: string;
  readonly upstreamAssetId: string;
  readonly score: number | null;
  readonly evidenceLevel: V9EvidenceLevel;
  readonly reasonCodes: readonly V9ReasonCode[];
  /**
   * Reason-level provenance from the upstream backing pillar. Older retained
   * fixtures may omit this and continue to use `reasonCodes`; production
   * evaluation always supplies it so downstream availability facts retain the
   * causal owner instead of defaulting to Pharos integration.
   */
  readonly reasons?: readonly {
    readonly code: V9ReasonCode;
    /** Stable upstream score path used to distinguish mixed causal roots. */
    readonly path?: string;
    readonly responsibility: V9EvidenceResponsibility;
  }[];
  readonly failureDomains: readonly V9FailureDomainRef[];
  /**
   * Terminal unavailable-asset roots this exposure ultimately depends on,
   * propagated through wrappers by the evaluator. Materiality aggregates by
   * these roots so a failure reachable through several immediate upstreams
   * cannot be split below the threshold (VER2-001). Absent (unit callers) →
   * derived from the upstream's reserve-issuer/custodian failure domains, then
   * the immediate identity.
   */
  readonly failureRootAssetIds?: readonly string[];
}

/**
 * A wrapper whose entire reserve is a single tracked, rated stablecoin (or other
 * rated tracked asset) inherits that parent's backing quality. The wrapper's
 * reserve IS the parent asset, so the parent's backing pillar — which already
 * prices the parent's own reserve quality, custody and internal concentration —
 * is the accurate backing signal, far more so than the fail-closed
 * bounded-unknown floor a missing live/attested composition otherwise gets.
 */
export interface V9InheritedStablecoinBacking {
  readonly parentAssetId: string;
  /** The parent's raw backing pillar score (pre composite caps). */
  readonly parentBackingScore: number;
  /** Mapped weight of the single collateral/wrapper edge (≈1). */
  readonly weight: number;
  /**
   * "pure": a 1:1 holding wrapper (mint/redeem against the parent) — a thin
   * contract layer. "wrapped": an ERC-4626 vault / staked / lending / bridged
   * variant — a materially larger contract + share-accounting layer.
   */
  readonly tier: "pure" | "wrapped";
  readonly failureDomains: readonly V9FailureDomainRef[];
}

export interface V9BackingAssetInput {
  readonly assetId: string;
  readonly reserveStatus: V9AssetFactsBase["reserveStatus"];
  readonly reserveExposures: readonly V9ReserveExposureFactV2[];
  readonly gaps: readonly (V9FactGapV2 | V9FactGapV3)[];
  readonly resolvedUpstreamExposures: readonly V9ResolvedUpstreamExposure[];
  readonly seriallyResolvedUpstreamAssetIds?: readonly string[];
  readonly unresolvedUpstreamProjectionAttributions?: readonly {
    readonly causalKey: string;
    readonly responsibility: V9EvidenceResponsibility;
  }[];
  readonly cdpLiquidationCapacitySelection?: V9CdpLiquidationCapacitySelection;
  readonly inheritedStablecoinBacking?: V9InheritedStablecoinBacking;
  /** Conservative measured months since launch; absent → no seasoning credit. */
  readonly trackRecordMonths?: number;
}

/** Minimum mapped single-parent weight for a wrapper to qualify as ~100% backed. */
export const V9_WRAPPER_INHERITANCE_MIN_PARENT_WEIGHT = 0.99;

export interface V9CdpLiquidationCapacitySelection {
  readonly selectedPath: "stress-measurement" | "legacyLCR";
  readonly coverageRatio: number | null;
  readonly reason: string;
  readonly fallbackReason: string | null;
  readonly measurementAgeSec: number | null;
  readonly selectedEvidenceRefIds: readonly string[];
  readonly stressEvidenceRefIds: readonly string[];
}

export type V9BackingEvaluationPolicy = V9ValidatedPolicyEnvelope;
type V9BackingSemanticPolicy = V9ValidatedPolicyEnvelope["policy"]["semantic"]["backing"];
export type V9BackingSignalRule = V9BackingSemanticPolicy["structural"]["unsafeExposureSignal"];

export interface V9BackingStructuralReason {
  readonly kind: V9StructuralSignalKind;
  readonly severity: V9Severity;
  readonly responsibility: V9EvidenceResponsibility;
  readonly pathKey: string;
  readonly materialShare: number | null;
  readonly ceiling: number;
  readonly evidenceRefIds: readonly string[];
  readonly failureDomains: readonly V9FailureDomainRef[];
}

export function v9StructuralResponsibilityForStatus(
  status: V9FactStatusV2,
): V9EvidenceResponsibility {
  return status.applicability.state === "required" && status.observationState === "known"
    ? "measured-adverse"
    : "integration-missing";
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
  /** Explicit causal owner for synthetic or propagated reasons without a local gap. */
  readonly responsibility?: V9EvidenceResponsibility;
  /** Stable source identity when several synthetic reasons share one public base path. */
  readonly causalKey?: string;
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

/**
 * The single materiality predicate shared by projection (evaluate-set) and
 * backing: a share is material once it reaches the threshold within float
 * noise. Using one epsilon-tolerant contract in both places keeps the public
 * dependency reason and the structural cap from disagreeing on an exact
 * partition (VER2-010).
 */
export function isV9MaterialShare(weight: number, threshold: number): boolean {
  return weight + SCORE_EPSILON >= threshold;
}

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
    .filter((gap): gap is V9FactGapV2 | V9FactGapV3 => gap !== undefined)
    .map((gap) => ({
      code: gap.reasonCode,
      pathKey,
      gapIds: [gap.gapId],
      treatment,
      ...("responsibility" in gap ? { responsibility: gap.responsibility } : {}),
    }));
  return reasons.length > 0 ? reasons : [{ code: fallbackCode, pathKey, gapIds: uniqueSorted(gapIds), treatment }];
}

/** Like gapReasons, but each reason carries its policy-declared treatment instead of a caller-fixed one. */
function policyGapReasons(
  asset: V9BackingAssetInput,
  gapIds: readonly string[],
  pathKey: string,
  fallbackCode: V9ReasonCode,
  policy: V9BackingEvaluationPolicy,
): V9BackingUnresolvedReason[] {
  const treatmentFor = (code: V9ReasonCode) => resolveV9ReasonPolicy(policy, code).reason.defaultTreatment;
  if (gapIds.length === 0) {
    return [{ code: fallbackCode, pathKey, gapIds: [], treatment: treatmentFor(fallbackCode) }];
  }
  const reasons = gapIds
    .map((gapId) => asset.gaps.find((gap) => gap.gapId === gapId))
    .filter((gap): gap is V9FactGapV2 | V9FactGapV3 => gap !== undefined)
    .map((gap) => ({
      code: gap.reasonCode,
      pathKey,
      gapIds: [gap.gapId],
      treatment: treatmentFor(gap.reasonCode),
      ...("responsibility" in gap ? { responsibility: gap.responsibility } : {}),
    }));
  return reasons.length > 0
    ? reasons
    : [{ code: fallbackCode, pathKey, gapIds: uniqueSorted(gapIds), treatment: treatmentFor(fallbackCode) }];
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

function verifiedLiveInheritedExposure(
  asset: V9BackingAssetInput,
  inherited: V9InheritedStablecoinBacking,
): V9ReserveExposureFactV2 | undefined {
  if (
    asset.reserveStatus.applicability.state !== "required" ||
    asset.reserveStatus.observationState !== "known" ||
    asset.reserveExposures.length !== 1
  ) {
    return undefined;
  }
  const exposure = asset.reserveExposures[0]!;
  return exposure.provenance === "live" &&
    exposure.status.applicability.state === "required" &&
    exposure.status.observationState === "known" &&
    exposure.trackedAssetId === inherited.parentAssetId &&
    exposure.weight >= V9_WRAPPER_INHERITANCE_MIN_PARENT_WEIGHT
    ? exposure
    : undefined;
}

/**
 * Reserve evaluation for a stablecoin-collateralized wrapper: the whole reserve
 * is one tracked, rated parent, so the reserve score is the parent's backing
 * pillar. Wrapper-local accounting, control, and withdrawal risk belong in the
 * wrapper's own pillars; incomplete local review is handled once by the
 * fact-aware parent limit. Concentration is intentionally NOT re-penalized —
 * the parent's backing pillar already prices its own internal diversification.
 * Returns null (defer to the generic path) when the inherited quality does not
 * exceed the bounded-unknown floor: a weak parent is no evidence to credit above
 * the fail-closed baseline.
 */
function inheritedStablecoinReserveEvaluation(
  asset: V9BackingAssetInput,
  inherited: V9InheritedStablecoinBacking,
  policy: V9BackingEvaluationPolicy,
): ReserveEvaluation | null {
  const backing = backingPolicy(policy);
  const weight = Math.max(0, Math.min(1, inherited.weight));
  const inheritedQuality = clampScore(inherited.parentBackingScore);
  // Any sub-1 residual stays at the fail-closed bounded-unknown quality.
  const score = clampScore(decimalSnap(inheritedQuality * weight + backing.boundedUnknownQuality * (1 - weight)));
  if (score <= backing.boundedUnknownQuality + SCORE_EPSILON) return null;
  const liveExposure = verifiedLiveInheritedExposure(asset, inherited);
  const evidenceRefIds = uniqueSorted([
    ...asset.reserveStatus.evidenceRefIds,
    ...(liveExposure?.status.evidenceRefIds ?? []),
  ]);
  const failureDomains = canonicalDomains(inherited.failureDomains);
  const componentKey = `reserve:inherited-backing:${inherited.parentAssetId}`;
  const observationState = liveExposure === undefined ? "bounded-unknown" : "known";
  const provenance = liveExposure?.provenance ?? null;
  const reserveGapAttributions = [
    ...new Map(
    asset.reserveStatus.gapIds.flatMap((gapId) => {
      const gap = asset.gaps.find((candidate) => candidate.gapId === gapId);
      return gap !== undefined && "responsibility" in gap
        ? [[
            `${gap.gapId}\u0000${gap.responsibility}`,
            {
              causalKey: gap.gapId,
              responsibility: gap.responsibility,
            },
          ] as const]
        : [];
    }),
    ).values(),
  ].sort(
    (left, right) =>
      compareText(left.causalKey, right.causalKey) ||
      compareText(left.responsibility, right.responsibility),
  );
  return {
    score,
    contributions: [
      {
        componentKey,
        source: "reserve-exposure",
        score,
        normalizedWeight: 1,
        weightedScore: score,
        observationState,
        provenance,
        evidenceRefIds,
        failureDomains,
        upstreamAssetId: inherited.parentAssetId,
      },
      {
        componentKey: "reserve:concentration",
        source: "reserve-concentration",
        score,
        normalizedWeight: backing.reserve.concentrationWeight,
        weightedScore: score * backing.reserve.concentrationWeight,
        observationState,
        provenance,
        evidenceRefIds,
        failureDomains,
        upstreamAssetId: null,
      },
    ],
    structuralReasons: [],
    unresolved:
      liveExposure === undefined
        ? (reserveGapAttributions.length > 0
            ? reserveGapAttributions
            : [undefined]
          ).map((attribution) => ({
            code: "partial-reserve-review",
            pathKey: componentKey,
            gapIds: [],
            treatment: resolveV9ReasonPolicy(policy, "partial-reserve-review").reason.defaultTreatment,
            ...(attribution === undefined
              ? {}
              : {
                  responsibility: attribution.responsibility,
                  causalKey: attribution.causalKey,
                }),
          }))
        : [],
    rateability: "rateable",
  };
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
  return [
    ...new Map(
      (upstream.reasons ?? upstream.reasonCodes.map((code) => ({
        code,
        path: undefined,
        responsibility: undefined,
      }))).map(
        (reason) => [
          `${reason.code}\u0000${reason.path ?? ""}\u0000${reason.responsibility ?? ""}`,
          reason,
        ],
      ),
    ).values(),
  ].sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.path ?? "", right.path ?? "") ||
      compareText(left.responsibility ?? "", right.responsibility ?? ""),
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
  const projected = projectedSources.map((reason) => {
    const code: V9ReasonCode =
      upstream.score !== null &&
      resolveV9ReasonPolicy(policy, reason.code).reason.defaultTreatment === "ceiling"
        ? "bounded-unknown-reserve-exposure"
        : reason.code;
    return { ...reason, sourceCode: reason.code, code };
  });
  const projectedCodeCounts = new Map<V9ReasonCode, number>();
  for (const reason of projected) {
    projectedCodeCounts.set(
      reason.code,
      (projectedCodeCounts.get(reason.code) ?? 0) + 1,
    );
  }

  const unresolved: V9BackingUnresolvedReason[] = projected.map((reason) => ({
    code: reason.code,
    pathKey,
    gapIds: [],
    treatment: resolveV9ReasonPolicy(policy, reason.code).reason.defaultTreatment,
    ...(reason.responsibility === undefined ? {} : { responsibility: reason.responsibility }),
    ...((projectedCodeCounts.get(reason.code) ?? 0) > 1
      ? {
          causalKey: `upstream:${upstream.upstreamAssetId}:${reason.sourceCode}:${reason.path ?? "unattributed"}`,
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
  const attributions = [
    ...new Map(
      (asset.unresolvedUpstreamProjectionAttributions ?? []).map(
        (attribution) => [
          `${attribution.causalKey}\u0000${attribution.responsibility}`,
          attribution,
        ],
      ),
    ).values(),
  ].sort(
    (left, right) =>
      compareText(left.causalKey, right.causalKey) ||
      compareText(left.responsibility, right.responsibility),
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
        asset,
        exposure.status.gapIds,
        pathKey,
        material ? "ceiling" : "pillar",
        material ? "material-unknown-reserve-exposure" : "bounded-unknown-reserve-exposure",
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
      ? inheritedStablecoinReserveEvaluation(asset, asset.inheritedStablecoinBacking, policy)
      : null;
  if (inheritedReserve !== null) return inheritedReserve;
  if (asset.reserveStatus.applicability.state === "unresolved") {
    const unresolved = policyGapReasons(
      asset,
      asset.reserveStatus.gapIds,
      "reserve-envelope",
      "unreviewed-reserve-envelope",
      policy,
    );
    if (unresolved.some((reason) => reason.treatment === "NR")) {
      return { score: null, contributions: [], structuralReasons: [], unresolved, rateability: "NR" };
    }
    return boundedUnknownReserveEvaluation(asset, unresolved, policy);
  }
  if (asset.reserveStatus.observationState === "missing" || asset.reserveStatus.observationState === "unsupported") {
    const unresolved = policyGapReasons(
      asset,
      asset.reserveStatus.gapIds,
      "reserve-envelope",
      "missing-reserve-composition",
      policy,
    );
    if (unresolved.some((reason) => reason.treatment === "NR")) {
      return { score: null, contributions: [], structuralReasons: [], unresolved, rateability: "NR" };
    }
    return boundedUnknownReserveEvaluation(asset, unresolved, policy);
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
      ...gapReasons(asset, asset.reserveStatus.gapIds, "reserve-envelope", "ceiling", "partial-reserve-review"),
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

function finalizeBackingResult(result: Omit<V9BackingResult, "traceDigest">): V9BackingResult {
  const unresolved = [
    ...new Map(
      result.unresolved.map((reason) => [
        [
          reason.code,
          reason.pathKey,
          reason.treatment,
          uniqueSorted(reason.gapIds).join(","),
          reason.causalKey ?? "",
          reason.responsibility ?? "",
        ].join("\u0000"),
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
    unresolved: unresolved.sort(
      (left, right) =>
        compareText(left.code, right.code) ||
        compareText(left.pathKey, right.pathKey) ||
        compareText(left.causalKey ?? "", right.causalKey ?? "") ||
        compareText(left.responsibility ?? "", right.responsibility ?? ""),
    ),
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
  const archetypePolicy = backing.archetypes[input.archetype];
  const expectedKeys = Object.keys(archetypePolicy.componentWeights).sort(compareText);
  const actualKeys = input.components.map((component) => component.componentKey).sort(compareText);
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`Safety Score v9 ${input.archetype} mechanism component contract does not match policy`);
  }

  const reserve = evaluateV9ReserveExposures(input.asset, policy);
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
      contributions: reserve.contributions,
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
      unresolved.push(...gapReasons(input.asset, component.fact.status.gapIds, pathKey, "NR", "critical-unresolved"));
    } else if (state !== "known") {
      unresolved.push(
        ...(mode === "bounded-whole-review-absence"
          ? policyGapReasons(input.asset, component.fact.status.gapIds, pathKey, "missing-pillar-evidence", policy)
          : gapReasons(
              input.asset,
              component.fact.status.gapIds,
              pathKey,
              state === "stale" ? "ceiling" : "pillar",
              state === "stale" ? "insufficient-evidence" : "critical-unresolved",
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
  const gapCodes = unavailableReview.mechanismRiskReview.status.gapIds.flatMap((gapId) => {
    const gap = asset.gaps.find((candidate) => candidate.gapId === gapId);
    return gap ? [gap.reasonCode] : [];
  });
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
