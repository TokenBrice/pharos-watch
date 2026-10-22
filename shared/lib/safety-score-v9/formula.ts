import {
  V9ScoringInputSchema,
  type V9AssetPremiumKind,
  type V9AssetPremiumPolicy,
  type V9CapSource,
  type V9Grade,
  type V9QualityPillar,
  type V9ReasonCode,
  type V9ScoringInput,
  type V9StructuralSignal,
  type V9UnresolvedFact,
  type V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import type { V9EvidenceResponsibility } from "../../types/safety-score-v9-facts";
import type { V9EvidenceCause, V9PartialEvidence, V9RatingStatus } from "../../types/safety-score-v9-causes";
import {
  aggregateV9SmoothBoundedHeadroom,
  type V9AggregationStrategy,
  type V9WeakestPathAggregationTrace,
  type V9PricedUnknownPillar,
} from "./aggregation";
import {
  assertV9ReasonCodesRegistered,
  assertV9UnresolvedFactsMatchPolicy,
  assertV9ValidatedPolicyEnvelope,
  resolveV9ReasonTreatment,
  unknownQuality,
} from "./policy";
import {
  resolveV9ScopedRisk,
  type V9ScopedRiskAdjustment,
  type V9ScopedRiskResolution,
  type V9ScopedRiskSignal,
} from "./scoped-risk";
import { clampScore } from "../math";
import { DEPEG_SEVERITY_BPS } from "../depeg-config";
import { canonicalUniqueBy, compareText } from "./primitives";
import { deepFreeze } from "../../types/safety-score-v9-immutable";

const validatedScoringInputs = new WeakSet<object>();

/** Validate and freeze a reusable formula input without retaining it after its caller releases it. */
export function parseV9ScoringInput(rawInput: unknown): V9ScoringInput {
  const input = V9ScoringInputSchema.parse(rawInput);
  deepFreeze(input);
  validatedScoringInputs.add(input);
  return input;
}

export type { V9AggregationStrategy } from "./aggregation";

const V9_QUALITY_PILLARS = ["backing", "exit", "control"] as const satisfies readonly V9QualityPillar[];

export interface V9StructuralCap {
  kind: string;
  limit: number;
  reason: string;
}

export interface V9AttributedScenarioCap extends V9StructuralCap {
  responsibility: "measured-adverse";
  pricedInPillar?: V9QualityPillar;
}

export type V9NRReasonCode = V9ReasonCode;

export interface V9NRReason {
  code: V9NRReasonCode;
  message: string;
  field?: string;
  responsibility?: V9EvidenceResponsibility;
  cause?: V9EvidenceCause | null;
  causeGapIds?: readonly string[];
  contributingPillars?: readonly V9QualityPillar[];
  /** Internal stable origin key for downstream causal-path attribution. */
  causalKey?: string;
}

export interface V9CapTrace<S extends V9CapSource | "structural" = V9CapSource> extends V9StructuralCap {
  source: S;
  binding: boolean;
}

export interface V9AdverseAttribution {
  source:
    | "realized-holder-loss"
    | "active-depeg"
    | "parent-score"
    | "peg-performance"
    | "pillar-score"
    | "reason"
    | "structural-signal";
  path: string;
  message: string;
  responsibility: "measured-adverse";
}

export type V9PillarAdverseAttribution = V9AdverseAttribution & {
  source: "pillar-score";
};

export type V9ParentAdverseAttribution = V9AdverseAttribution & {
  source: "parent-score";
};

export type V9BoundedUncertaintyResponsibility = Exclude<
  V9EvidenceResponsibility,
  "measured-adverse"
>;

export interface V9BoundedUncertaintyAttribution {
  source: "parent-score" | "reason";
  code: V9ReasonCode;
  path: string;
  message: string;
  responsibility: V9BoundedUncertaintyResponsibility;
  boundedness: "exposure-bounded" | "globally-bounded";
  cause?: "C" | "U";
  causeGapIds?: readonly string[];
}

export type V9ParentBoundedUncertaintyAttribution = V9BoundedUncertaintyAttribution & {
  source: "parent-score";
};

export interface V9PillarReasonProvenance {
  pillar: V9QualityPillar;
  fact: V9UnresolvedFact;
  componentScore?: number;
  effectiveScoringWeight?: number;
}

export interface V9ScoreCoverage {
  includedPillars: readonly V9QualityPillar[];
  partialEvidence: V9PartialEvidence | null;
  unavailablePillars?: readonly {
    pillar: V9QualityPillar;
    causes: readonly V9EvidenceCause[];
    causeGapIds: readonly string[];
  }[];
  limitingPillars: readonly {
    pillar: V9QualityPillar;
    causes: readonly V9EvidenceCause[];
    causeGapIds: readonly string[];
  }[];
  parentStatus?: V9RatingStatus;
}

export interface V9ScoreTrace {
  assetId: string;
  ratingStatus: V9RatingStatus;
  partialEvidence: V9PartialEvidence | null;
  includedPillars: readonly V9QualityPillar[];
  excludedPillars: readonly V9QualityPillar[];
  effectiveScoringWeights: Readonly<Record<V9QualityPillar, number>> | null;
  supportCeiling: number | null;
  limitingPillars: V9ScoreCoverage["limitingPillars"];
  causeGapIds: readonly string[];
  limitedEvidenceCauses: readonly V9EvidenceCause[];
  diagnosticPillarScores: V9ScoringInput["pillars"];
  policyId: string;
  policyDigest: string;
  configName: string;
  pillarContributions: readonly {
    pillar: V9QualityPillar;
    score: number;
    weight: number;
    weightedContribution: number;
  }[];
  weightedQuality: number | null;
  weakestPillar: { pillar: V9QualityPillar; score: number } | null;
  aggregation: (V9WeakestPathAggregationTrace & { headroom: number }) | null;
  pegMultiplier: number | null;
  baseAssetScore: number | null;
  deploymentAdjustedScore: number | null;
  deploymentAdjustments: readonly V9ScopedRiskAdjustment[];
  unresolvedDeploymentSignals: readonly V9ScopedRiskSignal[];
  preCapScore: number | null;
  scoreAdjustments: readonly V9ScoreAdjustmentTrace[];
  caps: readonly V9CapTrace[];
  bindingCap: V9CapTrace | null;
  structuralSignals: readonly V9StructuralSignal[];
  finalScore: number | null;
  /** Ordinary post-cap score consumed by downstream serial dependencies. */
  inheritableScore: number | null;
  finalGrade: V9Grade | null;
  adverseAttribution: readonly V9AdverseAttribution[];
  boundedUncertaintyAttribution: readonly V9BoundedUncertaintyAttribution[];
  unresolvedFacts: readonly V9UnresolvedFact[];
  nrReasons: readonly V9NRReason[];
  propagatedParentReasons: readonly V9NRReason[];
}

/** Arbitrary caps remain confined to the offline research adapter. */
export type V9ResearchScoreTrace = Omit<V9ScoreTrace, "caps" | "bindingCap"> & {
  caps: readonly V9CapTrace<V9CapSource | "structural">[];
  bindingCap: V9CapTrace<V9CapSource | "structural"> | null;
};

export interface V9ScoreAdjustmentTrace {
  source: "asset-premium";
  kind: V9AssetPremiumKind;
  label: string;
  configuredPoints: number;
  appliedPoints: number;
  scoreBefore: number;
  scoreAfter: number;
  publishedScoreBefore: number;
  publishedScoreAfter: number;
}

const SCORE_MAX = 100;
/**
 * Snap binary float noise to the nearest 15-significant-digit decimal before
 * quantizing: an additive Number.EPSILON is magnitude-blind (one ULP at ~59.5
 * is ~30x larger), so exact decimal halves could round down (VER-002). The
 * window is 15 digits (~22 ULPs), NOT wider: a coarser snap can lift a
 * genuine sub-boundary value across a rounding or floor boundary (VER2-009).
 */
export function decimalSnap(value: number): number {
  return Number(value.toPrecision(15));
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(decimalSnap(value * factor)) / factor;
}

function floorTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor(decimalSnap(value * factor)) / factor;
}

