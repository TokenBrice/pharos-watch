import type { V9ReasonCode, V9ValidatedPolicyEnvelope } from "../../types/safety-score-v9";
import type { V9AssetFactsBase, V9ExitRouteFactV2, V9FactStatusV2, V9FactGapV3 } from "../../types/safety-score-v9-facts";
import type { ExitExecutionCertificate, ExitRouteObservationHistory, PhysicalToUsdTrace, ExitRouteCapacityEvidenceTier } from "../../types/exit-route";
import type { V9CauseContribution, V9ConfidenceDimensions, V9EvidenceCause } from "../../types/safety-score-v9-causes";
import type {
  RedemptionAccessModel,
  RedemptionExecutionModel,
  RedemptionOutputAssetType,
  RedemptionSettlementModel,
} from "../../types/redemption";
import type { RedemptionRouteSuspension } from "../../types/redemption";
import {
  blendExitCapacityComponent,
  firstPositiveExitBreakpointValue,
  hasMaterialExitCapacity,
  interpolateExitBreakpointScore,
  resolveExitDelayBandMultiplier,
  resolveExitScoringRequest,
  resolveExitThresholdBandMultiplier,
} from "../exit-route-scoring";
import { clampScore, roundTo } from "../math";
import { assertV9ValidatedPolicyEnvelope } from "./policy";
import { resolveV9StatusCauses, v9ScoringDisposition } from "./control-primitives";
import { compareText, domainDigest, uniqueSorted } from "./primitives";
import { admitExitExecutionCertificate, exitExecutionInputGenerationId, resolveExitExecutionRequestPoint } from "./exit-execution";

export type V9ExitAccess = RedemptionAccessModel;
export type V9ExitSettlement = RedemptionSettlementModel;
export type V9ExitHorizon = "immediate" | "near-term" | "queued";
export type V9ExitCapacityScoringHorizon = "immediate" | "daily" | "queued" | "eventual" | "unknown";
export type V9ExitExecution = RedemptionExecutionModel;
export type V9ExitOutputQuality = RedemptionOutputAssetType;
export type V9ExitHolderEligibility =
  | "any-holder"
  | "verified-customer"
  | "verified-customer-neutral"
  | "whitelisted-primary"
  | "pre-incident-holder"
  | "issuer-discretionary"
  | "unknown";

export interface V9ExitStressRequest {
  requestedNotionalUsd: number;
  maxCostBps: number;
  comparisonWindowSec: number;
  rawSupplyRequestUsd: number;
}

export interface V9ExitCapacityPoint {
  requestedNotionalUsd: number;
  maxCostBps: number;
  executableUsd: number;
  completionRatio: number;
  executionCostBps: number;
}

export interface V9ExitEvaluationRoute {
  routeSuspension?: RedemptionRouteSuspension;
  status?: V9FactStatusV2;
  factorStatuses?: V9ExitRouteFactV2["factorStatuses"];
  gaps?: readonly V9FactGapV3[];
  capacityEvidenceTier?: ExitRouteCapacityEvidenceTier;
  routeKey: string;
  lane: "dex" | "redemption";
  routeFamily: "dex-amm" | "dex-orderbook" | "issuer-redemption" | "protocol-redemption" | "eventual-redemption";
  applicability: "required" | "not-applicable" | "unresolved";
  settlementBoundUnproven: boolean;
  observationState: "known" | "missing" | "stale" | "unsupported" | "bounded-unknown";
  scoreEligible: boolean;
  coverageClass: "exact-complete" | "exact-lower-bound" | "modelled-terms-lower-bound" | "diagnostic";
  evidenceKind: string;
  /** Reviewed fee disclosure without a same-notional execution cost bound. */
  feeEvidence?: "undisclosed-reviewed" | "disclosed-unquantified" | null;
  observationConfidence: "high" | "medium" | "low" | "unknown";
  modelConfidence: "high" | "medium" | "low" | "unknown";
  observationHistory?: ExitRouteObservationHistory | null;
  access: V9ExitAccess;
  holderEligibility: V9ExitHolderEligibility;
  capacityScoringHorizon: V9ExitCapacityScoringHorizon;
  settlement: V9ExitSettlement;
  settlementDelaySec: number;
  queueDepthUsd: number | null;
  dailyLimitUsd: number | null;
  minRedeemUsd: number | null;
  execution: V9ExitExecution;
  outputQuality: V9ExitOutputQuality;
  outputResolved: boolean;
  outputValueRetention: number;
  unboundedDeliveryCap?: number;
  physicalToUsd?: PhysicalToUsdTrace;
  executionModelId?: string;
  executionCertificate?: ExitExecutionCertificate;
  capacityCurve: readonly V9ExitCapacityPoint[];
  routeScoreCap: "queue-redeem" | "offchain-issuer" | null;
  failureDomains: readonly string[];
  physicalResourceKeys: readonly string[];
}

export interface V9ExitRouteTrace {
  routeSuspension?: RedemptionRouteSuspension;
  cause: V9EvidenceCause | null;
  causeGapIds: readonly string[];
  scoringDisposition: V9CauseContribution["scoringDisposition"];
  effectiveScoringWeight: number;
  confidenceDimensions: V9ConfidenceDimensions | null;
  capacityEvidenceTier: ExitRouteCapacityEvidenceTier;
  eligibilityMultiplier: number;
  rawSameNotionalCostBps: number | null;
  supportedComponentCeiling: number | null;
  factorContributions?: Readonly<Record<string, V9CauseContribution>>;
  routeKey: string;
  routeFamily: V9ExitEvaluationRoute["routeFamily"];
  feeEvidence?: V9ExitEvaluationRoute["feeEvidence"];
  observationConfidence: V9ExitEvaluationRoute["observationConfidence"];
  modelConfidence: V9ExitEvaluationRoute["modelConfidence"];
  observationHistory: ExitRouteObservationHistory | null;
  physicalToUsd?: PhysicalToUsdTrace;
  executionCertificate?: ExitExecutionCertificate;
  horizon: V9ExitHorizon;
  capacityScoringHorizon: V9ExitCapacityScoringHorizon;
  settlementDelaySec: number;
  queueDepthUsd: number | null;
  dailyLimitUsd: number | null;
  minRedeemUsd: number | null;
  score: number | null;
  included: boolean;
  exclusionReason: V9ReasonCode | null;
  capacityPoint: V9ExitCapacityPoint | null;
  components: {
    access: number | null;
    settlement: number | null;
    executionCertainty: number | null;
    capacity: number | null;
    outputAssetQuality: number | null;
    cost: number | null;
  } | null;
  confidenceFactor: number | null;
  capsApplied: readonly string[];
}

export interface V9ExitHorizonTrace {
  primaryRouteKey: string | null;
  score: number | null;
}

export interface V9ExitEvaluationResult {
  score: number | null;
  aggregationDisposition: "included" | "excluded-a-b";
  causeGapIds: readonly string[];
  limitedEvidenceCauses: readonly ("C" | "U" | "D")[];
  supportedComponentKeys: readonly string[];
  stressRequest: V9ExitStressRequest | null;
  primaryRouteKey: string | null;
  diversificationRouteKey: string | null;
  diversificationBonus: number;
  horizons: Readonly<Record<V9ExitHorizon, V9ExitHorizonTrace>>;
  reasons: readonly V9ReasonCode[];
  routes: readonly V9ExitRouteTrace[];
}

const EMPTY_HORIZONS: Readonly<Record<V9ExitHorizon, V9ExitHorizonTrace>> = {
  immediate: { primaryRouteKey: null, score: null },
  "near-term": { primaryRouteKey: null, score: null },
  queued: { primaryRouteKey: null, score: null },
};

/**
 * The pillar's view of the shared exit request: the same clamped supply share
 * the redemption domain score uses as its denominator, snapped up to the policy
 * notional grid so capacity curves stay comparable across assets.
 *
 * The request policy is read from the validated envelope, not from the shared
 * constant module: the policy JSON is the versioned artifact the deterministic
 * replay pins, and the constant module is CI-validated against it.
 */
