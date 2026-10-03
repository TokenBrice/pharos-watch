import type { V9ReserveBoundedFact } from "../../types/reserve-bounded-facts";
import type { V9EvidenceCause, V9RatingStatus, V9ScoringDisposition } from "../../types/safety-score-v9-causes";
import type { V9ReserveResidualFact } from "../../types/safety-score-v9-fact-primitives";
import { gapsForV9Ids } from "./gap-index";
import { uniqueSorted, V9_EMPTY_ARRAY } from "./primitives";
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
import type { V9MechanismFactV1, V9MechanismMetricApplicability } from "../../types/safety-score-v9-backing";
import { assertV9ValidatedPolicyEnvelope } from "./policy";
import { projectGapReasons, type V9GapIndex } from "./gap-index";

export type ReserveAssetClass = NonNullable<V9ReserveExposureFactV2["assetClass"]>;
export interface V9ResolvedUpstreamExposure {
  readonly exposureKey: string;
  readonly upstreamAssetId: string;
  readonly score: number | null;
  readonly cause?: V9EvidenceCause | null;
  readonly ratingStatus?: V9RatingStatus;
  readonly causeGapIds?: readonly string[];
  readonly limitedEvidenceCauses?: readonly V9EvidenceCause[];
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
    readonly cause?: V9EvidenceCause | null;
    readonly ratingStatus?: V9RatingStatus;
    readonly causeGapIds?: readonly string[];
    readonly limitedEvidenceCauses?: readonly V9EvidenceCause[];
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
  /** Controlling provenance of the parent's backing score, not a local owner label. */
  readonly cause?: Exclude<V9EvidenceCause, "A" | "B"> | null;
  readonly causeGapIds?: readonly string[];
  /** Mapped weight of the single collateral/wrapper edge (≈1). */
  readonly weight: number;
  /**
   * "pure": a 1:1 holding wrapper (mint/redeem against the parent) — a thin
   * contract layer. "wrapped": an ERC-4626 vault / staked / lending / bridged
   * variant — a materially larger contract + share-accounting layer.
   */
  readonly tier: "pure" | "wrapped";
  readonly failureDomains: readonly V9FailureDomainRef[];
  readonly collateralizationApplications?: readonly V9CollateralizationApplication[];
}

export interface V9BackingAssetInput {
  readonly assetId: string;
  readonly reserveStatus: V9AssetFactsBase["reserveStatus"];
  readonly reserveExposures: readonly V9ReserveExposureFactV2[];
  readonly reserveResiduals?: readonly V9ReserveResidualFact[];
  readonly reserveCompositionEvidenceClass?: V9ReserveExposureFactV2["evidenceClass"];
  readonly reserveCompositionProvenance?: V9ReserveExposureFactV2["provenance"];
  readonly reserveBoundFacts?: readonly V9ReserveBoundedFact[];
  readonly gaps: readonly (V9FactGapV2 | V9FactGapV3)[];
  readonly gapIndex?: V9GapIndex;
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
  /** Evaluation clock; absent means a dated collateralization fact cannot be admitted. */
  readonly asOfSec?: number;
}

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
export type V9BackingSemanticPolicy = V9ValidatedPolicyEnvelope["policy"]["semantic"]["backing"];
export type V9BackingSignalRule = V9BackingSemanticPolicy["structural"]["unsafeExposureSignal"];