function canonicalAdverseAttribution(
  values: readonly V9AdverseAttribution[],
): V9AdverseAttribution[] {
  return canonicalUniqueBy(
    values,
    (value) => `${value.source}\u0000${value.path}\u0000${value.message}`,
    (left, right) =>
      compareText(left.source, right.source) ||
      compareText(left.path, right.path) ||
      compareText(left.message, right.message),
    "last",
  );
}

function canonicalBoundedUncertaintyAttribution(
  values: readonly V9BoundedUncertaintyAttribution[],
): V9BoundedUncertaintyAttribution[] {
  return canonicalUniqueBy(
    values.filter((value) => (value.causeGapIds?.length ?? 0) > 0),
    (value) =>
      [
        value.source,
        value.code,
        value.path,
        value.message,
        value.responsibility,
        value.boundedness,
        value.cause ?? "U",
        ...(value.causeGapIds ?? []),
      ].join("\u0000"),
    (left, right) =>
      compareText(left.source, right.source) ||
      compareText(left.code, right.code) ||
      compareText(left.path, right.path) ||
      compareText(left.message, right.message) ||
      compareText(left.responsibility, right.responsibility) ||
      compareText(left.boundedness, right.boundedness),
    "last",
  );
}

function gradeForScore(score: number, policy: V9ValidatedPolicyEnvelope): V9Grade {
  return policy.policy.semantic.formula.gradeThresholds.find((threshold) => score >= threshold.minScore)?.grade ?? "F";
}


function scopedSignalKey(signal: V9StructuralSignal): string {
  const domains = [...signal.failureDomainKeys].sort(compareText);
  return [
    "signal",
    signal.kind,
    signal.severity,
    signal.exposureKey ?? "unscoped",
    signal.riskEventKey ?? "event-unidentified",
    domains.join("+") || signal.reason,
  ].join(":");
}