export function selectV9ExitStressRequest(
  circulatingUsd: number | null,
  envelope: V9ValidatedPolicyEnvelope,
): V9ExitStressRequest | null {
  assertV9ValidatedPolicyEnvelope(envelope);
  const request = resolveExitScoringRequest("stress-grid", circulatingUsd, envelope.policy.semantic.exit.stressRequest);
  if (request === null) return null;
  return {
    requestedNotionalUsd: request.requestedNotionalUsd,
    maxCostBps: request.maxCostBps,
    comparisonWindowSec: request.settlementHorizonSec,
    rawSupplyRequestUsd: request.rawSupplyRequestUsd,
  };
}

function curveIssue(points: readonly V9ExitCapacityPoint[]): string | null {
  const seen = new Set<string>();
  const byCost = new Map<number, V9ExitCapacityPoint[]>();
  for (const point of points) {
    if (
      !Number.isFinite(point.requestedNotionalUsd) ||
      point.requestedNotionalUsd <= 0 ||
      !Number.isFinite(point.maxCostBps) ||
      point.maxCostBps < 0 ||
      !Number.isFinite(point.executableUsd) ||
      point.executableUsd < 0 ||
      point.executableUsd > point.requestedNotionalUsd + 0.01 ||
      Math.abs(point.completionRatio - point.executableUsd / point.requestedNotionalUsd) > 0.00001 ||
      !Number.isFinite(point.executionCostBps) ||
      point.executionCostBps < 0 ||
      (point.executableUsd > 0 && point.executionCostBps > point.maxCostBps)
    ) {
      return "invalid-capacity-point";
    }
    const key = `${point.maxCostBps}:${point.requestedNotionalUsd}`;
    if (seen.has(key)) return "duplicate-capacity-point";
    seen.add(key);
    byCost.set(point.maxCostBps, [...(byCost.get(point.maxCostBps) ?? []), point]);
  }
  for (const costPoints of byCost.values()) {
    const ordered = [...costPoints].sort((left, right) => left.requestedNotionalUsd - right.requestedNotionalUsd);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index]!.executableUsd + 0.01 < ordered[index - 1]!.executableUsd) {
        return "non-monotonic-capacity";
      }
    }
  }
  return null;
}

export function resolveV9ExitCapacityAtRequest(
  points: readonly V9ExitCapacityPoint[],
  request: V9ExitStressRequest,
): V9ExitCapacityPoint | null {
  // Legacy curves retain interpolation; certified models use exact request points before reaching this boundary.
  if (points.length === 0 || curveIssue(points)) return null;
  const eligibleCosts = uniqueSorted(
    points.filter((point) => point.maxCostBps <= request.maxCostBps).map((point) => String(point.maxCostBps)),
  ).map(Number);
  let best: V9ExitCapacityPoint | null = null;
  for (const maxCostBps of eligibleCosts) {
    const costPoints = points
      .filter((point) => point.maxCostBps === maxCostBps)
      .sort((left, right) => left.requestedNotionalUsd - right.requestedNotionalUsd);
    const exact = costPoints.find((point) => point.requestedNotionalUsd === request.requestedNotionalUsd);
    const lower = [...costPoints].reverse().find((point) => point.requestedNotionalUsd < request.requestedNotionalUsd);
    const first = costPoints[0];
    const executableUsd = Math.min(
      request.requestedNotionalUsd,
      exact?.executableUsd ?? lower?.executableUsd ?? first?.executableUsd ?? 0,
    );
    const candidate = {
      requestedNotionalUsd: request.requestedNotionalUsd,
      maxCostBps,
      executableUsd,
      completionRatio: executableUsd / request.requestedNotionalUsd,
      executionCostBps: exact?.executionCostBps ?? lower?.executionCostBps ?? first?.executionCostBps ?? maxCostBps,
    };
    if (
      best === null ||
      candidate.executableUsd > best.executableUsd ||
      (candidate.executableUsd === best.executableUsd && candidate.maxCostBps < best.maxCostBps)
    ) {
      best = candidate;
    }
  }
  return best;
}

function settlementDelayMultiplier(
  delaySec: number,
  bands: readonly { maxSec: number | null; multiplier: number }[],
): number {
  // An unmatched band means an unusable delay; the pillar zeroes the capacity
  // component rather than leaving it unpenalized.
  return resolveExitDelayBandMultiplier(delaySec, bands) ?? 0;
}

function descendingThresholdMultiplier(
  value: number,
  bands: readonly { threshold: number; multiplier: number }[],
): number {
  return resolveExitThresholdBandMultiplier(value, bands) ?? 1;
}

function routeCapacityHorizon(
  route: V9ExitEvaluationRoute,
  request: V9ExitStressRequest,
): V9ExitHorizon {
  if (
    route.settlement === "queued" ||
    route.settlementDelaySec > 7 * 86_400 ||
    route.capacityScoringHorizon === "queued" ||
    route.capacityScoringHorizon === "eventual"
  ) {
    return "queued";
  }
  if (route.capacityScoringHorizon === "daily") return "near-term";
  return route.settlementDelaySec <= request.comparisonWindowSec ? "immediate" : "near-term";
}

function queueServiceCapacityUsd(
  route: V9ExitEvaluationRoute,
  capacityPoint: V9ExitCapacityPoint,
): number {
  if (route.dailyLimitUsd !== null && route.dailyLimitUsd > 0) return route.dailyLimitUsd;
  return Math.max(
    capacityPoint.executableUsd,
    ...route.capacityCurve.map((point) => point.executableUsd),
  );
}

/**
 * Redemption families that may be eligible for discounted credit when the
 * route is not already score-eligible through the ordinary same-notional path.
 * Route family does not determine atomicity: protocol redemptions in particular
 * may be atomic and score-eligible, in which case they bypass this relaxation.
 */
const CREDITABLE_REDEMPTION_FAMILIES: readonly V9ExitEvaluationRoute["routeFamily"][] = [
  "issuer-redemption",
  "protocol-redemption",
  "eventual-redemption",
];

/**
 * The field subset the creditable-non-atomic-redemption rule reads.
 *
 * Two surfaces ask "does this route count?": the Exit pillar, over the
 * projected `V9ExitEvaluationRoute`, and the access-posture `primaryExit`
 * derivation, over the raw `V9ExitRouteFactV2`. They answered differently —
 * the posture counted only `scoreEligible` routes — so the same asset
 * published a scored issuer-redemption route alongside "Primary exit: None".
 * Both now adapt into this one shape so the families and the eligibility
 * conditions are named exactly once.
 */
export interface V9CreditableNonAtomicRedemptionInput {
  lane: "dex" | "redemption";
  routeFamily: V9ExitEvaluationRoute["routeFamily"];
  scoreEligible: boolean;
  observationState: V9ExitEvaluationRoute["observationState"];
  outputResolved: boolean;
  coverageClass: V9ExitEvaluationRoute["coverageClass"];
  evidenceKind: string;
  failureDomainCount: number;
}

/**
 * A documented, reliable, non-atomic redemption that earns discounted exit
 * credit rather than the atomic-only near-zero it used to score.
 *
 * The exit pillar historically scored anything but an atomic same-notional
 * DEX/redemption at near-zero, capping every well-backed T+1 redeemer and
 * regulated RWA fund at C/D/F regardless of how redeemable it actually is. The
 * ruled fix credits a redemption above zero when it is reviewed and reliable,
 * scaled down by settlement speed through the existing settlement component and
 * settlement-delay multiplier; the atomic same-notional path keeps its top tier.
 *
 * The reliability gate is load-bearing. Credit is confined to the reviewed
 * issuer-, protocol-, and eventual-redemption families and admitted only after
 * hard-gating on a known observation, a resolved output, non-diagnostic
 * coverage, at least one enumerated failure domain, and a documented,
 * live-reserve, or on-chain redemption evidence kind. This gate decides only
 * *eligibility* for discounted positive credit. Its capacity is a lower bound,
 * not a measurement of exhaustion: zero or immaterial discounted capacity
 * leaves missing same-notional evidence rather than measured adversity. A
 * route whose settlement completion bound is unproven likewise stays a
 * bounded evidence gap, excluded from scoring and retained diagnostically.
 */
