import type { V9ReasonCode, V9ValidatedPolicyEnvelope } from "../../types/safety-score-v9";
import type { V9AssetFactsBase, V9ExitRouteFactV2 } from "../../types/safety-score-v9-facts";
import type { ExitRouteObservationHistory } from "../../types/exit-route";
import {
  blendExitCapacityComponent,
  composeExitComponentScore,
  interpolateExitBreakpointScore,
  resolveExitDelayBandMultiplier,
  resolveExitScoringRequest,
  resolveExitThresholdBandMultiplier,
} from "../exit-route-scoring";
import { assertV9ValidatedPolicyEnvelope, resolveV9ReasonPolicy } from "./policy";
import { clampScore } from "./primitives";

export type V9ExitAccess = "permissionless-onchain" | "whitelisted-onchain" | "issuer-api" | "manual";
export type V9ExitSettlement = "atomic" | "immediate" | "same-day" | "days" | "queued";
export type V9ExitHorizon = "immediate" | "near-term" | "queued";
export type V9ExitCapacityScoringHorizon = "immediate" | "daily" | "queued" | "eventual" | "unknown";
export type V9ExitExecution = "deterministic-onchain" | "deterministic-basket" | "rules-based-nav" | "opaque";
export type V9ExitOutputQuality =
  "stable-single" | "stable-basket" | "bluechip-collateral" | "mixed-collateral" | "nav";
export type V9ExitHolderEligibility =
  | "any-holder"
  | "verified-customer"
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
  routeKey: string;
  lane: "dex" | "redemption";
  routeFamily: "dex-amm" | "dex-orderbook" | "issuer-redemption" | "protocol-redemption" | "eventual-redemption";
  applicability: "required" | "not-applicable" | "unresolved";
  observationState: "known" | "missing" | "stale" | "unsupported" | "bounded-unknown";
  scoreEligible: boolean;
  coverageClass: "exact-complete" | "exact-lower-bound" | "diagnostic";
  evidenceKind: string;
  /** The route's reviewed fee is undisclosed: modeled capacity with an unbounded cost. */
  feeEvidence?: "undisclosed-reviewed" | null;
  observationConfidence: "high" | "medium" | "low" | "unknown";
  modelConfidence: "high" | "medium" | "low";
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
  capacityCurve: readonly V9ExitCapacityPoint[];
  routeScoreCap: "queue-redeem" | "offchain-issuer" | null;
  failureDomains: readonly string[];
  physicalResourceKeys: readonly string[];
}