function scopedRiskSignal(signal: V9StructuralSignal, policy: V9ValidatedPolicyEnvelope): V9ScopedRiskSignal | null {
  const deploymentQuality: Partial<Record<V9StructuralSignal["kind"], Partial<Record<V9StructuralSignal["severity"], number>>>> =
    policy.policy.semantic.formula.deploymentExposedQuality;
  const exposedScore = signal.exposedScore ?? deploymentQuality[signal.kind]?.[signal.severity];
  if (signal.economicLossScope !== "deployment" || exposedScore === undefined) return null;
  const failureDomainKey =
    [...signal.failureDomainKeys].sort(compareText).join("+") ||
    `signal:${signal.kind}:${signal.reason}`;
  const rawShare = signal.materialSharePct === undefined ? null : signal.materialSharePct / 100;
  if (
    signal.responsibility !== "measured-adverse" &&
    !(signal.economicLossScope === "deployment" && rawShare === null)
  ) {
    return null;
  }
  const lossAbsorption = (signal.lossAbsorptionPct ?? 0) / 100;
  return {
    signalKey: scopedSignalKey(signal),
    exposureKey: signal.exposureKey ?? scopedSignalKey(signal),
    riskEventKey: signal.riskEventKey ?? scopedSignalKey(signal),
    failureDomainKeys: [...signal.failureDomainKeys].sort(compareText).length > 0
      ? [...signal.failureDomainKeys].sort(compareText)
      : [failureDomainKey],
    economicLossScope: signal.economicLossScope,
    exposedScore,
    exposureShare: rawShare === null ? null : rawShare * (1 - lossAbsorption),
    reason: signal.reason,
  };
}

function speculativeCreditNeedsResidualCap(signal: V9StructuralSignal): boolean {
  if (signal.kind !== "speculative-credit" || signal.severity !== "high") return false;
  // Preserve R1 admission for legacy unscoped signals without widening scoped facts.
  if (signal.economicLossScope === undefined) {
    return signal.responsibility === undefined || signal.responsibility === "measured-adverse";
  }
  return signal.responsibility === "measured-adverse" &&
    (signal.economicLossScope === "reserve-claim" || signal.economicLossScope === "global-claim");
}


function structuralSignalAffectedScore(
  signal: V9StructuralSignal,
  scopedRisk: V9ScopedRiskResolution | null,
  bindingCap: V9CapTrace | null,
): boolean {
  if (signal.responsibility !== "measured-adverse") return false;
  if (bindingCap?.source === "speculative-credit" && speculativeCreditNeedsResidualCap(signal)) return true;
  if (signal.pricedInPillar !== undefined) return true;
  const scopedKey = scopedSignalKey(signal);
  return scopedRisk?.adjustments.some(
    (adjustment) =>
      adjustment.adjustmentPoints > 0 &&
      adjustment.sourceSignalKeys.includes(scopedKey),
  ) ?? false;
}

function unresolvedFactAffectedScore(
  fact: V9UnresolvedFact,
  pillars: V9ScoringInput["pillars"],
  policy: V9ValidatedPolicyEnvelope,
): boolean {
  if (fact.responsibility !== "measured-adverse") return false;
  // A local adverse fact remains diagnostic when an upstream A/B excludes
  // its pillar; it did not contribute to the published score.
  if ((pillars.backing === null && fact.path?.startsWith("backing:")) ||
      (pillars.exit === null && fact.path?.startsWith("exit:")) ||
      (pillars.control === null && fact.path?.startsWith("control:"))) return false;
  const resolved = resolveV9ReasonTreatment(policy, fact.code, fact.cause ?? "U");
  if (
    resolved.reason.boundedness === "exposure-bounded" ||
    resolved.reason.boundedness === "globally-bounded"
  ) {
    return false;
  }
  return resolved.reason.defaultTreatment === "pillar";
}


function boundedUncertaintyForFact(
  fact: V9UnresolvedFact,
  pillars: V9ScoringInput["pillars"],
  policy: V9ValidatedPolicyEnvelope,
  pillarReasonProvenance: readonly V9PillarReasonProvenance[],
): V9BoundedUncertaintyAttribution | null {
  if (
    fact.responsibility === undefined ||
    fact.responsibility === "measured-adverse" ||
    fact.path === undefined
  ) {
    return null;
  }
  const cause = fact.cause ?? "U";
  if (cause !== "C" && cause !== "U") return null;
  const resolved = resolveV9ReasonTreatment(policy, fact.code, cause);
  if (resolved.critical || resolved.treatment === "diagnostic") return null;
  const pillarReasonAffectedScore = pillarReasonProvenance.some(
    (candidate) =>
      candidate.fact.code === fact.code &&
      candidate.fact.path === fact.path &&
      candidate.fact.reason === fact.reason &&
      candidate.fact.responsibility === fact.responsibility &&
      pillars[candidate.pillar] !== null &&
      (candidate.componentScore === undefined || (candidate.effectiveScoringWeight ?? 0) > 0),
  );
  if (!pillarReasonAffectedScore) return null;
  const causeGapIds = fact.causeGapIds ?? (fact.sourceGapId == null ? [] : [fact.sourceGapId]);
  if (causeGapIds.length === 0) return null;
  return {
    source: "reason",
    code: fact.code,
    path: fact.path,
    message: fact.reason,
    responsibility: fact.responsibility,
    cause,
    causeGapIds,
    boundedness: resolved.reason.boundedness === "exposure-bounded" ? "exposure-bounded" : "globally-bounded",
  };
}