/**
 * A route output is resolved when it is both observed and valued. Two surfaces
 * read this — the exit pillar's route projection and the access-posture
 * credited-route test — and they must never drift, so it lives here once. A
 * duplicated eligibility rule is exactly what let the posture publish
 * "Primary exit: None" against a scored redemption route before 9.25.
 */
export function isV9ExitRouteOutputResolved(output: {
  status: { observationState: V9FactStatusV2["observationState"] };
  valuation: unknown | null;
  sameNotionalEligible?: false;
}): boolean {
  return output.status.observationState === "known" && output.valuation !== null && output.sameNotionalEligible !== false;
}

export function isV9CreditableNonAtomicRedemption(
  route: V9CreditableNonAtomicRedemptionInput,
  envelope: V9ValidatedPolicyEnvelope,
): boolean {
  if (route.lane !== "redemption") return false;
  // This helper owns only the discounted-credit relaxation. Atomic and other
  // explicitly score-eligible protocol routes remain on the ordinary path.
  if (route.scoreEligible) return false;
  if (!CREDITABLE_REDEMPTION_FAMILIES.includes(route.routeFamily)) return false;
  if (route.observationState !== "known") return false;
  if (route.outputResolved !== true) return false;
  if (route.coverageClass === "diagnostic") return false;
  if (route.failureDomainCount === 0) return false;
  return envelope.policy.semantic.exit.scoreableEvidenceKinds.redemption.includes(route.evidenceKind);
}

function isCreditableNonAtomicRedemption(
  route: V9ExitEvaluationRoute,
  envelope: V9ValidatedPolicyEnvelope,
): boolean {
  return isV9CreditableNonAtomicRedemption(
    {
      lane: route.lane,
      routeFamily: route.routeFamily,
      scoreEligible: route.scoreEligible,
      observationState: route.observationState,
      outputResolved: route.outputResolved,
      coverageClass: route.coverageClass,
      evidenceKind: route.evidenceKind,
      failureDomainCount: route.failureDomains.length,
    },
    envelope,
  );
}

function routeExclusionReason(route: V9ExitEvaluationRoute, envelope: V9ValidatedPolicyEnvelope): V9ReasonCode | null {
  // Exact-channel cessation is neither a measured zero nor evidence about any other rail.
  if (route.routeSuspension) return null;
  if (route.applicability === "not-applicable") return null;
  // Missing/stale capacity backed by A/B remains diagnostic. Relief is not
  // admission, even when adjacent output or settlement metadata is incomplete.
  if (route.observationState !== "known" && routeCause(route).excluded) return "missing-runtime-route-evidence";
  if (route.applicability === "unresolved") return "missing-same-notional-route";
  if (route.executionModelId && (!route.executionCertificate || !route.scoreEligible || route.observationState !== "known")) {
    return "unsupported-same-notional-route";
  }
  if (route.physicalToUsd?.rejectionReason != null) return "missing-same-notional-route";
  if (route.settlementBoundUnproven) return "unproven-settlement-bound";
  if (route.outputResolved === false) return "unresolved-exit-output";
  if (route.observationState === "missing") {
    return "missing-runtime-route-evidence";
  }
  if (route.observationState !== "known" && route.observationState !== "stale") {
    return "unsupported-same-notional-route";
  }
  // A documented redemption mechanism can remain useful diagnostic evidence
  // even when its reviewed scoring terms are incomplete. The V9 adapter marks
  // that bounded-gap disposition diagnostic while preserving its modeled
  // capacity curve. Classify the absent scoreable terms as Pharos-side missing
  // same-notional evidence (globally bounded; `integration-missing` unless an
  // authored producer gap carries `producer-failed`), not as an
  // unsupported method or an adverse issuer fact.
  if (
    route.lane === "redemption" &&
    route.coverageClass === "diagnostic" &&
    route.evidenceKind === "documented-terms"
  ) {
    return "missing-same-notional-route";
  }
  const creditableNonAtomic = isCreditableNonAtomicRedemption(route, envelope);
  if ((!route.scoreEligible || route.coverageClass === "diagnostic") && !creditableNonAtomic) {
    return "unsupported-same-notional-route";
  }
  const scoreable =
    route.lane === "dex"
      ? envelope.policy.semantic.exit.scoreableEvidenceKinds.dex
      : envelope.policy.semantic.exit.scoreableEvidenceKinds.redemption;
  if (!scoreable.includes(route.evidenceKind)) return "unsupported-same-notional-route";
  if (route.failureDomains.length === 0) return "unsupported-same-notional-route";
  return null;
}

function resolveIncludedRouteCapacity(
  route: V9ExitEvaluationRoute,
  request: V9ExitStressRequest,
  envelope: V9ValidatedPolicyEnvelope,
):
  | { state: "included"; capacityPoint: V9ExitCapacityPoint; valuedExecutableUsd: number }
  | { state: "excluded"; exclusionReason: V9ReasonCode | null }
  | { state: "incomparable" }
  | { state: "unsupported" } {
  if (route.routeSuspension) return { state: "excluded", exclusionReason: null };
  const exclusionReason = routeExclusionReason(route, envelope);
  if (exclusionReason !== null || route.applicability === "not-applicable") {
    return { state: "excluded", exclusionReason };
  }
  const proof = route.executionCertificate ? resolveExitExecutionRequestPoint(route.executionCertificate, request) : null;
  const capacityPoint = route.executionModelId
    ? proof && proof.certification !== "diagnostic"
      ? route.capacityCurve.find((point) => point.requestedNotionalUsd === request.requestedNotionalUsd &&
          point.maxCostBps === request.maxCostBps && point.executableUsd === proof.executableUsd &&
          point.executionCostBps === proof.executionCostBps) ?? null
      : null
    : resolveV9ExitCapacityAtRequest(route.capacityCurve, route.physicalToUsd
      ? { ...request, maxCostBps: envelope.policy.semantic.exit.physicalToUsd.maxCostBps }
      : request);
  if (capacityPoint === null) return { state: "incomparable" };
  if (
    !Number.isFinite(route.outputValueRetention) ||
    route.outputValueRetention < 0 ||
    route.outputValueRetention > 1 ||
    !Number.isFinite(route.settlementDelaySec) ||
    route.settlementDelaySec < 0
  ) {
    return { state: "unsupported" };
  }
  return {
    state: "included",
    capacityPoint,
    valuedExecutableUsd:
      capacityPoint.executableUsd *
      route.outputValueRetention *
      staleObservationFactor(route, envelope),
  };
}

/**
 * Credit multiplier for a retained-but-expired observation. `known` routes are
 * unaffected (factor 1), so this is a no-op for every surface whose producer
 * window is current.
 */
function staleObservationFactor(
  route: V9ExitEvaluationRoute,
  envelope: V9ValidatedPolicyEnvelope,
): number {
  return route.observationState === "stale" && !routeCause(route).excluded
    ? envelope.policy.semantic.exit.staleObservationConfidenceFactor
    : 1;
}

export interface V9DistinctExitCapacity {
  includedRouteKeys: readonly string[];
  valuedExecutableUsd: number;
}