export interface V9ExitRouteTrace {
  routeKey: string;
  routeFamily: V9ExitEvaluationRoute["routeFamily"];
  observationConfidence: V9ExitEvaluationRoute["observationConfidence"];
  modelConfidence: V9ExitEvaluationRoute["modelConfidence"];
  observationHistory: ExitRouteObservationHistory | null;
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
    access: number;
    settlement: number;
    executionCertainty: number;
    capacity: number | null;
    outputAssetQuality: number;
    cost: number;
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

function firstPositiveBreakpointValue(
  points: readonly { value: number; score: number }[],
): number {
  return points.find((point) => point.value > 0 && point.score > 0)?.value ?? 0;
}

/**
 * A route becomes economically material at the first positive coverage or
 * absolute-capacity policy band. This scales for both large and small assets
 * without deriving materiality from display rounding.
 */
function hasMaterialExecutableCapacity(
  completionRatio: number,
  valuedExecutableUsd: number,
  policy: V9ValidatedPolicyEnvelope["policy"]["semantic"]["exit"],
): boolean {
  const coverageFloor = firstPositiveBreakpointValue(policy.coverageRatioBreakpoints);
  const absoluteFloor = firstPositiveBreakpointValue(policy.absoluteCapacityBreakpoints);
  return (
    (coverageFloor > 0 && completionRatio >= coverageFloor) ||
    (absoluteFloor > 0 && valuedExecutableUsd >= absoluteFloor)
  );
}

function roundTraceScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

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
  if (points.length === 0 || curveIssue(points)) return null;
  const eligibleCosts = sortedUnique(
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
 * The non-atomic redemption families eligible for discounted exit credit. Atomic
 * same-notional DEX/redemption keeps its top tier through the ordinary scoring
 * path; these are the reviewed issuer-, protocol-, and eventual-redemption
 * channels that used to floor to the bounded-unknown score regardless of how
 * redeemable the asset actually is.
 */
const CREDITABLE_NON_ATOMIC_REDEMPTION_FAMILIES: readonly V9ExitEvaluationRoute["routeFamily"][] = [
  "issuer-redemption",
  "protocol-redemption",
  "eventual-redemption",
];

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
 * *eligibility* for the discounted credit; whether the route actually clears
 * notional is settled downstream by its measured capacity curve. An impaired,
 * frozen, or discretionary route does not survive as a viable exit because a
 * redemption that cannot clear reports a zero (or immaterial) capacity curve, so
 * the zero-capacity floor drops it exactly as before this relaxation — the pin
 * safety here is that data invariant, not the family membership.
 */
function isCreditableNonAtomicRedemption(
  route: V9ExitEvaluationRoute,
  envelope: V9ValidatedPolicyEnvelope,
): boolean {
  if (route.lane !== "redemption") return false;
  if (!CREDITABLE_NON_ATOMIC_REDEMPTION_FAMILIES.includes(route.routeFamily)) return false;
  if (route.observationState !== "known") return false;
  if (route.outputResolved !== true) return false;
  if (route.coverageClass === "diagnostic") return false;
  if (route.failureDomains.length === 0) return false;
  return envelope.policy.semantic.exit.scoreableEvidenceKinds.redemption.includes(route.evidenceKind);
}

function routeExclusionReason(route: V9ExitEvaluationRoute, envelope: V9ValidatedPolicyEnvelope): V9ReasonCode | null {
  if (route.applicability === "not-applicable") return null;
  if (route.applicability === "unresolved") return "missing-same-notional-route";
  if (route.outputResolved === false) return "unresolved-exit-output";
  if (route.observationState === "missing" || route.observationState === "stale") {
    return "missing-runtime-route-evidence";
  }
  if (route.observationState !== "known") return "unsupported-same-notional-route";
  const creditableNonAtomic = isCreditableNonAtomicRedemption(route, envelope);
  if ((!route.scoreEligible || route.coverageClass === "diagnostic") && !creditableNonAtomic) {
    return "unsupported-same-notional-route";
  }
  if (CREDITABLE_NON_ATOMIC_REDEMPTION_FAMILIES.includes(route.routeFamily) && !creditableNonAtomic) {
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
  const exclusionReason = routeExclusionReason(route, envelope);
  if (exclusionReason !== null || route.applicability === "not-applicable") {
    return { state: "excluded", exclusionReason };
  }
  const capacityPoint = resolveV9ExitCapacityAtRequest(route.capacityCurve, request);
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
    valuedExecutableUsd: capacityPoint.executableUsd * route.outputValueRetention,
  };
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
  for (const route of [...included].sort((left, right) => left.routeKey.localeCompare(right.routeKey))) {
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

function evaluateRoute(
  route: V9ExitEvaluationRoute,
  request: V9ExitStressRequest,
  envelope: V9ValidatedPolicyEnvelope,
  preExitDangerHeld: boolean,
): V9ExitRouteTrace {
  const horizon = routeCapacityHorizon(route, request);
  const attribution = {
    routeFamily: route.routeFamily,
    observationConfidence: route.observationConfidence,
    modelConfidence: route.modelConfidence,
    observationHistory: route.observationHistory ?? null,
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
  if (preExitDangerHeld && route.feeEvidence === "undisclosed-reviewed") {
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
  // A relaxed non-atomic redemption earns exit credit only when it clears
  // material notional at the stress request. A documented route whose cost is
  // unbounded — or that otherwise clears nothing meaningful — is not a reliable
  // exit and must not stand in for a viable path: it stays excluded so the
  // bounded-exit floor and its diagnostic reason hold exactly as before this
  // recalibration. This never touches an atomic/DEX route, which reaches here
  // only through the scoreEligible gate and keeps its existing zero-capacity
  // floor behavior below.
  if (
    isCreditableNonAtomicRedemption(route, envelope) &&
    !hasMaterialExecutableCapacity(completionRatio, valuedExecutableUsd, policy)
  ) {
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
    outputAssetQuality: policy.outputAssetScores[route.outputQuality] * route.outputValueRetention,
    // A cost sitting exactly on the request bound is an upper bound, not a
    // measurement: producers report execution inside maxCostBps without the
    // realized marginal cost. Bounded-unknown cost scores at the policy
    // midpoint instead of pricing the worst case as if it were observed.
    cost:
      capacityPoint.executionCostBps >= request.maxCostBps
        ? policy.boundedCostScore
        : clampScore(100 * (1 - capacityPoint.executionCostBps / Math.max(1, request.maxCostBps))),
  };
  let score = composeExitComponentScore(components, policy.componentWeights);
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
  } else if (!hasMaterialExecutableCapacity(completionRatio, valuedExecutableUsd, policy)) {
    score = 0;
    capsApplied.push("immaterial-executable-capacity");
  } else {
    const firstPositiveCoverage = firstPositiveBreakpointValue(
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
  const confidenceFactor = Math.min(
    policy.observationConfidenceFactors[route.observationConfidence],
    policy.modeledConfidenceFactors[route.modelConfidence],
  );
  score *= confidenceFactor * policy.holderEligibilityMultipliers[route.holderEligibility];
  const routeCap =
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
  // An undisclosed-reviewed fee leaves the route's exit cost unbounded even
  // though its modeled capacity is emitted, so its credit is ceilinged below
  // what a cost-bounded route can earn (SIM-EXIT-L2 lever).
  if (route.feeEvidence === "undisclosed-reviewed" && score > policy.undisclosedFeeRouteScoreCeiling) {
    score = policy.undisclosedFeeRouteScoreCeiling;
    capsApplied.push("fee-evidence:undisclosed-reviewed");
  }
  return {
    routeKey: route.routeKey,
    ...attribution,
    score: roundTraceScore(clampScore(score)),
    included: true,
    exclusionReason: null,
    capacityPoint: {
      ...capacityPoint,
      executableUsd: roundTraceScore(valuedExecutableUsd),
      completionRatio: roundTraceScore(completionRatio),
      executionCostBps: capacityPoint.executionCostBps,
    },
    components: {
      ...components,
      capacity: roundTraceScore(components.capacity),
      outputAssetQuality: roundTraceScore(components.outputAssetQuality),
      cost: roundTraceScore(components.cost),
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
    lane: route.lane,
    routeFamily: route.routeFamily,
    applicability: statusApplicability(route),
    observationState: route.status.observationState,
    scoreEligible: route.scoreEligible,
    coverageClass: route.coverageClass,
    evidenceKind: route.evidenceKind,
    feeEvidence: route.feeEvidence ?? null,
    observationConfidence: route.observationConfidence,
    modelConfidence: route.modelConfidence,
    observationHistory: route.observationHistory ?? null,
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
    outputResolved: route.output.status.observationState === "known" && route.output.valuation !== null,
    outputValueRetention: Math.min(1, route.output.valuation?.valueRetentionRatio ?? 0),
    capacityCurve: route.capacityCurve,
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

export function evaluateV9ExitAssetFacts(
  asset: Pick<V9AssetFactsBase, "supply" | "exitStatus" | "exitRoutes">,
  envelope: V9ValidatedPolicyEnvelope,
  preExitDangerHeld = false,
): V9ExitEvaluationResult {
  return evaluateV9Exit(
    {
      circulatingUsd: asset.supply.status.observationState === "known" ? asset.supply.circulatingUsd : null,
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
  const leftSet = new Set(left);
  return right.every((value) => !leftSet.has(value));
}

function routesAreIndependent(left: V9ExitEvaluationRoute, right: V9ExitEvaluationRoute): boolean {
  return (
    disjoint(left.failureDomains, right.failureDomains) &&
    disjoint(left.physicalResourceKeys, right.physicalResourceKeys)
  );
}

export function evaluateV9Exit(
  args: {
    circulatingUsd: number | null;
    portfolioStatus?: "reviewed-complete" | "incomplete";
    routes: readonly V9ExitEvaluationRoute[];
    /** The asset is held down by a pre-exit adverse fact; undisclosed-fee routes earn no credit. */
    preExitDangerHeld?: boolean;
  },
  envelope: V9ValidatedPolicyEnvelope,
): V9ExitEvaluationResult {
  assertV9ValidatedPolicyEnvelope(envelope);
  // When the policy treats a missing same-notional route as bounded rather
  // than critical, the pillar floors at the bounded-unknown exit score and
  // the reason-coded ceiling bounds the final score.
  const boundedFloor = resolveV9ReasonPolicy(envelope, "missing-same-notional-route").critical
    ? null
    : envelope.policy.semantic.exit.boundedUnknownScore;
  const stressRequest = selectV9ExitStressRequest(args.circulatingUsd, envelope);
  if (stressRequest === null) {
    return {
      score: boundedFloor,
      stressRequest: null,
      primaryRouteKey: null,
      diversificationRouteKey: null,
      diversificationBonus: 0,
      horizons: EMPTY_HORIZONS,
      reasons: ["missing-same-notional-route"],
      routes: [],
    };
  }
  const routes = [...args.routes].sort((left, right) => left.routeKey.localeCompare(right.routeKey));
  const traces = routes.map((route) => evaluateRoute(route, stressRequest, envelope, args.preExitDangerHeld ?? false));
  const evaluated = traces
    .flatMap((trace, index) => (trace.score === null ? [] : [{ trace, route: routes[index]!, score: trace.score }]))
    .sort((left, right) => right.score - left.score || left.route.routeKey.localeCompare(right.route.routeKey));
  const diagnosticReasons = traces.flatMap((trace) => (trace.exclusionReason ? [trace.exclusionReason] : []));
  const horizons = Object.fromEntries(
    (["immediate", "near-term", "queued"] as const).map((horizon) => {
      const best = traces
        .filter((trace) => trace.horizon === horizon && trace.score !== null)
        .sort(
          (left, right) =>
            (right.score ?? 0) - (left.score ?? 0) ||
            left.routeKey.localeCompare(right.routeKey),
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
    const portfolioReviewed = args.portfolioStatus === "reviewed-complete";
    const onlyUnsupportedDiagnostics =
      diagnosticReasons.length > 0 &&
      diagnosticReasons.every((reason) => reason === "unsupported-same-notional-route");
    const defaultReason = portfolioReviewed
      ? "no-viable-exit-path"
      : onlyUnsupportedDiagnostics
        ? null
        : "missing-same-notional-route";
    return {
      score: portfolioReviewed ? 0 : boundedFloor,
      stressRequest,
      primaryRouteKey: null,
      diversificationRouteKey: null,
      diversificationBonus: 0,
      horizons,
      reasons: sortedUnique([
        ...(defaultReason ? [defaultReason] : []),
        ...diagnosticReasons,
      ]) as V9ReasonCode[],
      routes: traces,
    };
  }

  const primary = evaluated[0]!;
  const independent = evaluated.find(
    (candidate) =>
      candidate.route.routeKey !== primary.route.routeKey && routesAreIndependent(primary.route, candidate.route),
  );
  // An undisclosed-reviewed fee route's credit is bounded by its ceiling and must
  // stay bounded at the portfolio level too: it neither earns nor donates the
  // independent-route bonus, so opaque-fee routes cannot stack past the ceiling
  // or lift a stronger primary (adversarial-review hardening of SIM-EXIT-L2).
  const undisclosedFeeInvolved =
    primary.route.feeEvidence === "undisclosed-reviewed" ||
    independent?.route.feeEvidence === "undisclosed-reviewed";
  // Redundancy can improve a strong primary route, but a merely adequate
  // backup must not automatically fill all remaining headroom. Scale the
  // bounded redundancy allowance by the backup route's own quality. Because
  // `independent` cannot outscore the selected primary, a sub-100 primary can
  // no longer become a perfect Exit score solely through redundancy.
  const redundancyHeadroom = Math.min(
    100 - primary.score,
    100 * envelope.policy.semantic.exit.independentRouteBenefitLimit,
  );
  const diversificationBonus =
    independent && !undisclosedFeeInvolved
      ? redundancyHeadroom * (independent.score / 100)
      : 0;
  const hasOtherIncludedRoute = evaluated.length > 1;
  return {
    score: roundTraceScore(primary.score + diversificationBonus),
    stressRequest,
    primaryRouteKey: primary.route.routeKey,
    diversificationRouteKey: independent?.route.routeKey ?? null,
    diversificationBonus: roundTraceScore(diversificationBonus),
    horizons,
    // Excluded optional routes stay visible on their per-route traces; a weak
    // or unreviewed alternative cannot impose a critical reason once a
    // score-eligible route carries the exit claim.
    reasons: sortedUnique([
      ...(hasOtherIncludedRoute && !independent ? ["correlated-exit-routes"] : []),
    ]) as V9ReasonCode[],
    routes: traces,
  };
}