export interface V9ReserveLossFacts {
  exposurePct: number;
  lossAbsorptionPct: number;
  failureDomainKey: string;
}

export interface V9WindowedPegScoreFacts {
  pegScore: number | null;
  activeDepeg: boolean | null | undefined;
  lastEventAt: number | null | undefined;
  clockSec: number;
  windowSec: number;
  quietHistoryFloor: number;
}

/**
 * Apply the matrix-verified R5 proxy at the V9 adapter boundary. Capture input
 * carries only an aggregate peg summary, so this cannot recompute event-level
 * history; it only removes a legacy penalty after a proven quiet window.
 */
export function deriveV9WindowedPegScore(facts: V9WindowedPegScoreFacts): number | null {
  if (!Number.isInteger(facts.clockSec)) throw new Error("clockSec must be an integer Unix timestamp");
  if (!Number.isInteger(facts.windowSec) || facts.windowSec <= 0) {
    throw new Error("windowSec must be a positive integer");
  }
  if (!Number.isFinite(facts.quietHistoryFloor) || facts.quietHistoryFloor < 0 || facts.quietHistoryFloor > 100) {
    throw new Error("quietHistoryFloor must be between 0 and 100");
  }
  if (facts.pegScore === null || facts.activeDepeg !== false || facts.pegScore >= facts.quietHistoryFloor) {
    return facts.pegScore;
  }
  const cutoffSec = facts.clockSec - facts.windowSec;
  if (facts.lastEventAt !== null && facts.lastEventAt !== undefined && facts.lastEventAt >= cutoffSec) {
    return facts.pegScore;
  }
  return facts.quietHistoryFloor;
}

/** Convert reserve exposure and loss absorption facts into a cap-free structural signal. */
export function deriveV9ReserveLossSignal(
  facts: V9ReserveLossFacts,
  policy: V9ValidatedPolicyEnvelope,
): V9StructuralSignal {
  assertV9ValidatedPolicyEnvelope(policy);
  for (const [field, value] of [
    ["exposurePct", facts.exposurePct],
    ["lossAbsorptionPct", facts.lossAbsorptionPct],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`${field} must be a finite percentage between 0 and 100`);
    }
  }
  if (facts.failureDomainKey.length === 0) throw new Error("failureDomainKey is required");

  const unabsorbedExposurePct = facts.exposurePct * (1 - facts.lossAbsorptionPct / 100);
  const thresholds = policy.policy.semantic.backing.structural.severityShares;
  const unabsorbedExposureShare = unabsorbedExposurePct / 100;
  const severity =
    unabsorbedExposureShare >= thresholds.critical
      ? "critical"
      : unabsorbedExposureShare >= thresholds.high
        ? "high"
        : unabsorbedExposureShare >= thresholds.moderate
          ? "moderate"
          : "low";
  return {
    kind: "unsafe-backing",
    severity,
    responsibility: "measured-adverse",
    reason: `${facts.exposurePct}% reserve exposure has ${facts.lossAbsorptionPct}% loss absorption, leaving ${roundTo(unabsorbedExposurePct, 4)}% unabsorbed.`,
    materialSharePct: roundTo(unabsorbedExposurePct, 4),
    failureDomainKeys: [facts.failureDomainKey],
    evidence: [],
  };
}



function capPriority(source: V9CapSource | "structural", policy: V9ValidatedPolicyEnvelope): number {
  const priority = source === "structural" ? -1 : policy.policy.semantic.formula.capTiePriority.indexOf(source);
  return priority === -1 ? policy.policy.semantic.formula.capTiePriority.length : priority;
}


function compareCapCandidates(
  left: Omit<V9CapTrace<V9CapSource | "structural">, "binding">,
  right: Omit<V9CapTrace<V9CapSource | "structural">, "binding">,
  policy: V9ValidatedPolicyEnvelope,
): number {
  return (
    left.limit - right.limit ||
    capPriority(left.source, policy) - capPriority(right.source, policy) ||
    compareText(left.kind, right.kind) ||
    compareText(left.reason, right.reason)
  );
}