/** Resolve distinct physical-resource capacity at an explicit stress request. */
export function resolveV9DistinctExitCapacity(
  routes: readonly V9ExitEvaluationRoute[],
  request: V9ExitStressRequest,
  envelope: V9ValidatedPolicyEnvelope,
): V9DistinctExitCapacity {
  assertV9ValidatedPolicyEnvelope(envelope);
  const included = routes.flatMap((route) => {
    const resolved = resolveIncludedRouteCapacity(route, request, envelope);
    return resolved.state !== "included"
      ? []
      : [
          {
            routeKey: route.routeKey,
            physicalResourceKeys: route.physicalResourceKeys,
            valuedExecutableUsd: resolved.valuedExecutableUsd,
          },
        ];
  });
  const groups: { physicalResourceKeys: Set<string>; valuedExecutableUsd: number }[] = [];
  for (const route of [...included].sort((left, right) => compareText(left.routeKey, right.routeKey))) {
    const overlapping = groups.filter((group) =>
      route.physicalResourceKeys.some((key) => group.physicalResourceKeys.has(key)),
    );
    if (overlapping.length === 0) {
      groups.push({
        physicalResourceKeys: new Set(route.physicalResourceKeys),
        valuedExecutableUsd: route.valuedExecutableUsd,
      });
      continue;
    }
    const merged = {
      physicalResourceKeys: new Set([
        ...route.physicalResourceKeys,
        ...overlapping.flatMap((group) => [...group.physicalResourceKeys]),
      ]),
      valuedExecutableUsd: Math.max(
        route.valuedExecutableUsd,
        ...overlapping.map((group) => group.valuedExecutableUsd),
      ),
    };
    for (const group of overlapping) groups.splice(groups.indexOf(group), 1);
    groups.push(merged);
  }
  return {
    includedRouteKeys: included.map((route) => route.routeKey).sort(),
    valuedExecutableUsd: groups.reduce((sum, group) => sum + group.valuedExecutableUsd, 0),
  };
}

/** Exhaustive measurements retain adverse force when stale; aging is not clearance. */
function isExhaustionMeasurement(route: V9ExitEvaluationRoute): boolean {
  return (route.observationState === "known" || route.observationState === "stale") &&
    route.scoreEligible &&
    route.outputResolved &&
    route.coverageClass === "exact-complete" &&
    route.evidenceKind !== "documented-terms";
}

function hasUnquantifiedFee(route: V9ExitEvaluationRoute): boolean {
  return route.feeEvidence === "undisclosed-reviewed" ||
    route.feeEvidence === "disclosed-unquantified";
}

function routeCause(route: V9ExitEvaluationRoute, factorKey?: keyof NonNullable<V9ExitRouteFactV2["factorStatuses"]>) {
  const status = factorKey ? route.factorStatuses?.[factorKey] : route.status;
  const implicitUnknown = factorKey === "holderEligibility" && route.holderEligibility === "unknown" ||
    factorKey === "observationConfidence" && route.observationConfidence === "unknown" ||
    factorKey === "executionConfidence" && route.modelConfidence === "unknown" ||
    factorKey === "capacityEvidenceTier" && (route.capacityEvidenceTier === undefined || route.capacityEvidenceTier === "unknown") ||
    factorKey === "cost" && hasUnquantifiedFee(route);
  return status === undefined && implicitUnknown
    ? { cause: "U" as const, causes: ["U" as const], causeGapIds: [] as string[], excluded: false }
    : resolveV9StatusCauses([status], route.gaps);
}

function feePreventsBonus(route: V9ExitEvaluationRoute): boolean {
  return hasUnquantifiedFee(route) && !routeCause(route, "cost").excluded;
}