export interface V9BackingStructuralReason {
  readonly kind: V9StructuralSignalKind;
  readonly severity: V9Severity;
  readonly responsibility: V9EvidenceResponsibility;
  readonly pathKey: string;
  readonly metricApplicability?: V9MechanismMetricApplicability["state"];
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

export interface V9BackingFactorContribution {
  readonly componentKey: string;
  readonly score: number | null;
  readonly normalizedWeight: number;
  readonly effectiveScoringWeight: number;
  readonly cause: V9EvidenceCause | null;
  readonly causeGapIds: readonly string[];
  readonly scoringDisposition: V9ScoringDisposition;
}

export interface V9BackingContribution {
  readonly componentKey: string;
  readonly source: "reserve-exposure" | "reserve-concentration" | "mechanism";
  readonly score: number | null;
  readonly normalizedWeight: number;
  readonly weightedScore: number;
  readonly observationState: V9FactStatusV2["observationState"];
  readonly provenance: V9ReserveExposureFactV2["provenance"] | null;
  readonly evidenceRefIds: readonly string[];
  readonly failureDomains: readonly V9FailureDomainRef[];
  readonly upstreamAssetId: string | null;
  readonly cause?: V9EvidenceCause | null;
  readonly causeGapIds?: readonly string[];
  readonly scoringDisposition?: V9ScoringDisposition;
  readonly wholeAssetWeight?: number | null;
  readonly effectiveScoringWeight?: number;
  readonly factors?: readonly V9BackingFactorContribution[];
}

export interface V9EffectiveBackingContribution extends V9BackingContribution {
  readonly effectiveWeight: number;
  readonly cause: V9EvidenceCause | null;
  readonly causeGapIds: readonly string[];
  readonly scoringDisposition: V9ScoringDisposition;
  readonly wholeAssetWeight: number | null;
  readonly effectiveScoringWeight: number;
}

export interface V9BackingUnresolvedReason {
  readonly code: V9ReasonCode;
  readonly pathKey: string;
  readonly gapIds: readonly string[];
  readonly treatment: "pillar" | "ceiling" | "NR" | "diagnostic";
  readonly cause?: V9EvidenceCause | null;
  readonly causeGapIds?: readonly string[];
  /** Explicit causal owner for synthetic or propagated reasons without a local gap. */
  readonly responsibility?: V9EvidenceResponsibility;
  /** Stable source identity when several synthetic reasons share one public base path. */
  readonly causalKey?: string;
}

export interface V9CollateralizationApplication {
  readonly measurementId: string;
  readonly measuredAt: string;
  readonly ratio: number;
  readonly evidenceRefIds: readonly string[];
  readonly appliedByAssetId: string;
  /** Immediate parent whose score already includes this application. */
  readonly inheritedFromAssetId: string | null;
}

export interface V9BackingResult {
  readonly assetId: string;
  readonly archetype: string;
  readonly policyId: string;
  readonly policySemanticDigest: string;
  readonly rateability: "rateable" | "NR";
  readonly score: number | null;
  readonly aggregationDisposition: "included" | "excluded-a-b";
  readonly causeGapIds: readonly string[];
  readonly limitedEvidenceCauses: readonly V9EvidenceCause[];
  readonly supportedComponentKeys: readonly string[];
  readonly pillarCeiling: number | null;
  readonly contributions: readonly V9EffectiveBackingContribution[];
  readonly structuralReasons: readonly V9BackingStructuralReason[];
  readonly unresolved: readonly V9BackingUnresolvedReason[];
  readonly evidenceRefIds: readonly string[];
  readonly failureDomains: readonly V9FailureDomainRef[];
  readonly collateralizationApplications?: readonly V9CollateralizationApplication[];
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

export const SCORE_EPSILON = 0.000001;

const STRUCTURAL_SIGNAL_PERCENT_ROUNDING_EPSILON = 0.0001;

export function v9StructuralSignalSharePct(
  assetId: string,
  fieldPath: string,
  share: number,
): number {
  const rawValue = share * 100;
  if (rawValue > 100 && rawValue <= 100 + STRUCTURAL_SIGNAL_PERCENT_ROUNDING_EPSILON) {
    console.warn("safety_score_v9_structural_signal_percentage_clamped", {
      assetId,
      fieldPath,
      rawValue,
      arithmetic: `${share} * 100`,
    });
    return 100;
  }
  return rawValue;
}

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
export function gapReasons(
  index: V9GapIndex,
  gapIds: readonly string[],
  pathKey: string,
  fallbackCode: V9ReasonCode,
  treatmentFor: (code: V9ReasonCode, cause: V9EvidenceCause) => V9BackingUnresolvedReason["treatment"],
): V9BackingUnresolvedReason[] {
  return projectGapReasons({
    index,
    gapIds,
    path: pathKey,
    fallbackCode,
    treatmentFor,
  }).map(({ path, message: _message, ...reason }) => ({ ...reason, pathKey: path }));
}
export function assertV9BackingPolicy(policy: V9BackingEvaluationPolicy): void {
  assertV9ValidatedPolicyEnvelope(policy);
}

export function backingPolicy(policy: V9BackingEvaluationPolicy): V9BackingSemanticPolicy {
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

export interface ReserveEvaluation {
  readonly score: number | null;
  readonly contributions: readonly V9BackingContribution[];
  readonly structuralReasons: readonly V9BackingStructuralReason[];
  readonly unresolved: readonly V9BackingUnresolvedReason[];
  readonly rateability: "rateable" | "NR";
}

/** Legacy construction sites are normalized once; missing labels never authorize relief. */
export function normalizeV9BackingContribution<T extends V9BackingContribution>(
  row: T,
): T & Pick<V9EffectiveBackingContribution,
  "cause" | "causeGapIds" | "scoringDisposition" | "wholeAssetWeight" | "effectiveScoringWeight"> {
  const cause = row.cause === undefined ? (row.observationState === "known" ? null : "U") : row.cause;
  return {
    ...row,
    cause,
    causeGapIds: row.causeGapIds ?? V9_EMPTY_ARRAY,
    scoringDisposition: row.scoringDisposition ?? (cause === null ? "included" : cause === "D"
      ? "measured-adverse" : cause === "A" ? "excluded-pipeline" : cause === "B"
        ? "excluded-uncurated" : "bounded-uncertainty"),
    wholeAssetWeight: row.wholeAssetWeight === undefined
      ? row.source === "reserve-exposure" ? row.normalizedWeight : null : row.wholeAssetWeight,
    effectiveScoringWeight: row.effectiveScoringWeight ?? (row.score === null ? 0 : row.normalizedWeight),
  };
}

export function v9BackingStatusCause(
  status: V9FactStatusV2,
  index: V9GapIndex,
  missing = status.observationState !== "known" || status.applicability.state === "unresolved",
): { cause: V9EvidenceCause | null; causeGapIds: readonly string[]; scoringDisposition: V9ScoringDisposition } {
  if (status.applicability.state === "not-applicable") {
    return { cause: null, causeGapIds: V9_EMPTY_ARRAY, scoringDisposition: "not-applicable" };
  }
  if (!missing) return { cause: null, causeGapIds: V9_EMPTY_ARRAY, scoringDisposition: "included" };
  const gaps = gapsForV9Ids(index, status.gapIds);
  const causes = gaps.map(gap => "causeProof" in gap ? gap.causeProof.cause : "U");
  const cause = (["D", "C", "U", "A", "B"] as const).find(candidate => causes.includes(candidate)) ?? "U";
  const ids = status.gapIds;
  const causeGapIds = ids.length === 0 ? V9_EMPTY_ARRAY
    : ids.every((id, index) => index === 0 || id > ids[index - 1]!) ? ids : uniqueSorted(ids);
  return { cause, causeGapIds,
    scoringDisposition: cause === "A" ? "excluded-pipeline" : cause === "B" ? "excluded-uncurated"
      : cause === "D" ? "measured-adverse" : "bounded-uncertainty" };
}