/** Apply a public-only premium without changing any methodology ceiling. */
export function applyV9AssetPremium(
  trace: V9ScoreTrace,
  premium: V9AssetPremiumPolicy,
  policy: V9ValidatedPolicyEnvelope,
): V9ScoreTrace {
  assertV9ValidatedPolicyEnvelope(policy);
  if (trace.assetId !== premium.assetId) {
    throw new Error(
      `Safety Score v9 ${trace.assetId} cannot apply premium for ${premium.assetId}`,
    );
  }
  if (trace.finalScore === null || trace.preCapScore === null) {
    throw new Error(`Safety Score v9 ${trace.assetId} cannot apply an asset premium to NR`);
  }
  if (trace.scoreAdjustments.length > 0) {
    throw new Error(`Safety Score v9 ${trace.assetId} already has a score adjustment`);
  }
  const adjustedPreCapRaw = clampScore(trace.preCapScore + premium.points);
  const appliedPoints = roundTo(adjustedPreCapRaw - trace.preCapScore, 4);
  if (appliedPoints <= 0) return trace;

  const adjustedCandidates = trace.caps.map<Omit<V9CapTrace, "binding">>(({ binding: _binding, ...cap }) => cap);
  const quantizedUncapped = roundTo(adjustedPreCapRaw, 0);
  const bindingCandidate =
    [...adjustedCandidates]
      .sort((left, right) => compareCapCandidates(left, right, policy))
      .find((cap) => cap.limit < quantizedUncapped) ?? null;
  const finalScore = Math.min(quantizedUncapped, premium.maximumPublishedScore, bindingCandidate?.limit ?? SCORE_MAX);
  const caps = adjustedCandidates.map<V9CapTrace>((cap) => ({
    ...cap,
    binding: cap === bindingCandidate,
  }));
  const scoreAfter = roundTo(adjustedPreCapRaw, 4);
  const publishedScoreBefore = trace.finalScore;

  return {
    ...trace,
    preCapScore: scoreAfter,
    scoreAdjustments: [{
      source: "asset-premium",
      kind: premium.kind,
      label: premium.label,
      configuredPoints: premium.points,
      appliedPoints,
      scoreBefore: trace.preCapScore,
      scoreAfter,
      publishedScoreBefore,
      publishedScoreAfter: finalScore,
    }],
    caps,
    bindingCap: bindingCandidate ? { ...bindingCandidate, binding: true } : null,
    finalScore,
    finalGrade: gradeForScore(finalScore, policy),
  };
}