function evaluateRoute(
  route: V9ExitEvaluationRoute,
  request: V9ExitStressRequest,
  envelope: V9ValidatedPolicyEnvelope,
  preExitDangerHeld: boolean,
): V9ExitRouteTrace {
  const horizon = routeCapacityHorizon(route, request);
  const attribution = {
    routeFamily: route.routeFamily,
    cause: routeCause(route).cause,
    causeGapIds: routeCause(route).causeGapIds,
    scoringDisposition: v9ScoringDisposition(routeCause(route).cause),
    effectiveScoringWeight: routeCause(route).excluded ? 0 : 1,
    confidenceDimensions: null,
    capacityEvidenceTier: route.capacityEvidenceTier ?? "unknown",
    eligibilityMultiplier: 1,
    rawSameNotionalCostBps: null,
    supportedComponentCeiling: null,
    ...(route.feeEvidence ? { feeEvidence: route.feeEvidence } : {}),
    observationConfidence: route.observationConfidence,
    modelConfidence: route.modelConfidence,
    observationHistory: route.observationHistory ?? null,
    ...(route.routeSuspension ? { routeSuspension: route.routeSuspension } : {}),
    ...(route.physicalToUsd ? { physicalToUsd: route.physicalToUsd } : {}),
    ...(route.executionCertificate ? { executionCertificate: route.executionCertificate } : {}),
    horizon,
    capacityScoringHorizon: route.capacityScoringHorizon,
    settlementDelaySec: route.settlementDelaySec,
    queueDepthUsd: route.queueDepthUsd,
    dailyLimitUsd: route.dailyLimitUsd,
    minRedeemUsd: route.minRedeemUsd,
  } as const;
  // Danger-held exclusion (owner ruling 2026-07-23): the SIM-EXIT-L2
  // undisclosed-fee lever emits modeled capacity for an opaque-fee route, but an
  // asset already held down by a non-exit adverse fact does not get to buy exit
  // credit back with it. The route reverts to the pre-lever unsupported
  // same-notional exclusion — byte-identical to how a zero-capacity undisclosed
  // route resolved before the lever — so the pre-exit danger that gates the
  // credit never feeds back through the exit pillar it is measured on. Every
  // other route, and every route on a non-danger-held asset, is unaffected.
  if (preExitDangerHeld && feePreventsBonus(route)) {
    return {
      routeKey: route.routeKey,
      ...attribution,
      score: null,
      included: false,
      exclusionReason: "unsupported-same-notional-route",
      capacityPoint: null,
      components: null,
      confidenceFactor: null,
      capsApplied: [],
    };
  }
  const resolvedCapacity = resolveIncludedRouteCapacity(route, request, envelope);
  if (resolvedCapacity.state === "excluded") {
    return {
      routeKey: route.routeKey,
      ...attribution,
      score: null,
      included: false,
      exclusionReason: resolvedCapacity.exclusionReason,
      capacityPoint: null,
      components: null,
      confidenceFactor: null,
      capsApplied: [],
    };
  }
  if (resolvedCapacity.state !== "included") {
    return {
      routeKey: route.routeKey,
      ...attribution,
      score: null,
      included: false,
      exclusionReason:
        resolvedCapacity.state === "incomparable" ? "incomparable-route-requests" : "unsupported-same-notional-route",
      capacityPoint: null,
      components: null,
      confidenceFactor: null,
      capsApplied: [],
    };
  }
  const { capacityPoint, valuedExecutableUsd } = resolvedCapacity;
  const policy = envelope.policy.semantic.exit;
  const completionRatio = valuedExecutableUsd / request.requestedNotionalUsd;
  // A lower bound proves executable capacity, never its absence above that
  // bound. Discounted or modeled terms are credit evidence, not measurements
  // of exhaustion, even when the inventory was reviewed complete.
  if (
    !isExhaustionMeasurement(route) &&
    !hasMaterialExitCapacity(
      {
        executableCapacityUsd: capacityPoint.executableUsd,
        requestedNotionalUsd: request.requestedNotionalUsd,
      },
      policy,
    )
  ) {
    return {
      routeKey: route.routeKey,
      ...attribution,
      score: null,
      included: false,
      exclusionReason: "missing-same-notional-route",
      capacityPoint: null,
      components: null,
      confidenceFactor: null,
      capsApplied: [],
    };
  }
  // Once a route has passed the evidence and comparability gates, measured
  // zero or immaterial capacity is an adverse observation, not unsupported
  // methodology. Keep it included so the trace retains its capacity point,
  // components, confidence, and the explicit zero/immaterial capacity cap.
  const coverageScore = interpolateExitBreakpointScore(completionRatio, policy.coverageRatioBreakpoints);
  const absoluteScore = interpolateExitBreakpointScore(valuedExecutableUsd, policy.absoluteCapacityBreakpoints);
  const delayMultiplier = settlementDelayMultiplier(route.settlementDelaySec, policy.settlementDelayBands);
  let capacity = blendExitCapacityComponent(coverageScore, absoluteScore) * delayMultiplier;
  const constraintMultipliers: string[] = [];
  if (route.queueDepthUsd !== null && route.queueDepthUsd > 0) {
    const serviceCapacityUsd = queueServiceCapacityUsd(route, capacityPoint);
    if (serviceCapacityUsd > 0) {
      const backlogRatio = route.queueDepthUsd / serviceCapacityUsd;
      const multiplier = descendingThresholdMultiplier(backlogRatio, policy.queueBacklogBands);
      capacity *= multiplier;
      if (multiplier < 1) constraintMultipliers.push(`queue-backlog:${multiplier}`);
    }
  }
  if (route.minRedeemUsd !== null) {
    const multiplier = descendingThresholdMultiplier(route.minRedeemUsd, policy.minimumRedeemBands);
    capacity *= multiplier;
    if (multiplier < 1) constraintMultipliers.push(`minimum-redeem:${multiplier}`);
  }
  const components = {
    access: policy.accessScores[route.access],
    settlement: policy.settlementScores[route.settlement],
    executionCertainty: policy.executionScores[route.execution],
    capacity,
    outputAssetQuality: Math.min(
      route.physicalToUsd ? policy.outputAssetScores["physical-commodity-delivery"] : policy.outputAssetScores[route.outputQuality],
      route.unboundedDeliveryCap === undefined ? 100 : policy.unboundedDeliveryCap,
    ) * route.outputValueRetention,
    // A cost sitting exactly on the request bound is an upper bound, not a
    // measurement: producers report execution inside maxCostBps without the
    // realized marginal cost. Bounded-unknown cost scores at the policy
    // midpoint instead of pricing the worst case as if it were observed.
    cost:
      hasUnquantifiedFee(route) || (!route.physicalToUsd && capacityPoint.executionCostBps >= request.maxCostBps)
        ? policy.boundedCostScore
        : clampScore(100 * (1 - capacityPoint.executionCostBps / Math.max(1, request.maxCostBps))),
  };
  const factorKeys = {
    access: "access", settlement: "settlement", executionCertainty: "executionConfidence",
    capacity: "capacity", outputAssetQuality: "output", cost: "cost",
  } as const;
  const scoredComponents = { ...components } as NonNullable<V9ExitRouteTrace["components"]>;
  const factorContributions: Record<string, V9CauseContribution> = {};
  let weightedScore = 0;
  let totalWeight = 0;
  for (const key of Object.keys(factorKeys) as (keyof typeof factorKeys)[]) {
    const causal = routeCause(route, factorKeys[key]);
    // Admission already established capacity/output. A gap in an adjacent
    // quality factor is omitted without asserting free execution or rights.
    const value = causal.excluded ? null : components[key];
    scoredComponents[key] = value;
    const weight = value === null ? 0 : policy.componentWeights[key];
    weightedScore += (value ?? 0) * weight;
    totalWeight += weight;
    factorContributions[key] = {
      score: value, cause: causal.cause, causeGapIds: causal.causeGapIds,
      scoringDisposition: v9ScoringDisposition(causal.cause), effectiveScoringWeight: weight,
    };
  }
  if (totalWeight > 0) {
    for (const contribution of Object.values(factorContributions)) contribution.effectiveScoringWeight /= totalWeight;
  }
  let score = totalWeight > 0 ? weightedScore / totalWeight : 0;
  const capsApplied: string[] = [...constraintMultipliers];
  // Capacity carries only a minority of the component ladder, so access,
  // settlement, execution certainty, output quality and a bounded-unknown cost
  // would otherwise carry a route that moves no meaningful value at the stress
  // request. A route that clears nothing — or so little that filling it is not
  // an exit at any portfolio size — has no exit value, and the cost of a trade
  // that cannot meaningfully happen is not a mitigating fact: it floors at
  // zero. The cut is a fraction of what was actually asked for, so it scales
  // with the asset; clearing exactly nothing is its degenerate case.
  if (valuedExecutableUsd === 0) {
    score = 0;
    capsApplied.push("zero-executable-capacity");
  } else if (!hasMaterialExitCapacity(
    {
      executableCapacityUsd: capacityPoint.executableUsd,
      requestedNotionalUsd: request.requestedNotionalUsd,
    },
    policy,
  )) {
    score = 0;
    capsApplied.push("immaterial-executable-capacity");
  } else {
    const firstPositiveCoverage = firstPositiveExitBreakpointValue(
      policy.coverageRatioBreakpoints,
    );
    if (
      firstPositiveCoverage > 0 &&
      completionRatio < firstPositiveCoverage &&
      score > 50
    ) {
      score = 50;
      capsApplied.push("insufficient-completion:50");
    }
  }
  const confidenceDimension = (key: "observationConfidence" | "executionConfidence" | "capacityEvidenceTier", value: number) => {
    const causal = routeCause(route, key);
    return { factor: causal.excluded ? 1 : value, cause: causal.cause, causeGapIds: causal.causeGapIds };
  };
  const confidenceDimensions: V9ConfidenceDimensions = {
    observation: confidenceDimension("observationConfidence", Math.min(
      policy.observationConfidenceFactors[route.observationConfidence], staleObservationFactor(route, envelope))),
    model: confidenceDimension("executionConfidence", policy.modeledConfidenceFactors[route.modelConfidence === "unknown" ? "low" : route.modelConfidence]),
    capacityMethod: confidenceDimension("capacityEvidenceTier", policy.capacityEvidenceTierFactors[route.capacityEvidenceTier ?? "unknown"]),
  };
  const confidenceFactor = Math.min(
    confidenceDimensions.observation.factor, confidenceDimensions.model.factor, confidenceDimensions.capacityMethod.factor,
  );
  if (route.observationState === "stale") capsApplied.push("observation:stale");
  const eligibilityMultiplier = route.holderEligibility === "unknown" && routeCause(route, "holderEligibility").excluded
    ? 1 : policy.holderEligibilityMultipliers[route.holderEligibility];
  score *= confidenceFactor * eligibilityMultiplier;
  const routeCap =
    route.physicalToUsd ? policy.routeFamilyCaps.offchainIssuer :
    route.routeScoreCap === "queue-redeem" ||
    route.capacityScoringHorizon === "daily" ||
    route.capacityScoringHorizon === "queued" ||
    route.capacityScoringHorizon === "eventual"
      ? policy.routeFamilyCaps.queueRedeem
      : route.routeScoreCap === "offchain-issuer"
        ? policy.routeFamilyCaps.offchainIssuer
        : null;
  if (routeCap !== null && score > routeCap) {
    score = routeCap;
    capsApplied.push(
      route.routeScoreCap === "queue-redeem" || route.routeScoreCap === "offchain-issuer"
        ? `route-family:${route.routeScoreCap}`
        : `capacity-horizon:${route.capacityScoringHorizon}`,
    );
  }
  // A `documented-terms` redemption is a reviewed T&C promise — the weakest
  // scoreable evidence kind — not an on-chain-enforced or reserve-verified exit.
  // It is capped below the credit a live-reserve / on-chain route can reach so a
  // paper promise cannot read as a contract-verifiable exit. The cap stacks as a
  // min on top of the settlement haircut and every reliability gate; a route
  // already scoring below the ceiling (a typical same-day EMI) is untouched, and
  // stronger evidence kinds are never capped here.
  if (route.evidenceKind === "documented-terms" && score > policy.documentedTermsCreditCeiling) {
    score = policy.documentedTermsCreditCeiling;
    capsApplied.push("evidence-kind:documented-terms");
  }
  return {
    routeKey: route.routeKey,
    ...attribution,
    score: clampScore(score),
    included: true,
    exclusionReason: null,
    confidenceDimensions,
    eligibilityMultiplier,
    rawSameNotionalCostBps: routeCause(route, "cost").cause === null && !hasUnquantifiedFee(route) ? capacityPoint.executionCostBps : null,
    supportedComponentCeiling: totalWeight > 0 ? weightedScore / totalWeight : null,
    factorContributions,
    capacityPoint: {
      ...capacityPoint,
      executableUsd: roundTo(valuedExecutableUsd, 2),
      completionRatio: roundTo(completionRatio, 2),
      executionCostBps: capacityPoint.executionCostBps,
    },
    components: {
      ...scoredComponents,
      capacity: scoredComponents.capacity === null ? null : roundTo(scoredComponents.capacity, 2),
      outputAssetQuality: scoredComponents.outputAssetQuality === null ? null : roundTo(scoredComponents.outputAssetQuality, 2),
      cost: scoredComponents.cost === null ? null : roundTo(scoredComponents.cost, 2),
    },
    confidenceFactor,
    capsApplied,
  };
}

