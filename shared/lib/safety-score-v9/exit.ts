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
import { assertV9ValidatedPolicyEnvelope, unknownQuality } from "./policy";
import { resolveV9StatusCauses, v9ScoringDisposition } from "./control-primitives";
import { compareText, domainDigest, uniqueSorted } from "./primitives";
import { admitExitExecutionCertificate, exitExecutionInputGenerationId, resolveExitExecutionBoundPoint } from "./exit-execution";

export type V9ExitAccess = RedemptionAccessModel;
export type V9ExitSettlement = RedemptionSettlementModel;
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
  /** Supply-relative materiality denominator, before the stress floor. */
  rawSupplyRequestUsd: number;
  supplyObservedAtSec?: number | null;
  sizingUncertaintyReason?: "missing-supply" | "stale-supply" | "unusable-supply" | null;
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
  routeId: V9ExitRouteFactV2["routeId"];
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
  rawSameNotionalCostBps: number | null;
  supportedComponentCeiling: number | null;
  factorContributions?: Readonly<Record<string, V9CauseContribution>>;
  routeKey: string;
  routeId: V9ExitEvaluationRoute["routeId"];
  lane: V9ExitEvaluationRoute["lane"];
  routeFamily: V9ExitEvaluationRoute["routeFamily"];
  feeEvidence?: V9ExitEvaluationRoute["feeEvidence"];
  observationConfidence: V9ExitEvaluationRoute["observationConfidence"];
  modelConfidence: V9ExitEvaluationRoute["modelConfidence"];
  observationHistory: ExitRouteObservationHistory | null;
  physicalToUsd?: PhysicalToUsdTrace;
  executionCertificate?: ExitExecutionCertificate;
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
  reasons: readonly V9ReasonCode[];
  routes: readonly V9ExitRouteTrace[];
}

/**
 * The pillar uses the clamped supply share continuously. The observation grid
 * sizes producer measurements, not the liability the holder needs to exit.
 *
 * The request policy is read from the validated envelope, not from the shared
 * constant module: the policy JSON is the versioned artifact the deterministic
 * replay pins, and the constant module is CI-validated against it.
 */