/** Score expectation-free V9 facts under one explicit, validated policy. */
export function scoreV9Input(
  rawInput: V9ScoringInput,
  policy: V9ValidatedPolicyEnvelope,
  propagatedParentReasons: readonly V9NRReason[] = [],
  propagatedParentAdverseAttribution: readonly V9ParentAdverseAttribution[] = [],
  measuredPillarAdverseAttribution: readonly V9PillarAdverseAttribution[] = [],
  propagatedParentBoundedUncertaintyAttribution:
    readonly V9ParentBoundedUncertaintyAttribution[] = [],
  pillarReasonProvenance: readonly V9PillarReasonProvenance[] = [],
  aggregationStrategy: V9AggregationStrategy = aggregateV9SmoothBoundedHeadroom,
  coverage?: V9ScoreCoverage,
): V9ScoreTrace {
  assertV9ValidatedPolicyEnvelope(policy);
  const input = validatedScoringInputs.has(rawInput) ? rawInput : V9ScoringInputSchema.parse(rawInput);
  assertV9UnresolvedFactsMatchPolicy(policy, input.unresolved);
  const formula = policy.policy.semantic.formula;
  const nrReasons: V9NRReason[] = [];
  const pillarContributions: V9ScoreTrace["pillarContributions"][number][] = [];

  const includedPillars = coverage?.includedPillars ??
    V9_QUALITY_PILLARS.filter((pillar) => input.pillars[pillar] !== null);
  const excludedPillars = V9_QUALITY_PILLARS.filter((pillar) => !includedPillars.includes(pillar));
  const pillarPipelineGap = includedPillars.length < 2;
  const parentPipelineGap = input.parentRequired && input.parentScore === null &&
    coverage?.parentStatus !== "not-rated";
  const pipelineGap = pillarPipelineGap || parentPipelineGap;
  const limitingPillars: V9ScoreCoverage["limitingPillars"][number][] = [];
  const diagnosticLimitedCauses = new Set<V9EvidenceCause>();
  for (const item of coverage?.limitingPillars ?? []) {
    if (!includedPillars.includes(item.pillar)) continue;
    let hasLimitingCause = false;
    for (const cause of item.causes) {
      if (cause !== "C" && cause !== "U" && cause !== "D") continue;
      diagnosticLimitedCauses.add(cause);
      hasLimitingCause = true;
    }
    if (hasLimitingCause && item.causeGapIds.length > 0) limitingPillars.push(item);
  }
  const pricedUnknownPillars: V9PricedUnknownPillar[] = pipelineGap ? [] : excludedPillars.map((pillar) => {
    const unavailable = coverage?.unavailablePillars?.find((item) => item.pillar === pillar);
    const cause = unavailable?.causes.includes("C") ? "C" as const : "U" as const;
    return {
      pillar, cause, score: unknownQuality(pillar, cause, policy.policy.semantic),
      causeGapIds: unavailable?.causeGapIds ?? [],
    };
  });
  const aggregationPillars = { ...input.pillars };
  for (const unknown of pricedUnknownPillars) aggregationPillars[unknown.pillar] = unknown.score;
  for (const pillar of pipelineGap ? includedPillars : V9_QUALITY_PILLARS) {
    const score = aggregationPillars[pillar];
    if (score === null) {
      throw new Error(`Safety Score v9 included ${pillar} pillar is missing its bounded score`);
    }
    if (!pipelineGap) {
      const weight = formula.pillarWeights[pillar];
      pillarContributions.push({ pillar, score, weight, weightedContribution: roundTo(score * weight, 4) });
    }
  }
  if (pillarPipelineGap) {
    nrReasons.push({
      code: includedPillars.length === 0 ? "all-pillars-pipeline-gap" : "single-pillar-pipeline-gap",
      cause: "U",
      message: "Fewer than two supported pillars are available; no Safety Score is published.",
      causeGapIds: coverage?.partialEvidence?.causeGapIds ?? [],
    });
  }
  if (parentPipelineGap) {
    nrReasons.push(...(propagatedParentReasons.length > 0 ? propagatedParentReasons : [{
      code: "missing-parent-score" as const, cause: "U" as const,
      message: "A required parent has a technical pipeline gap; no child score is published.",
      causeGapIds: coverage?.partialEvidence?.causeGapIds ?? [],
    }]));
  }
  // Missing peg evidence is diagnostic, not a second generic cap beside its
  // cause-bearing producer reason. This neutral multiplier does not claim par.
  const pegUnverified = input.pegApplicable && input.pegScore === null;
  if (!pipelineGap && input.parentRequired && input.parentScore === null) {
    const witnesses = propagatedParentReasons.filter((reason) =>
      reason.cause === "C" || reason.cause === "U" || reason.cause === "D",
    );
    if (coverage?.parentStatus === "not-rated" && witnesses.length > 0) {
      nrReasons.push(...witnesses);
    } else {
      throw new Error("Safety Score v9 required unavailable parent lacks status/cause coverage");
    }
  }
  const unresolvedFacts = [...input.unresolved].sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.path ?? "", right.path ?? "") ||
      compareText(left.reason, right.reason),
  );

  const aggregationHeadroom = pipelineGap ? null : formula.compensabilityHeadroom;
  const aggregationRaw = pipelineGap ? null : aggregationStrategy(
    aggregationPillars, formula.pillarWeights, formula.compensabilityHeadroom, includedPillars,
  );
  if (!pipelineGap && aggregationRaw === null) {
    throw new Error("Safety Score v9 eligible aggregation returned no score");
  }
  const weightedQualityRaw = aggregationRaw?.weightedQuality ?? null;
  const weakestPillar = aggregationRaw === null ? null : {
    pillar: aggregationRaw.weakestPillar, score: aggregationRaw.weakestScore,
  };
  const pegMultiplierRaw = pipelineGap ? null : input.pegApplicable
    ? input.pegScore === null
      ? pegUnverified
        ? 1
        : null
      : input.pegScore === 0
        ? 0
        : (input.pegScore / 100) ** formula.pegExponent
    : 1;
  const baseAssetScoreRaw =
    aggregationRaw === null || pegMultiplierRaw === null
      ? null
      : clampScore(aggregationRaw.score * pegMultiplierRaw);
  const compositeScopedSignals = input.structuralSignals.flatMap((signal) => {
    if (signal.pricedInPillar !== undefined) return [];
    const scoped = scopedRiskSignal(signal, policy);
    return scoped === null ? [] : [scoped];
  });
  const scopedRisk =
    baseAssetScoreRaw === null ? null : resolveV9ScopedRisk(baseAssetScoreRaw, compositeScopedSignals);
  const preCapScoreRaw = scopedRisk?.finalScore ?? null;

  const capCandidates: Omit<V9CapTrace, "binding">[] = [];
  const [trackRecordCeiling] = formula.trackRecordCeilings;
  if (input.trackRecordMonths !== null && input.trackRecordMonths < trackRecordCeiling.maxMonthsExclusive) {
    capCandidates.push({
      source: "track-record", kind: trackRecordCeiling.kind,
      limit: trackRecordCeiling.limit, reason: trackRecordCeiling.reason,
    });
  }
  if (input.activeDepegBps !== null) {
    const activeCap = [...formula.activeDepegCaps]
      .sort((left, right) => right.minimumBps - left.minimumBps)
      .find((cap) => input.activeDepegBps! >= cap.minimumBps);
    if (activeCap) {
      capCandidates.push({
        source: "active-depeg",
        limit: activeCap.limit,
        kind: activeCap.kind,
        reason: activeCap.reason,
      });
    }
  }
  if (input.parentRequired && input.parentScore !== null) {
    capCandidates.push({
      source: "parent",
      kind: "parent",
      limit: input.parentScore,
      reason: "A child cannot rate above its required parent.",
    });
  }
  for (const signal of input.structuralSignals) {
    if (!speculativeCreditNeedsResidualCap(signal)) continue;
    capCandidates.push({
      source: "speculative-credit", kind: "signal:speculative-credit:high",
      limit: formula.speculativeCreditResidualLimit, reason: signal.reason,
    });
  }
  for (const event of input.realizedHolderLossEvents ?? []) {
    const lossBps = event.realizedHolderLossPct * 100;
    const lossPolicy = formula.realizedHolderLoss;
    const initialLimit = lossBps >= DEPEG_SEVERITY_BPS.severe
      ? lossPolicy.initialLimits.severe
      : lossBps >= DEPEG_SEVERITY_BPS.offPeg
        ? lossPolicy.initialLimits.offPeg
        : null;
    if (initialLimit === null) continue;
    if (input.asOfSec === undefined) throw new Error("Realized holder loss requires a scoring clock");
    const ageDays = (input.asOfSec - Date.parse(event.occurredAt) / 1000) / 86_400;
    if (ageDays < 0) continue;
    const limit = Math.min(SCORE_MAX, initialLimit +
      (SCORE_MAX - initialLimit) * Math.max(0, ageDays - lossPolicy.holdDays) / lossPolicy.recoveryDays);
    capCandidates.push({
      source: "realized-holder-loss", kind: `realized-holder-loss:${event.incidentId}`,
      limit, reason: event.finding,
    });
  }

  // Every ceiling enters published integer score space once, before selection.
  const normalizedCandidates = capCandidates.map((cap) => ({
    ...cap,
    limit: floorTo(cap.limit, 0),
  }));

  // Identical (source, kind, limit) candidates collapse to one trace row; the
  // deterministically first reason survives so repeated shared-path signals do
  // not flood the published cap list.
  const dedupedCandidates = canonicalUniqueBy(
    [...normalizedCandidates].sort((left, right) => compareCapCandidates(left, right, policy)),
    (cap) => `${cap.source}\u0000${cap.kind}\u0000${cap.limit}`,
    (left, right) => compareCapCandidates(left, right, policy),
    "first",
  );
  // Caps bind in the QUANTIZED score space: a cap constrains the published
  // score whenever the rounded uncapped score would exceed the floored cap
  // limit, even if the raw score sits below the fractional limit (VER-001).
  const quantizedUncapped = preCapScoreRaw === null ? null : roundTo(preCapScoreRaw, 0);
  // canonicalUniqueBy already returns candidates ordered by compareCapCandidates
  // with this policy, so the first candidate under the quantized score is the
  // binding one without re-sorting the filtered view.
  const bindingCandidate =
    preCapScoreRaw === null || quantizedUncapped === null
      ? null
      : (dedupedCandidates.find(
          (cap) => cap.limit < quantizedUncapped,
        ) ?? null);
  const caps = dedupedCandidates.map<V9CapTrace>((cap) => ({ ...cap, binding: cap === bindingCandidate }));
  const rateable = nrReasons.length === 0 && preCapScoreRaw !== null;
  const finalScore = rateable
    ? Math.min(quantizedUncapped!, bindingCandidate?.limit ?? SCORE_MAX)
    : null;
  const finalCaps: readonly V9CapTrace[] = caps;
  const finalBindingCap: V9CapTrace | null = bindingCandidate ? { ...bindingCandidate, binding: true } : null;
  const { danger } = formula;

  // The public card suppresses every binding assertion on an NR outcome
  // (`projectSafetyScoreV9Card` publishes `bindingCap: null`), and the card
  // schema requires cap-causal attribution to reconcile to that published
  // binding cap. Attribute against the cap the card will actually publish, so
  // an unavailable trace never claims a binding whole-score cause.
  const publishedBindingCap: V9CapTrace | null = finalScore === null ? null : finalBindingCap;
  const adverseAttribution = canonicalAdverseAttribution([
    ...measuredPillarAdverseAttribution,
    ...unresolvedFacts.flatMap<V9AdverseAttribution>((fact) =>
      unresolvedFactAffectedScore(fact, input.pillars, policy)
        ? [{
            source: "reason",
            path: fact.path ?? `reason:${fact.code}`,
            message: fact.reason,
            responsibility: "measured-adverse",
          }]
        : [],
    ),
    ...input.structuralSignals.flatMap<V9AdverseAttribution>((signal) =>
      !structuralSignalAffectedScore(signal, scopedRisk, publishedBindingCap)
        ? []
        : [{
            source: "structural-signal",
            path: `structural:${signal.kind}:${signal.severity}`,
            message: signal.reason,
            responsibility: "measured-adverse",
          }],
    ),
    ...(input.realizedHolderLossEvents ?? []).flatMap<V9AdverseAttribution>((event) =>
      publishedBindingCap?.source === "realized-holder-loss" &&
      publishedBindingCap.kind === `realized-holder-loss:${event.incidentId}`
        ? [{
            source: "realized-holder-loss",
            path: `incident:${event.incidentId}`,
            message: `${event.finding} Sources: ${event.primarySources.map((source) => source.url).join(", ")}`,
            responsibility: "measured-adverse",
          }]
        : [],
    ),
    ...(publishedBindingCap?.source === "parent"
      ? propagatedParentAdverseAttribution
      : []),
    ...(publishedBindingCap?.source === "active-depeg"
      ? [{
          source: "active-depeg" as const,
          path: "peg:active-depeg",
          message: `Active depeg peak is ${input.activeDepegBps} bps.`,
          responsibility: "measured-adverse" as const,
        }]
      : []),
    ...(typeof pegMultiplierRaw === "number" &&
      pegMultiplierRaw < danger.adverseAttributionPegMultiplierFloor
      ? [{
          source: "peg-performance" as const,
          path: "peg:historical-performance",
          message: `Measured peg multiplier is ${roundTo(pegMultiplierRaw, 6)}.`,
          responsibility: "measured-adverse" as const,
        }]
      : []),
  ]);
  const boundedUncertaintyAttribution = canonicalBoundedUncertaintyAttribution([
    ...(aggregationRaw === null ? [] : unresolvedFacts.flatMap((fact) => {
      const attribution = boundedUncertaintyForFact(
        fact,
        input.pillars,
        policy,
        pillarReasonProvenance,
      );
      return attribution === null ? [] : [attribution];
    })),
    ...(publishedBindingCap?.source === "parent"
      ? propagatedParentBoundedUncertaintyAttribution
      : []),
  ]);


  assertV9ReasonCodesRegistered(
    policy,
    nrReasons.map((reason) => reason.code),
  );

  return {
    assetId: input.assetId,
    ratingStatus: pipelineGap ? "pipeline-gap" : finalScore === null ? "not-rated" : "rated",
    partialEvidence: coverage?.partialEvidence ?? null,
    includedPillars,
    excludedPillars,
    effectiveScoringWeights: aggregationRaw?.effectiveScoringWeights ?? null,
    supportCeiling: aggregationRaw?.supportCeiling ?? null,
    limitingPillars,
    causeGapIds: [...new Set([
      ...limitingPillars.flatMap((item) => item.causeGapIds),
      ...(coverage?.partialEvidence?.causeGapIds ?? []),
    ])].sort(compareText),
    limitedEvidenceCauses: [...diagnosticLimitedCauses].sort(compareText),
    diagnosticPillarScores: input.pillars,
    policyId: policy.policy.policyId,
    policyDigest: policy.semanticDigest,
    configName: policy.policy.policyId,
    pillarContributions,
    weightedQuality: weightedQualityRaw === null ? null : roundTo(weightedQualityRaw, 4),
    weakestPillar,
    aggregation:
      aggregationRaw === null || aggregationHeadroom === null
        ? null
        : {
            ...aggregationRaw,
            pricedUnknownPillars,
            score: roundTo(aggregationRaw.score, 4),
            weightedQuality: roundTo(aggregationRaw.weightedQuality, 4),
            weakestScore: roundTo(aggregationRaw.weakestScore, 4),
            headroom: aggregationHeadroom,
          },
    pegMultiplier: pegMultiplierRaw === null ? null : roundTo(pegMultiplierRaw, 6),
    baseAssetScore: baseAssetScoreRaw === null ? null : roundTo(baseAssetScoreRaw, 4),
    deploymentAdjustedScore: scopedRisk === null ? null : roundTo(scopedRisk.finalScore, 4),
    deploymentAdjustments:
      scopedRisk?.adjustments.map((adjustment) => ({
        ...adjustment,
        scoreBefore: roundTo(adjustment.scoreBefore, 4),
        scoreAfter: roundTo(adjustment.scoreAfter, 4),
        adjustmentPoints: roundTo(adjustment.adjustmentPoints, 4),
      })) ?? [],
    unresolvedDeploymentSignals: scopedRisk?.unresolvedDeploymentSignals ?? [],
    preCapScore: preCapScoreRaw === null ? null : roundTo(preCapScoreRaw, 4),
    scoreAdjustments: [],
    caps: finalCaps,
    bindingCap: finalBindingCap,
    structuralSignals: input.structuralSignals,
    finalScore,
    inheritableScore: finalScore,
    finalGrade: pipelineGap ? null : finalScore === null ? "NR" : gradeForScore(finalScore, policy),
    adverseAttribution,
    boundedUncertaintyAttribution,
    unresolvedFacts,
    nrReasons,
    propagatedParentReasons,
  };
}