function mapHolderAccess(route: V9ExitRouteFactV2): {
  access: V9ExitAccess;
  holderEligibility: V9ExitHolderEligibility;
} {
  switch (route.holderAccess) {
    case "permissionless":
      return { access: "permissionless-onchain", holderEligibility: "any-holder" };
    case "retail-open":
      return { access: "issuer-api", holderEligibility: "any-holder" };
    case "institutional-eligible":
      return { access: "issuer-api", holderEligibility: "verified-customer" };
    case "verified-customer-neutral":
      return { access: "issuer-api", holderEligibility: "verified-customer-neutral" };
    case "allowlisted":
      return { access: "whitelisted-onchain", holderEligibility: "whitelisted-primary" };
    case "issuer-only":
      return { access: "manual", holderEligibility: "issuer-discretionary" };
    case "unknown":
      return { access: "manual", holderEligibility: "unknown" };
  }
}

function mapExecution(route: V9ExitRouteFactV2): V9ExitExecution {
  if (route.output.valuation?.basis === "nav") return "rules-based-nav";
  if (route.output.kind === "basket" && route.executionModel !== "discretionary") return "deterministic-basket";
  if (
    route.executionModel === "atomic" ||
    route.executionModel === "deterministic" ||
    route.executionModel === "market-depth"
  ) {
    return "deterministic-onchain";
  }
  return "opaque";
}

function mapSettlement(route: V9ExitRouteFactV2): V9ExitSettlement {
  switch (route.settlementModel) {
    case "atomic":
      return "atomic";
    case "same-day":
      return "same-day";
    case "bounded-delay":
      return (route.settlementSlaSec ?? Number.POSITIVE_INFINITY) <= 3_600 ? "immediate" : "days";
    case "queued":
    case "eventual":
      return "queued";
    case "unknown":
      return "queued";
  }
}

function mapOutputQuality(route: V9ExitRouteFactV2): V9ExitOutputQuality {
  if (route.output.valuation?.basis === "nav") return "nav";
  if (route.output.kind === "physical-commodity-delivery") return "physical-commodity-delivery";
  if (route.output.kind === "fiat") return "stable-single";
  if (route.output.kind === "tracked-stablecoin") {
    return route.output.assetKeys.length === 1 ? "stable-single" : "stable-basket";
  }
  if (route.output.kind === "basket") return "mixed-collateral";
  return "mixed-collateral";
}

function statusApplicability(route: V9ExitRouteFactV2): V9ExitEvaluationRoute["applicability"] {
  return route.status.applicability.state;
}

/** Maps policy-independent normalized facts into the explicit candidate Exit component vocabulary. */
export function projectV9ExitEvaluationRoute(route: V9ExitRouteFactV2): V9ExitEvaluationRoute {
  const access = mapHolderAccess(route);
  return {
    routeKey: route.routeKey,
    status: route.status,
    factorStatuses: route.factorStatuses,
    capacityEvidenceTier: route.capacityEvidenceTier ?? "unknown",
    lane: route.lane,
    routeFamily: route.routeFamily,
    applicability: statusApplicability(route),
    settlementBoundUnproven: route.settlementBoundUnproven ?? false,
    observationState: route.status.observationState,
    scoreEligible: route.scoreEligible,
    coverageClass: route.coverageClass,
    evidenceKind: route.evidenceKind,
    feeEvidence: route.feeEvidence ?? null,
    observationConfidence: route.observationConfidence,
    modelConfidence: route.modelConfidence,
    observationHistory: route.observationHistory ?? null,
    ...(route.routeSuspension ? { routeSuspension: route.routeSuspension } : {}),
    ...(route.physicalToUsd ? { physicalToUsd: route.physicalToUsd } : {}),
    ...(route.executionModelId ? { executionModelId: route.executionModelId } : {}),
    ...(route.executionCertificate ? { executionCertificate: route.executionCertificate } : {}),
    ...access,
    capacityScoringHorizon: route.capacityScoringHorizon ?? "unknown",
    settlement: mapSettlement(route),
    // A reviewed settlement SLA is the delay the settlement-delay multiplier
    // prices. When the review layer publishes no explicit SLA (the `days` and
    // `queued` models carry a null SLA), fall back to the route's reviewed
    // settlement horizon so a slower non-atomic redemption is discounted by its
    // real settlement speed rather than treated as instantaneous. Atomic and
    // DEX routes carry an explicit `0` SLA (not null), so this fallback never
    // fires for them and their multiplier stays 1.0.
    settlementDelaySec: route.settlementSlaSec ?? route.request?.settlementHorizonSec ?? 0,
    queueDepthUsd: route.queueDepthUsd ?? null,
    dailyLimitUsd: route.dailyLimitUsd ?? null,
    minRedeemUsd: route.minRedeemUsd ?? null,
    execution: mapExecution(route),
    outputQuality: mapOutputQuality(route),
    outputResolved: isV9ExitRouteOutputResolved(route.output),
    outputValueRetention: Math.min(1, route.output.valuation?.valueRetentionRatio ?? 0),
    ...(route.output.unboundedDeliveryCap !== undefined ? { unboundedDeliveryCap: route.output.unboundedDeliveryCap } : {}),
    capacityCurve: route.capacityCurve.every((point) => point.executionCostBps !== null)
      ? route.capacityCurve as readonly V9ExitCapacityPoint[]
      : route.capacityCurve.filter((point): point is V9ExitCapacityPoint => point.executionCostBps !== null),
    routeScoreCap:
      route.settlementModel === "queued" ||
      route.capacityScoringHorizon === "daily" ||
      route.capacityScoringHorizon === "queued" ||
      route.capacityScoringHorizon === "eventual"
        ? "queue-redeem"
        : route.holderAccess === "issuer-only"
          ? "offchain-issuer"
          : null,
    failureDomains: route.failureDomains.map((domain) => `${domain.kind}:${domain.key}`),
    physicalResourceKeys: route.physicalResourceKeys,
  };
}

/**
 * A bridge-materiality-only bound leaves the current circulating USD amount
 * established by the supply producer. Use it only to size Exit; do not promote
 * the supply status or infer a chain/bridge partition for any other consumer.
 */
export function selectV9ExitCirculatingUsd(supply: V9AssetFactsBase["supply"]): number | null {
  const { status } = supply;
  const currentAmountWithUnknownDistribution =
    status.observationState === "bounded-unknown" &&
    status.applicability.state === "required" &&
    status.applicability.policyRuleId === "v9.supply.bridge-materiality";
  return status.observationState === "known" || currentAmountWithUnknownDistribution
    ? supply.circulatingUsd
    : null;
}

export function evaluateV9ExitAssetFacts(
  asset: Pick<V9AssetFactsBase, "supply" | "exitStatus" | "exitRoutes"> & { gaps?: readonly V9FactGapV3[] },
  envelope: V9ValidatedPolicyEnvelope,
  preExitDangerHeld = false,
  executionContext?: { assetId: string; clockSec: number },
): V9ExitEvaluationResult {
  return evaluateV9Exit(
    {
      ...executionContext,
      circulatingUsd: selectV9ExitCirculatingUsd(asset.supply),
      gaps: asset.gaps,
      portfolioFactStatus: asset.exitStatus,
      portfolioStatus:
        asset.exitStatus.observationState === "known" && asset.exitStatus.applicability.state === "required"
          ? "reviewed-complete"
          : "incomplete",
      routes: asset.exitRoutes.map(projectV9ExitEvaluationRoute),
      preExitDangerHeld,
    },
    envelope,
  );
}