export function selectV9ExitStressRequest(
  circulatingUsd: number | null,
  envelope: V9ValidatedPolicyEnvelope,
): V9ExitStressRequest {
  assertV9ValidatedPolicyEnvelope(envelope);
  const policy = envelope.policy.semantic.exit.stressRequest;
  const request = resolveExitScoringRequest("stress", circulatingUsd, policy)!;
  return {
    requestedNotionalUsd: request.requestedNotionalUsd,
    maxCostBps: request.maxCostBps,
    comparisonWindowSec: request.settlementHorizonSec,
    rawSupplyRequestUsd: circulatingUsd !== null && Number.isFinite(circulatingUsd) && circulatingUsd > 0
      ? Math.min(policy.capUsd, Math.max(policy.materialityFloorUsd, circulatingUsd * policy.supplyRatio))
      : policy.capUsd,
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
  // A smaller measured point remains an executable lower bound at a larger request.
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
 * not an exhaustion measurement: modeled zero and submaterial lower bounds
 * remain gaps. Missing fee or settlement terms
 * are separately admitted with unknown subfactors and a bounded-recovery ceiling.
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

function hasBoundedTerms(route: V9ExitEvaluationRoute): boolean {
  return route.lane === "redemption" && route.observationState === "known" &&
    !route.executionModelId && (route.settlementBoundUnproven || hasUnquantifiedFee(route) ||
      (["cost", "settlement"] as const).some((key) => {
        const cause = routeCause(route, key).cause;
        return cause === "C" || cause === "U";
      }));
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
  if (route.settlementBoundUnproven && !hasBoundedTerms(route)) return "unproven-settlement-bound";
  if (route.outputResolved === false) return "unresolved-exit-output";
  if (route.observationState === "missing") {
    return "missing-runtime-route-evidence";
  }
  if (route.observationState !== "known" && route.observationState !== "stale") {
    return "unsupported-same-notional-route";
  }
  const creditableNonAtomic = isCreditableNonAtomicRedemption(route, envelope);
  if ((!route.scoreEligible || route.coverageClass === "diagnostic") && !creditableNonAtomic && !hasBoundedTerms(route)) {
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
  | { state: "included"; capacityPoint: V9ExitCapacityPoint; valuedExecutableUsd: number; costEvidence: "measured" | "upper-bound" }
  | { state: "excluded"; exclusionReason: V9ReasonCode | null }
  | { state: "incomparable" }
  | { state: "unsupported" } {
  if (route.routeSuspension) return { state: "excluded", exclusionReason: null };
  const exclusionReason = routeExclusionReason(route, envelope);
  if (exclusionReason !== null || route.applicability === "not-applicable") {
    return { state: "excluded", exclusionReason };
  }
  const proof = route.executionCertificate ? resolveExitExecutionBoundPoint(route.executionCertificate, request) : null;
  const certifiedPoint = proof && proof.certification !== "diagnostic"
    ? route.capacityCurve.find((point) => point.requestedNotionalUsd === proof.requestedNotionalUsd &&
        point.maxCostBps === proof.maxCostBps && point.executableUsd === proof.executableUsd &&
        point.executionCostBps === proof.executionCostBps)
    : undefined;
  const capacityPoint = route.executionModelId
    ? certifiedPoint ? resolveV9ExitCapacityAtRequest([certifiedPoint], request) : null
    : resolveV9ExitCapacityAtRequest(route.capacityCurve, route.physicalToUsd
      ? { ...request, maxCostBps: envelope.policy.semantic.exit.physicalToUsd.maxCostBps }
      : request);
  if (capacityPoint === null) return { state: "incomparable" };
  // A modeled zero is not an exhaustion measurement. A missing settlement
  // bound also cannot turn a zero lower bound into executable recovery.
  if (capacityPoint.executableUsd === 0 && !isExhaustionMeasurement(route)) {
    return { state: "excluded", exclusionReason: route.settlementBoundUnproven
      ? "unproven-settlement-bound" : "missing-same-notional-route" };
  }
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
    // Certified receipts and physical-sale models quantify cost. Legacy curves
    // used the request ceiling as an unknown-cost sentinel; keep that evidence
    // distinction here rather than relabelling a measured boundary cost.
    costEvidence: hasUnquantifiedFee(route)
      ? "upper-bound"
      : (route.executionModelId && proof) || route.physicalToUsd || capacityPoint.executionCostBps < request.maxCostBps
        ? "measured"
        : "upper-bound",
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

/** Exact resources identify one rail; issuer/protocol labels only correlate it. */
function supersededModeledRoutes(
  routes: readonly V9ExitEvaluationRoute[],
  request: V9ExitStressRequest,
  envelope: V9ValidatedPolicyEnvelope,
): Set<string> {
  const certified = routes.filter((route) => {
    if (!route.executionModelId || !route.executionCertificate || !route.scoreEligible ||
      route.observationState !== "known" || !route.outputResolved || routeExclusionReason(route, envelope) !== null) return false;
    const point = resolveExitExecutionBoundPoint(route.executionCertificate, request);
    return point !== null && point.certification !== "diagnostic";
  });
  const superseded = new Set<string>();
  for (const route of routes) {
    if (route.executionModelId) continue;
    if (certified.some((certificate) => certificate.lane === route.lane &&
      route.physicalResourceKeys.some((key) => !key.startsWith("issuer:") && !key.startsWith("protocol:") &&
        certificate.physicalResourceKeys.includes(key)))) superseded.add(route.routeKey);
  }
  return superseded;
}

/** Resolve distinct physical-resource capacity at an explicit stress request. */
export function resolveV9DistinctExitCapacity(
  routes: readonly V9ExitEvaluationRoute[],
  request: V9ExitStressRequest,
  envelope: V9ValidatedPolicyEnvelope,
): V9DistinctExitCapacity {
  assertV9ValidatedPolicyEnvelope(envelope);
  const superseded = supersededModeledRoutes(routes, request, envelope);
  const included = routes.flatMap((route) => {
    if (superseded.has(route.routeKey)) return [];
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
  const status = factorKey === "access"
    ? route.factorStatuses?.access ?? (route.holderEligibility === "unknown" ? route.factorStatuses?.holderEligibility : undefined)
    : factorKey ? route.factorStatuses?.[factorKey] : route.status;
  const implicitUnknown = (factorKey === "holderEligibility" || factorKey === "access") && route.holderEligibility === "unknown" ||
    factorKey === "settlement" && route.settlementBoundUnproven ||
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
): V9ExitRouteTrace {
  const attribution = {
    routeId: route.routeId,
    lane: route.lane,
    routeFamily: route.routeFamily,
    cause: routeCause(route).cause,
    causeGapIds: routeCause(route).causeGapIds,
    scoringDisposition: v9ScoringDisposition(routeCause(route).cause),
    effectiveScoringWeight: routeCause(route).excluded ? 0 : 1,
    confidenceDimensions: null,
    capacityEvidenceTier: route.capacityEvidenceTier ?? "unknown",
    rawSameNotionalCostBps: null,
    supportedComponentCeiling: null,
    ...(route.feeEvidence ? { feeEvidence: route.feeEvidence } : {}),
    observationConfidence: route.observationConfidence,
    modelConfidence: route.modelConfidence,
    observationHistory: route.observationHistory ?? null,
    ...(route.routeSuspension ? { routeSuspension: route.routeSuspension } : {}),
    ...(route.physicalToUsd ? { physicalToUsd: route.physicalToUsd } : {}),
    ...(route.executionCertificate ? { executionCertificate: route.executionCertificate } : {}),
    capacityScoringHorizon: route.capacityScoringHorizon,
    settlementDelaySec: route.settlementDelaySec,
    queueDepthUsd: route.queueDepthUsd,
    dailyLimitUsd: route.dailyLimitUsd,
    minRedeemUsd: route.minRedeemUsd,
  } as const;
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
  const { capacityPoint, valuedExecutableUsd, costEvidence } = resolvedCapacity;
  const policy = envelope.policy.semantic.exit;
  const completionRatio = valuedExecutableUsd / request.requestedNotionalUsd;
  // Asset-relative materiality must not erase thin measured depth when the
  // absolute stress floor grows; coverage still uses the full stress request.
  if (!isExhaustionMeasurement(route) && !hasMaterialExitCapacity({
    executableCapacityUsd: capacityPoint.executableUsd,
    requestedNotionalUsd: request.rawSupplyRequestUsd,
  }, policy)) {
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
  const coverageScore = interpolateExitBreakpointScore(completionRatio, policy.coverageRatioBreakpoints);
  const absoluteScore = interpolateExitBreakpointScore(valuedExecutableUsd, policy.absoluteCapacityBreakpoints);
  const settlementCause = routeCause(route, "settlement");
  const unknownSettlement = route.settlementBoundUnproven ||
    settlementCause.cause === "C" || settlementCause.cause === "U";
  const delayMultiplier = unknownSettlement ? 1
    : settlementDelayMultiplier(route.settlementDelaySec, policy.settlementDelayBands);
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
    access: route.holderEligibility === "unknown"
      ? unknownQuality("exit", routeCause(route, "holderEligibility").cause, envelope.policy.semantic)
      : policy.accessScores[route.access],
    settlement: unknownSettlement
      ? unknownQuality("exit", settlementCause.cause, envelope.policy.semantic)
      : policy.settlementScores[route.settlement],
    executionCertainty: policy.executionScores[route.execution],
    capacity,
    outputAssetQuality: Math.min(
      route.physicalToUsd ? policy.outputAssetScores["physical-commodity-delivery"] : policy.outputAssetScores[route.outputQuality],
      route.unboundedDeliveryCap === undefined ? 100 : policy.unboundedDeliveryCap,
    ) * route.outputValueRetention,
    cost:
      costEvidence === "upper-bound"
        ? unknownQuality("exit", routeCause(route, "cost").cause, envelope.policy.semantic)
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
    // Capacity and output remain measured even when adjacent research carries
    // a gap. Substitute only the genuinely unknown quality subfactor.
    const unknown = key !== "capacity" && key !== "outputAssetQuality" &&
      (causal.cause === "C" || causal.cause === "U");
    const value = causal.excluded ? null : unknown
      ? unknownQuality("exit", causal.cause, envelope.policy.semantic) : components[key];
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
  // Retain the shipped materiality calibration: exhaustive submaterial
  // measurements remain visible at zero; non-exhaustive bounds were excluded.
  if (valuedExecutableUsd === 0) {
    score = 0;
    capsApplied.push("zero-executable-capacity");
  } else if (!hasMaterialExitCapacity({
    executableCapacityUsd: capacityPoint.executableUsd,
    requestedNotionalUsd: request.rawSupplyRequestUsd,
  }, policy)) {
    score = 0;
    capsApplied.push("immaterial-executable-capacity");
  } else {
    const firstPositiveCoverage = firstPositiveExitBreakpointValue(policy.coverageRatioBreakpoints);
    if (firstPositiveCoverage > 0 && completionRatio < firstPositiveCoverage && score > 50) {
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
    model: confidenceDimension("executionConfidence",
      route.executionModelId && route.executionCertificate && route.modelConfidence === "medium"
        ? policy.exactCertificateModelConfidenceFactor
        : route.evidenceKind === "documented-terms" && route.modelConfidence === "medium"
          ? policy.observationConfidenceFactors.medium
          : policy.modeledConfidenceFactors[route.modelConfidence === "unknown" ? "low" : route.modelConfidence]),
    capacityMethod: confidenceDimension("capacityEvidenceTier",
      route.capacityEvidenceTier === "live-queue-proxy" || route.capacityEvidenceTier === undefined ||
        route.capacityEvidenceTier === "unknown" ? policy.limitedCapacityConfidenceFactor : 1),
  };
  const confidenceFactor = Math.min(
    confidenceDimensions.observation.factor, confidenceDimensions.model.factor, confidenceDimensions.capacityMethod.factor,
  );
  if (route.observationState === "stale") capsApplied.push("observation:stale");
  score *= confidenceFactor;
  if (hasBoundedTerms(route) && score > policy.boundedTermsRecoveryCeiling) {
    score = policy.boundedTermsRecoveryCeiling;
    capsApplied.push("bounded-terms");
  }
  return {
    routeKey: route.routeKey,
    ...attribution,
    score: clampScore(score),
    included: true,
    exclusionReason: null,
    confidenceDimensions,
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
    routeId: route.routeId,
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

/** Retain the original amount evidence clock even when it cannot size the request. */
export function resolveV9ExitSupplySizing(
  asset: Pick<V9AssetFactsBase, "supply"> & Partial<Pick<V9AssetFactsBase, "evidence">>,
): {
  circulatingUsd: number | null;
  supplyObservedAtSec: number | null;
  sizingUncertaintyReason: V9ExitStressRequest["sizingUncertaintyReason"];
} {
  const circulatingUsd = selectV9ExitCirculatingUsd(asset.supply);
  const supplyEvidence = asset.evidence?.filter((reference) =>
    asset.supply.status.evidenceRefIds.includes(reference.evidenceId));
  const supplyObservedAtSec = supplyEvidence?.length
    ? Math.min(...supplyEvidence.map((reference) => reference.observedAtSec)) : null;
  return {
    circulatingUsd,
    supplyObservedAtSec,
    sizingUncertaintyReason: circulatingUsd !== null && Number.isFinite(circulatingUsd) && circulatingUsd > 0
      ? null : asset.supply.status.observationState === "stale" ? "stale-supply"
        : asset.supply.circulatingUsd === null ? "missing-supply" : "unusable-supply",
  };
}

export function evaluateV9ExitAssetFacts(
  asset: Pick<V9AssetFactsBase, "supply" | "exitStatus" | "exitRoutes"> & Partial<Pick<V9AssetFactsBase, "evidence" | "exitCoverage">> & { gaps?: readonly V9FactGapV3[] },
  envelope: V9ValidatedPolicyEnvelope,
  executionContext?: { assetId: string; clockSec: number },
): V9ExitEvaluationResult {
  return evaluateV9Exit(
    {
      ...executionContext,
      ...resolveV9ExitSupplySizing(asset),
      gaps: asset.gaps,
      portfolioFactStatus: asset.exitStatus,
      verifiedNoPoolsSupplyShare: asset.exitCoverage?.verifiedNoPoolsSupplyShare,
      portfolioStatus:
        asset.exitStatus.observationState === "known" && asset.exitStatus.applicability.state === "required"
          ? "reviewed-complete"
          : "incomplete",
      routes: asset.exitRoutes.map(projectV9ExitEvaluationRoute),
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
    supplyObservedAtSec?: number | null;
    sizingUncertaintyReason?: V9ExitStressRequest["sizingUncertaintyReason"];
    assetId?: string;
    clockSec?: number;
    portfolioStatus?: "reviewed-complete" | "incomplete";
    portfolioFactStatus?: V9FactStatusV2;
    verifiedNoPoolsSupplyShare?: number;
    gaps?: readonly V9FactGapV3[];
    routes: readonly V9ExitEvaluationRoute[];
  },
  envelope: V9ValidatedPolicyEnvelope,
): V9ExitEvaluationResult {
  assertV9ValidatedPolicyEnvelope(envelope);
  const sizingUnknown = args.circulatingUsd === null || !Number.isFinite(args.circulatingUsd) || args.circulatingUsd <= 0;
  const inventoryCause = resolveV9StatusCauses([args.portfolioFactStatus], args.gaps);
  const pillarMetadata = {
    aggregationDisposition: "included" as "included" | "excluded-a-b",
    causeGapIds: inventoryCause.causeGapIds,
    limitedEvidenceCauses: inventoryCause.causes.filter((cause): cause is "C" | "U" | "D" => cause === "C" || cause === "U" || cause === "D"),
    supportedComponentKeys: [] as string[],
  };
  const stressRequest: V9ExitStressRequest = {
    ...selectV9ExitStressRequest(args.circulatingUsd, envelope),
    supplyObservedAtSec: args.supplyObservedAtSec ?? null,
    sizingUncertaintyReason: sizingUnknown
      ? args.sizingUncertaintyReason ?? (args.circulatingUsd === null ? "missing-supply" : "unusable-supply")
      : null,
  };
  const routes = args.routes.map((route) => {
    route = { ...route, gaps: args.gaps ?? route.gaps };
    if (!route.executionModelId) return route;
    const certificate = route.executionCertificate;
    const measuredRequest = certificate ? resolveExitExecutionBoundPoint(certificate, stressRequest) : null;
    const admission = certificate && measuredRequest && args.assetId !== undefined && args.clockSec !== undefined
      ? admitExitExecutionCertificate({
          certificate, envelope, assetId: args.assetId, clockSec: args.clockSec,
          inputGenerationId: exitExecutionInputGenerationId(args.assetId, measuredRequest, certificate.inputReference),
          observationGenerationId: domainDigest("safety-score-v10.exit-execution-source.v1", certificate.source),
          request: measuredRequest,
        })
      : null;
    return admission && admission.state !== "unavailable"
      ? { ...route, coverageClass: admission.point.requestedNotionalUsd === stressRequest.requestedNotionalUsd
          ? admission.point.certification : "exact-lower-bound" as const }
      : { ...route, scoreEligible: false };
  }).sort((left, right) => compareText(left.routeKey, right.routeKey));
  const superseded = supersededModeledRoutes(routes, stressRequest, envelope);
  const traces = routes.map((route) => {
    const trace = evaluateRoute(route, stressRequest, envelope);
    return !superseded.has(route.routeKey) ? trace : {
      ...trace, included: false, score: null, effectiveScoringWeight: 0,
      supportedComponentCeiling: null, exclusionReason: null,
    };
  });
  let evaluated = traces
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
  // A route-local materiality zero does not prove whole-asset exhaustion
  // while another applicable rail or the inventory still has bounded gaps.
  // Reuse the no-usable-route path, not a floor on an actual measured zero.
  if (evaluated.length > 0 &&
    evaluated.every((candidate) => candidate.trace.capsApplied.includes("immaterial-executable-capacity")) &&
    (inventoryCause.cause === "C" || inventoryCause.cause === "U" ||
      traces.some((trace, index) => {
        if (trace.included || trace.exclusionReason === null ||
          routes[index]!.applicability === "not-applicable" || routes[index]!.routeSuspension) return false;
        const causal = excludedCause(trace);
        return !causal.excluded && causal.cause !== "D";
      }))) {
    evaluated = [];
    pillarMetadata.supportedComponentKeys = [];
  }
  if (evaluated.length === 0) {
    const hasBoundedMissingRoute = diagnosticReasons.includes("missing-same-notional-route") ||
      routes.some((route) => route.routeSuspension !== undefined ||
        (route.applicability !== "not-applicable" && !route.settlementBoundUnproven &&
          !isExhaustionMeasurement(route))) ||
      diagnosticReasons.some((reason) => reason !== "unproven-settlement-bound");
    const hasUnprovenSettlementBound = diagnosticReasons.includes("unproven-settlement-bound");
    const provenEmptyInventory = args.portfolioStatus === "reviewed-complete" && routes.length === 0 &&
      !inventoryCause.excluded && inventoryCause.cause !== "C" && inventoryCause.cause !== "U";
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
      ...routes.filter((route, index) => route.applicability !== "not-applicable" && !excludedGap(traces[index]!))
        .flatMap((route) => resolveV9StatusCauses(Object.values(route.factorStatuses ?? {}), route.gaps).causes),
      ...(inventoryCause.cause === null && traces.every((trace) => excludedCause(trace).cause === null) ? ["U"] : []),
    ]).filter((cause): cause is "C" | "U" => cause === "C" || cause === "U");
    return {
      ...pillarMetadata,
      aggregationDisposition: pureExcludedInventory ? "excluded-a-b" : "included",
      score: provenEmptyInventory ? 0 : pureExcludedInventory ? null
        : roundTo((1 - (args.verifiedNoPoolsSupplyShare ?? 0)) *
            unknownQuality("exit", pillarMetadata.limitedEvidenceCauses.includes("C") ? "C" : inventoryCause.cause, envelope.policy.semantic), 2),
      stressRequest,
      primaryRouteKey: null,
      diversificationRouteKey: null,
      diversificationBonus: 0,
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
      reasons: ["missing-runtime-route-evidence"],
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
  const controllingCauses: ("C" | "U")[] = [];
  for (const candidate of independent && diversificationBonus > 0 ? [primary, independent] : [primary]) {
    const trace = candidate.trace;
    if (candidate.score <= 0) continue;
    for (const contribution of Object.values(trace.factorContributions ?? {})) {
      if (contribution.effectiveScoringWeight > 0 && contribution.score !== null && contribution.score < 100 &&
        (contribution.cause === "C" || contribution.cause === "U")) controllingCauses.push(contribution.cause);
    }
    for (const dimension of Object.values(trace.confidenceDimensions ?? {})) {
      if (dimension.factor < 1 && dimension.factor === trace.confidenceFactor &&
        (dimension.cause === "C" || dimension.cause === "U")) controllingCauses.push(dimension.cause);
    }
  }
  pillarMetadata.limitedEvidenceCauses = uniqueSorted(controllingCauses);
  return {
    ...pillarMetadata,
    score: roundTo(primary.score + diversificationBonus, 2),
    stressRequest,
    primaryRouteKey: primary.route.routeKey,
    diversificationRouteKey: independent?.route.routeKey ?? null,
    diversificationBonus: roundTo(diversificationBonus, 2),
    reasons: uniqueSorted([
      ...(sizingUnknown ? ["missing-same-notional-route"] : []),
      ...(primary.score === 0 ? ["no-viable-exit-path"] : []),
      ...(hasOtherIncludedRoute && !candidates.some((candidate) => candidate !== primary &&
        disjoint(primary.domains, candidate.domains) && disjoint(primary.resources, candidate.resources)) ? ["correlated-exit-routes"] : []),
    ]) as V9ReasonCode[],
    routes: traces,
  };
}