/** @internal Golden-corpus adapter; arbitrary caps are not accepted by production scoring input. */
export function scoreV9InputWithScenarioCaps(
  rawInput: V9ScoringInput,
  policy: V9ValidatedPolicyEnvelope,
  scenarioCaps: readonly V9AttributedScenarioCap[],
  coverage?: V9ScoreCoverage,
  propagatedParentReasons: readonly V9NRReason[] = [],
): V9ResearchScoreTrace {
  const trace = scoreV9Input(rawInput, policy, propagatedParentReasons, [], [], [], [], undefined, coverage);
  const candidates: V9ResearchScoreTrace["caps"][number][] = [
    ...trace.caps,
    ...scenarioCaps.map((cap) => ({
      source: "structural" as const, kind: cap.kind, reason: cap.reason,
      limit: floorTo(cap.limit, 0), binding: false,
    })),
  ];
  candidates.sort((left, right) => compareCapCandidates(left, right, policy));
  const uncapped = trace.preCapScore === null ? null : roundTo(trace.preCapScore, 0);
  const bindingCap = uncapped === null ? null : candidates.find((cap) => cap.limit < uncapped) ?? null;
  const finalScore = trace.finalScore === null ? null : Math.min(trace.finalScore, bindingCap?.limit ?? SCORE_MAX);
  return {
    ...trace,
    caps: candidates.map((cap) => ({ ...cap, binding: cap === bindingCap })),
    bindingCap: bindingCap === null ? null : { ...bindingCap, binding: true },
    finalScore, inheritableScore: finalScore,
    finalGrade: finalScore === null ? trace.finalGrade : gradeForScore(finalScore, policy),
    adverseAttribution: canonicalAdverseAttribution([
      ...trace.adverseAttribution,
      ...scenarioCaps.flatMap<V9AdverseAttribution>((cap) =>
        cap.pricedInPillar !== undefined || bindingCap?.source === "structural" && bindingCap.kind === cap.kind
          ? [{ source: "structural-signal", path: `scenario-cap:${cap.kind}`, message: cap.reason, responsibility: cap.responsibility }]
          : [],
      ),
    ]),
  };
}