function disjoint(left: readonly string[], right: readonly string[]): boolean {
  let l = 0;
  let r = 0;
  while (l < left.length && r < right.length) {
    const order = compareText(left[l]!, right[r]!);
    if (order === 0) return false;
    if (order < 0) l++;
    else r++;
  }
  return true;
}

export function evaluateV9Exit(
  args: {
    circulatingUsd: number | null;
    assetId?: string;
    clockSec?: number;
    portfolioStatus?: "reviewed-complete" | "incomplete";
    portfolioFactStatus?: V9FactStatusV2;
    gaps?: readonly V9FactGapV3[];
    routes: readonly V9ExitEvaluationRoute[];
    /** The asset is held down by a pre-exit adverse fact; undisclosed-fee routes earn no credit. */
    preExitDangerHeld?: boolean;
  },
  envelope: V9ValidatedPolicyEnvelope,
): V9ExitEvaluationResult {
  assertV9ValidatedPolicyEnvelope(envelope);
  const boundedFloor = envelope.policy.semantic.exit.boundedUnknownScore;
  const unprovenSettlementBoundedFloor = boundedFloor;
  const inventoryCause = resolveV9StatusCauses([args.portfolioFactStatus], args.gaps);
  const pillarMetadata = {
    aggregationDisposition: "included" as "included" | "excluded-a-b",
    causeGapIds: inventoryCause.causeGapIds,
    limitedEvidenceCauses: inventoryCause.causes.filter((cause): cause is "C" | "U" | "D" => cause === "C" || cause === "U" || cause === "D"),
    supportedComponentKeys: [] as string[],
  };
  const stressRequest = selectV9ExitStressRequest(args.circulatingUsd, envelope);
  if (stressRequest === null) {
    return {
      ...pillarMetadata,
      aggregationDisposition: inventoryCause.excluded ? "excluded-a-b" : "included",
      score: inventoryCause.excluded ? null : boundedFloor,
      stressRequest: null,
      primaryRouteKey: null,
      diversificationRouteKey: null,
      diversificationBonus: 0,
      horizons: EMPTY_HORIZONS,
      reasons: ["missing-same-notional-route"],
      routes: [],
    };
  }
  const routes = args.routes.map((route) => {
    route = { ...route, gaps: args.gaps ?? route.gaps };
    if (!route.executionModelId) return route;
    const certificate = route.executionCertificate;
    const admission = certificate && args.assetId !== undefined && args.clockSec !== undefined
      ? admitExitExecutionCertificate({
          certificate, envelope, assetId: args.assetId, clockSec: args.clockSec,
          inputGenerationId: exitExecutionInputGenerationId(args.assetId, args.circulatingUsd, certificate.inputReference),
          observationGenerationId: domainDigest("safety-score-v10.exit-execution-source.v1", certificate.source),
          request: stressRequest,
        })
      : null;
    return admission && admission.state !== "unavailable"
      ? { ...route, coverageClass: admission.point.certification }
      : { ...route, scoreEligible: false };
  }).sort((left, right) => compareText(left.routeKey, right.routeKey));
  const traces = routes.map((route) =>
    evaluateRoute(
      route,
      stressRequest,
      envelope,
      args.preExitDangerHeld ?? false,
    ));
  const evaluated = traces
    .flatMap((trace, index) => (trace.score === null ? [] : [{ trace, route: routes[index]!, score: trace.score }]))
    .sort((left, right) => right.score - left.score || compareText(left.route.routeKey, right.route.routeKey));
  const diagnosticReasons = traces.flatMap((trace) => (trace.exclusionReason ? [trace.exclusionReason] : []));
  pillarMetadata.causeGapIds = uniqueSorted([...pillarMetadata.causeGapIds, ...traces.flatMap((trace) => trace.causeGapIds),
    ...routes.flatMap((route) => Object.keys(route.factorStatuses ?? {}).flatMap((key) =>
      routeCause(route, key as keyof NonNullable<V9ExitRouteFactV2["factorStatuses"]>).causeGapIds))]);
  pillarMetadata.supportedComponentKeys = evaluated.map((candidate) => candidate.route.routeKey).sort(compareText);
  pillarMetadata.limitedEvidenceCauses = [];
  const excludedCause = (trace: V9ExitRouteTrace) => {
    const route = routes.find((route) => route.routeKey === trace.routeKey)!;
    return trace.exclusionReason === "unproven-settlement-bound" ? routeCause(route, "settlement")
      : trace.exclusionReason === "unresolved-exit-output" ? routeCause(route, "output")
        : routeCause(route, "capacity").cause !== null ? routeCause(route, "capacity") : routeCause(route);
  };
  const excludedGap = (trace: V9ExitRouteTrace) => excludedCause(trace).excluded;
  const chargedDiagnosticReasons = traces.flatMap((trace) => trace.exclusionReason && !excludedGap(trace) ? [trace.exclusionReason] : []);
  const horizons = Object.fromEntries(
    (["immediate", "near-term", "queued"] as const).map((horizon) => {
      const best = traces
        .filter((trace) => trace.horizon === horizon && trace.score !== null)
        .sort(
          (left, right) =>
            (right.score ?? 0) - (left.score ?? 0) ||
            compareText(left.routeKey, right.routeKey),
        )[0];
      return [
        horizon,
        {
          primaryRouteKey: best?.routeKey ?? null,
          score: best?.score ?? null,
        },
      ];
    }),
  ) as Record<V9ExitHorizon, V9ExitHorizonTrace>;
  if (evaluated.length === 0) {
    const hasBoundedMissingRoute = diagnosticReasons.includes("missing-same-notional-route") ||
      routes.some((route) => route.routeSuspension !== undefined ||
        (route.applicability !== "not-applicable" && !route.settlementBoundUnproven &&
          !isExhaustionMeasurement(route))) ||
      diagnosticReasons.some((reason) => reason !== "unproven-settlement-bound");
    const hasUnprovenSettlementBound = diagnosticReasons.includes("unproven-settlement-bound");
    const provenEmptyInventory = args.portfolioStatus === "reviewed-complete" && routes.length === 0;
    // A reviewed census proving no routes exist is adverse. A non-empty
    // inventory whose routes were excluded or unmeasured is missing evidence,
    // not proof of exhaustion; admitted exhaustive zeros remain included.
    const defaultReason = provenEmptyInventory
      ? "no-viable-exit-path"
      : !hasBoundedMissingRoute && hasUnprovenSettlementBound
        ? "unproven-settlement-bound"
        : "missing-same-notional-route";
    const pureExcludedInventory = !provenEmptyInventory && (routes.length === 0 ? inventoryCause.excluded
      : (inventoryCause.cause === null || inventoryCause.excluded) && traces.every((trace) => excludedGap(trace)));
    pillarMetadata.limitedEvidenceCauses = provenEmptyInventory || pureExcludedInventory ? [] : uniqueSorted([
      ...inventoryCause.causes, ...traces.flatMap((trace) => excludedCause(trace).causes),
      ...(inventoryCause.cause === null && traces.every((trace) => excludedCause(trace).cause === null) ? ["U"] : []),
    ]).filter((cause): cause is "C" | "U" => cause === "C" || cause === "U");
    return {
      ...pillarMetadata,
      aggregationDisposition: pureExcludedInventory ? "excluded-a-b" : "included",
      score: provenEmptyInventory ? 0 : pureExcludedInventory ? null
        : defaultReason === "unproven-settlement-bound" ? unprovenSettlementBoundedFloor : boundedFloor,
      stressRequest,
      primaryRouteKey: null,
      diversificationRouteKey: null,
      diversificationBonus: 0,
      horizons,
      reasons: uniqueSorted([
        defaultReason,
        ...diagnosticReasons,
      ]) as V9ReasonCode[],
      routes: traces,
    };
  }

  type Candidate = typeof evaluated[number] & { domains: string[]; resources: string[]; bonusEligible: boolean };
  const candidates: Candidate[] = evaluated.map((candidate) => ({
    ...candidate, domains: uniqueSorted(candidate.route.failureDomains), resources: uniqueSorted(candidate.route.physicalResourceKeys),
    bonusEligible: !feePreventsBonus(candidate.route),
  }));
  if (candidates.length > envelope.policy.semantic.exit.maximumScoreEligiblePortfolioCandidates) {
    const overflow = args.gaps?.find((gap) => args.portfolioFactStatus?.gapIds.includes(gap.gapId) &&
      gap.causeProof.cause === "A" && gap.causeProof.producerState === "unsupported-reader" &&
      gap.causeProof.rejectionCode === "route-inventory-over-limit" && gap.causeScope?.pillar === "exit" &&
      gap.causeScope.componentKey === "exit-routes" && gap.causeScope.requiredDatum === "route-inventory");
    if (!overflow) throw new Error("route-inventory-over-limit requires the compiler's scoped reader rejection");
    return { ...pillarMetadata, aggregationDisposition: "excluded-a-b", supportedComponentKeys: [], limitedEvidenceCauses: [],
      score: null, stressRequest, primaryRouteKey: null, diversificationRouteKey: null, diversificationBonus: 0,
      horizons: EMPTY_HORIZONS, reasons: ["missing-runtime-route-evidence"],
      routes: traces.map((trace) => ({ ...trace, score: null, included: false, capacityPoint: null, components: null,
        cause: "A", causeGapIds: uniqueSorted([...trace.causeGapIds, overflow.gapId]),
        scoringDisposition: "excluded-pipeline", effectiveScoringWeight: 0, supportedComponentCeiling: null,
        confidenceFactor: null, confidenceDimensions: null, exclusionReason: "unsupported-same-notional-route" })) };
  }
  let primary = candidates[0]!;
  let independent: Candidate | undefined;
  let diversificationBonus = 0;
  let bestScore = primary.score;
  const consider = (first: Candidate, second?: Candidate) => {
    const main = second && (second.score > first.score ||
      (second.score === first.score && compareText(second.route.routeKey, first.route.routeKey) < 0)) ? second : first;
    const backup = second ? main === first ? second : first : undefined;
    const bonus = backup && main.bonusEligible && backup.bonusEligible
      ? Math.min(100 - main.score, 100 * envelope.policy.semantic.exit.independentRouteBenefitLimit) * backup.score / 100 : 0;
    const combined = main.score + bonus;
    if (combined > bestScore || (combined === bestScore && (
      main.score > primary.score || (main.score === primary.score && (
        (backup?.score ?? 0) > (independent?.score ?? 0) || ((backup?.score ?? 0) === (independent?.score ?? 0) && (
          compareText(main.route.routeKey, primary.route.routeKey) < 0 ||
          (main.route.routeKey === primary.route.routeKey && compareText(backup?.route.routeKey ?? "", independent?.route.routeKey ?? "") < 0)))))))) {
      primary = main;
      independent = backup;
      diversificationBonus = bonus;
      bestScore = combined;
    }
  };
  for (let i = 0; i < candidates.length; i++) {
    const left = candidates[i]!;
    consider(left);
    for (let j = i + 1; j < candidates.length; j++) {
      const right = candidates[j]!;
      if (disjoint(left.domains, right.domains) && disjoint(left.resources, right.resources)) consider(left, right);
    }
  }
  const hasOtherIncludedRoute = evaluated.length > 1;
  const boundedGapReason =
    boundedFloor !== null && (chargedDiagnosticReasons.includes("missing-same-notional-route") ||
      (!isExhaustionMeasurement(primary.route) && !routeCause(primary.route, "capacity").excluded) ||
      (primary.score === 0 && routes.some((route) =>
        route.applicability !== "not-applicable" && !isExhaustionMeasurement(route) && !routeCause(route, "capacity").excluded && !routeCause(route).excluded)))
      ? "missing-same-notional-route"
      : unprovenSettlementBoundedFloor !== null && chargedDiagnosticReasons.includes("unproven-settlement-bound")
        ? "unproven-settlement-bound"
        : null;
  const boundedGapFloor =
    boundedGapReason === "missing-same-notional-route"
      ? boundedFloor
      : boundedGapReason === "unproven-settlement-bound"
        ? unprovenSettlementBoundedFloor
        : null;
  const boundedGapFloorApplies =
    boundedGapFloor !== null && primary.score + diversificationBonus < boundedGapFloor;
  const controllingCauses: ("C" | "U")[] = [];
  if (boundedGapFloorApplies) {
    const floorCauses = [...inventoryCause.causes,
      ...traces.filter((trace) => trace.exclusionReason && !excludedGap(trace)).flatMap((trace) => excludedCause(trace).causes),
      ...routeCause(primary.route, "capacity").causes];
    for (const cause of floorCauses) if (cause === "C" || cause === "U") controllingCauses.push(cause);
    if (controllingCauses.length === 0) controllingCauses.push("U");
  } else {
    for (const candidate of independent && diversificationBonus > 0 ? [primary, independent] : [primary]) {
      const trace = candidate.trace;
      if (candidate.score <= 0 || trace.capsApplied.some((cap) =>
        cap.startsWith("route-family:") || cap.startsWith("capacity-horizon:") || cap.startsWith("evidence-kind:"))) continue;
      for (const contribution of Object.values(trace.factorContributions ?? {})) {
        if (contribution.effectiveScoringWeight > 0 && contribution.score !== null && contribution.score < 100 &&
          (contribution.cause === "C" || contribution.cause === "U")) controllingCauses.push(contribution.cause);
      }
      for (const dimension of Object.values(trace.confidenceDimensions ?? {})) {
        if (dimension.factor < 1 && dimension.factor === trace.confidenceFactor &&
          (dimension.cause === "C" || dimension.cause === "U")) controllingCauses.push(dimension.cause);
      }
      const eligibility = routeCause(candidate.route, "holderEligibility");
      if (candidate.route.holderEligibility === "unknown" && trace.eligibilityMultiplier < 1 &&
        (eligibility.cause === "C" || eligibility.cause === "U")) controllingCauses.push(eligibility.cause);
    }
  }
  pillarMetadata.limitedEvidenceCauses = uniqueSorted(controllingCauses);
  // Positive lower-bound capacity is a usable route, not a missing route.
  // Its floor eligibility does not create a missing-evidence ceiling.
  // An excluded alternative stays diagnostic while a positive route carries
  // the claim; non-exhaustive zeros remain evidence gaps at any floor.
  const evidenceGapReason = primary.score === 0 ? boundedGapReason : null;
  return {
    ...pillarMetadata,
    score: boundedGapFloorApplies
      ? boundedGapFloor
      : roundTo(primary.score + diversificationBonus, 2),
    stressRequest,
    primaryRouteKey: boundedGapFloorApplies ? null : primary.route.routeKey,
    diversificationRouteKey: boundedGapFloorApplies ? null : independent?.route.routeKey ?? null,
    diversificationBonus: boundedGapFloorApplies ? 0 : roundTo(diversificationBonus, 2),
    horizons,
    // Missing-evidence reasons follow the route evidence, not the numerical
    // floor comparison: raising an unknown rung must not activate a new cap.
    // Optional exclusions remain visible on their per-route traces.
    reasons: uniqueSorted([
      ...(evidenceGapReason ? [evidenceGapReason] : []),
      ...(!evidenceGapReason && primary.score === 0 ? ["no-viable-exit-path"] : []),
      ...(hasOtherIncludedRoute && !candidates.some((candidate) => candidate !== primary &&
        disjoint(primary.domains, candidate.domains) && disjoint(primary.resources, candidate.resources)) ? ["correlated-exit-routes"] : []),
    ]) as V9ReasonCode[],
    routes: traces,
  };
}
