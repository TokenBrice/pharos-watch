import {
  type V9AssetPremiumPolicy,
  type V9EvidenceLevel,
  type V9QualityPillar,
  type V9ScoringInput,
  type V9StructuralSignal,
  type V9UnresolvedFact,
  type V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import type { V9EvidenceCause, V9PartialEvidence, V9RatingStatus } from "../../types/safety-score-v9-causes";
import type { V9AdmittedHolderLossEvent } from "../../types/safety-score-v9-incidents";
import {
  applyV9AssetPremium,
  parseV9ScoringInput,
  scoreV9Input,
  type V9AdverseAttribution,
  type V9AggregationStrategy,
  type V9BoundedUncertaintyAttribution,
  type V9DeploymentAuthority,
  type V9NRReason,
  type V9ParentAdverseAttribution,
  type V9ParentBoundedUncertaintyAttribution,
  type V9PillarAdverseAttribution,
  type V9PillarReasonProvenance,
  type V9ScoreTrace,
} from "./formula";
import type { V9WrapperParentLimit } from "./wrapper-risk";
import { assertV9ValidatedPolicyEnvelope, resolveV9ReasonTreatment } from "./policy";
import { canonicalUniqueBy, compareText, parentAttributionFields, propagateParentAttribution } from "./primitives";
import { V9_EMPTY_ARRAY } from "../../types/safety-score-v9-immutable";
import { isV9SharedControllerSignalAlreadyPriced } from "./scoped-risk";
import {
  canonicalizeV9PublicReasons,
  type V9PublicReason,
} from "./reasons";

export type V9PillarReason = V9PublicReason;

export interface V9PillarEvaluation {
  score: number | null;
  aggregationDisposition: "included" | "excluded-a-b" | "unavailable";
  causeGapIds: readonly string[];
  limitedEvidenceCauses: readonly V9EvidenceCause[];
  /** Exact witnesses of the reason-based pillar limitation, not all diagnostic gaps. */
  limitingCauseGapIds?: readonly string[];
  supportedComponentKeys: readonly string[];
  excludedComponentKeys?: readonly string[];
  excludedCauseGapIds?: readonly string[];
  excludedCauses?: readonly ("A" | "B")[];
  evidenceLevel: V9EvidenceLevel;
  reasons: readonly V9PillarReason[];
  /** Real scored C/U components; their bounds need not pull the whole pillar below C-. */
  boundedComponents?: readonly {
    reason: V9PillarReason;
    score: number;
    effectiveScoringWeight: number;
  }[];
  structuralSignals: readonly V9StructuralSignal[];
  deploymentAuthorities?: readonly V9DeploymentAuthority[];
  adverseAttribution?: readonly V9PillarAdverseAttribution[];
}

export interface V9ProductionScoreIdentity {
  factSetDigest: string;
  baseInputGenerationId: string;
  evaluationBuildDigest: string;
  asOfSec: number;
  sourceGenerations: Readonly<Record<string, string>>;
}

export interface V9ProductionScoreInput {
  assetId: string;
  /** Supply rank at the fixed evaluation clock; absent values cannot qualify for rank-gated policy. */
  marketRank?: number | null;
  identity: V9ProductionScoreIdentity;
  pillars: {
    backing: V9PillarEvaluation;
    exit: V9PillarEvaluation;
    control: V9PillarEvaluation;
  };
  peg: {
    applicable: boolean;
    score: number | null;
    activeDepegBps: number | null;
    reasons: readonly V9PillarReason[];
  };
  trackRecordMonths: number | null;
  realizedHolderLossEvents?: readonly V9AdmittedHolderLossEvent[];
  parent: {
    required: boolean;
    score: number | null;
    ratingStatus?: V9RatingStatus;
    causeGapIds?: readonly string[];
    limitedEvidenceCauses?: readonly V9EvidenceCause[];
    partialEvidence?: V9PartialEvidence | null;
    propagatedReasons: readonly V9NRReason[];
    propagatedAdverseAttribution?: readonly V9ParentAdverseAttribution[];
    propagatedBoundedUncertaintyAttribution?:
      readonly V9ParentBoundedUncertaintyAttribution[];
    wrapperParentLimit?: V9WrapperParentLimit | null;
  };
  dependencyReasons: readonly V9PillarReason[];
  dependencyStructuralSignals: readonly V9StructuralSignal[];
  methodologyReasons?: readonly V9PillarReason[];
  unresolvedEvidence?: readonly V9PillarReason[];
}

export interface V9ProductionScoreTrace extends V9ScoreTrace {
  factSetDigest: string;
  baseInputGenerationId: string;
  evaluationBuildDigest: string;
  asOfSec: number;
  sourceGenerations: Readonly<Record<string, string>>;
  wrapperParentLimit: V9WrapperParentLimit | null;
}

/** Premiums are public-only score adjustments and never propagate downstream. */
export function projectV9DependencyScore(
  trace: Pick<V9ScoreTrace, "inheritableScore">,
): number | null {
  return trace.inheritableScore;
}

const PILLAR_KEYS = ["backing", "exit", "control"] as const;

const parentAdverseKey = (item: V9ParentAdverseAttribution) => `${item.path}\u0000${item.message}`;
const compareParentAdverse = (left: V9ParentAdverseAttribution, right: V9ParentAdverseAttribution) =>
  compareText(left.path, right.path) || compareText(left.message, right.message);
const parentBoundedKey = (item: V9ParentBoundedUncertaintyAttribution) =>
  [item.code, item.path, item.message, item.responsibility, item.boundedness].join("\u0000");
const compareParentBounded = (
  left: V9ParentBoundedUncertaintyAttribution,
  right: V9ParentBoundedUncertaintyAttribution,
) =>
  compareText(left.code, right.code) ||
  compareText(left.path, right.path) ||
  compareText(left.message, right.message) ||
  compareText(left.responsibility, right.responsibility) ||
  compareText(left.boundedness, right.boundedness);

function resolveV9SerialParentAttribution<
  P extends { score: number | null; blocked: boolean },
  T,
>(
  parentScore: number | null,
  parents: readonly P[],
  attributionFor: (parent: P) => readonly T[],
  keyOf: (item: T) => string,
  compare: (left: T, right: T) => number,
): T[] {
  if (parentScore === null) return [];
  return canonicalUniqueBy(
    parents.filter((parent) => !parent.blocked && parent.score === parentScore).flatMap(attributionFor),
    keyOf,
    compare,
    "last",
  );
}

export function propagateV9SerialParentAdverseAttribution(
  upstreamAssetId: string,
  attribution: readonly V9AdverseAttribution[],
): V9ParentAdverseAttribution[] {
  return propagateParentAttribution({
    upstreamAssetId,
    items: attribution,
    project: (item, context) => ({
      source: "parent-score",
      ...parentAttributionFields(item, context),
      responsibility: "measured-adverse",
    }),
    keyOf: parentAdverseKey,
    compare: compareParentAdverse,
  });
}

export function resolveV9SerialParentAdverseAttribution(
  parentScore: number | null,
  parents: readonly {
    upstreamAssetId: string;
    score: number | null;
    blocked: boolean;
    adverseAttribution: readonly V9AdverseAttribution[];
  }[],
): V9ParentAdverseAttribution[] {
  return resolveV9SerialParentAttribution(
    parentScore,
    parents,
    (parent) =>
        propagateV9SerialParentAdverseAttribution(
          parent.upstreamAssetId,
          parent.adverseAttribution,
        ),
    parentAdverseKey,
    compareParentAdverse,
  );
}

export function propagateV9SerialParentBoundedUncertaintyAttribution(
  upstreamAssetId: string,
  attribution: readonly V9BoundedUncertaintyAttribution[],
): V9ParentBoundedUncertaintyAttribution[] {
  return propagateParentAttribution({
    upstreamAssetId,
    items: attribution,
    project: (item, context) => ({
      ...item,
      source: "parent-score",
      ...parentAttributionFields(item, context),
    }),
    keyOf: parentBoundedKey,
    compare: compareParentBounded,
  });
}

export function resolveV9SerialParentBoundedUncertaintyAttribution(
  parentScore: number | null,
  parents: readonly {
    upstreamAssetId: string;
    score: number | null;
    blocked: boolean;
    boundedUncertaintyAttribution: readonly V9BoundedUncertaintyAttribution[];
  }[],
): V9ParentBoundedUncertaintyAttribution[] {
  return resolveV9SerialParentAttribution(
    parentScore,
    parents,
    (parent) =>
        propagateV9SerialParentBoundedUncertaintyAttribution(
          parent.upstreamAssetId,
          parent.boundedUncertaintyAttribution,
        ),
    parentBoundedKey,
    compareParentBounded,
  );
}

type V9ScoringInputSource = {
  readonly assetId: string;
  readonly pillars: Readonly<Record<V9QualityPillar, Pick<V9PillarEvaluation, "score" | "evidenceLevel">>>;
  readonly peg: Pick<V9ProductionScoreInput["peg"], "score" | "applicable" | "activeDepegBps">;
  readonly trackRecordMonths: number | null;
  readonly realizedHolderLossEvents?: readonly V9AdmittedHolderLossEvent[];
  readonly identity?: Pick<V9ProductionScoreIdentity, "asOfSec">;
};

function worstEvidenceLevel(
  input: V9ScoringInputSource["pillars"],
  envelope: V9ValidatedPolicyEnvelope,
): V9EvidenceLevel {
  const rank = envelope.policy.semantic.evidence.rank;
  return [...PILLAR_KEYS]
    .map((pillar) => input[pillar].evidenceLevel)
    .sort((left, right) => rank[right] - rank[left])[0]!;
}

/** Project the complete formula input while keeping production-only trace arguments outside it. */
export function projectV9ScoringInput(
  input: V9ScoringInputSource,
  envelope: V9ValidatedPolicyEnvelope,
  projection: Pick<
    V9ScoringInput,
    "parentRequired" | "parentScore" | "structuralSignals" | "unresolved"
  >,
): V9ScoringInput {
  return parseV9ScoringInput({
    assetId: input.assetId,
    pillars: {
      backing: input.pillars.backing.score,
      exit: input.pillars.exit.score,
      control: input.pillars.control.score,
    },
    pegScore: input.peg.score,
    pegApplicable: input.peg.applicable,
    evidenceLevel: worstEvidenceLevel(input.pillars, envelope),
    trackRecordMonths: input.trackRecordMonths,
    realizedHolderLossEvents: input.realizedHolderLossEvents,
    asOfSec: input.identity?.asOfSec,
    activeDepegBps: input.peg.activeDepegBps,
    ...projection,
  });
}

function normalizeReasonList(
  reasons: readonly V9PillarReason[],
  envelope: V9ValidatedPolicyEnvelope,
  cache: WeakMap<V9PillarReason, V9UnresolvedFact>,
) {
  return canonicalizeV9PublicReasons(reasons, {
    dedupeSourceGapIds: true,
    conflictSubject: "unresolved fact",
  }).map((reason) => {
    const cached = cache.get(reason);
    if (cached !== undefined) return cached;
    const ids = reason.causeGapIds ?? (reason.sourceGapId == null ? V9_EMPTY_ARRAY : [reason.sourceGapId]);
    const fact: V9UnresolvedFact = {
      code: reason.code,
      path: reason.path,
      reason: reason.message,
      critical: resolveV9ReasonTreatment(envelope, reason.code, reason.cause ?? "U").critical,
      responsibility: reason.cause === "A" ? reason.responsibility
        : reason.cause === "B" ? "public-data-uncurated" as const
          : reason.cause === "C" ? "issuer-undisclosed" as const
            : reason.cause === "D" ? "measured-adverse" as const : "unresearched" as const,
      cause: reason.cause ?? "U",
      causeGapIds: ids.length === 0 ? V9_EMPTY_ARRAY : ids as string[],
      scoringDisposition: resolveV9ReasonTreatment(envelope, reason.code, reason.cause ?? "U").scoringDisposition,
      ...(reason.sourceGapId == null ? {} : { sourceGapId: reason.sourceGapId }),
    };
    cache.set(reason, fact);
    return fact;
  });
}

function scoreBearingReasons(
  input: V9ProductionScoreInput,
): V9PillarReason[] {
  return [
    ...PILLAR_KEYS.flatMap((pillar) => input.pillars[pillar].reasons),
    ...input.peg.reasons,
    ...input.dependencyReasons,
    ...(input.methodologyReasons ?? []),
  ];
}

function reconcileBoundedAttributionFacts(
  unresolvedFacts: readonly V9UnresolvedFact[],
  scoreBearingFacts: readonly V9UnresolvedFact[],
  attribution: readonly V9BoundedUncertaintyAttribution[],
): V9UnresolvedFact[] {
  const byPublicIdentity = new Map(
    unresolvedFacts.map((fact) => [`${fact.code}\u0000${fact.path ?? ""}`, fact]),
  );
  for (const item of attribution) {
    if (item.source !== "reason") continue;
    const key = `${item.code}\u0000${item.path}`;
    const existing = byPublicIdentity.get(key);
    if (existing !== undefined) {
      if (existing.responsibility !== item.responsibility) {
        throw new Error(
          `Safety Score v9 bounded attribution ${item.code} at ${item.path} has multiple causal owners`,
        );
      }
      continue;
    }
    const ownedFact = scoreBearingFacts.find(
      (fact) =>
        fact.code === item.code &&
        fact.path === item.path &&
        fact.reason === item.message &&
        fact.responsibility === item.responsibility,
    );
    if (ownedFact === undefined) {
      throw new Error(
        `Safety Score v9 bounded attribution ${item.code} at ${item.path} lacks an owned score-bearing fact`,
      );
    }
    byPublicIdentity.set(key, ownedFact);
  }
  return [...byPublicIdentity.values()].sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.path ?? "", right.path ?? "") ||
      compareText(left.reason, right.reason) ||
      compareText(left.responsibility ?? "", right.responsibility ?? ""),
  );
}


function validateIdentity(identity: V9ProductionScoreIdentity): void {
  if (!/^[a-f0-9]{64}$/.test(identity.factSetDigest)) throw new Error("Invalid Safety Score v9 fact-set digest");
  if (!/^report-cards-input:v1:[a-f0-9]{64}$/.test(identity.baseInputGenerationId)) {
    throw new Error("Invalid Safety Score v9 base input generation");
  }
  if (!/^[a-f0-9]{64}$/.test(identity.evaluationBuildDigest)) {
    throw new Error("Invalid Safety Score v9 evaluation-build digest");
  }
  if (!Number.isInteger(identity.asOfSec) || identity.asOfSec < 0) {
    throw new Error("Invalid Safety Score v9 evidence clock");
  }
}


/**
 * Resolve a policy-defined asset premium from the ordinary score only. This is
 * intentionally separate from formula application so the premium cannot make
 * itself eligible.
 */
function resolveV9AssetPremium(
  input: V9ProductionScoreInput,
  ordinaryTrace: V9ScoreTrace,
  envelope: V9ValidatedPolicyEnvelope,
): V9AssetPremiumPolicy | null {
  const premium = envelope.policy.semantic.formula.assetPremiums.find(
    (candidate) => candidate.assetId === input.assetId,
  );
  if (premium === undefined) return null;
  if (
    ordinaryTrace.finalScore === null ||
    ordinaryTrace.preCapScore === null ||
    ordinaryTrace.finalScore >= premium.maximumPublishedScore ||
    input.marketRank !== premium.requiredMarketRank ||
    input.trackRecordMonths === null ||
    input.trackRecordMonths < premium.minimumTrackRecordMonths ||
    input.parent.required ||
    input.pillars.exit.score === null ||
    input.pillars.exit.score < premium.minimumExitScore ||
    !input.peg.applicable ||
    input.peg.score === null ||
    input.peg.reasons.length > 0 ||
    input.peg.activeDepegBps !== null ||
    ordinaryTrace.adverseAttribution.some(
      (attribution) => attribution.source === "peg-performance",
    ) ||
    ordinaryTrace.caps.some((cap) => cap.limit < premium.maximumPublishedScore)
  ) {
    return null;
  }
  const evidenceRank = envelope.policy.semantic.evidence.rank;
  const requiredEvidenceRank = evidenceRank[premium.requiredEvidenceLevel];
  if (
    PILLAR_KEYS.some(
      (pillar) => input.pillars[pillar].aggregationDisposition !== "included" ||
        evidenceRank[input.pillars[pillar].evidenceLevel] > requiredEvidenceRank,
    )
  ) {
    return null;
  }
  return premium;
}

/** Assemble one production-shaped score from pure pillar and dependency results. */
export function scoreV9EvaluatedAsset(
  input: V9ProductionScoreInput,
  envelope: V9ValidatedPolicyEnvelope,
  aggregationStrategy?: V9AggregationStrategy,
): V9ProductionScoreTrace {
  assertV9ValidatedPolicyEnvelope(envelope);
  validateIdentity(input.identity);
  const authorities = input.pillars.control.deploymentAuthorities ?? [];
  const authorityControllerKeys = new Set(authorities.flatMap((authority) => authority.controllerKeys ?? []));
  const structuralSignals = [
    ...PILLAR_KEYS.flatMap((pillar) => input.pillars[pillar].structuralSignals),
    ...input.dependencyStructuralSignals,
  ].map((signal) => isV9SharedControllerSignalAlreadyPriced(signal, [], authorityControllerKeys)
    ? { ...signal, pricedInPillar: "control" as const } : signal);
  const includedPillars = PILLAR_KEYS.filter((pillar) => input.pillars[pillar].aggregationDisposition === "included");
  const excludedPillars = PILLAR_KEYS.filter((pillar) => !includedPillars.includes(pillar)).sort(compareText);
  const causeExcludedPillars = excludedPillars.filter((pillar) => input.pillars[pillar].aggregationDisposition === "excluded-a-b");
  const unavailablePillars = excludedPillars.map((pillar) => {
    const evaluation = input.pillars[pillar];
    return {
      pillar,
      causes: [...new Set([
        ...evaluation.limitedEvidenceCauses, ...(evaluation.excludedCauses ?? []),
        ...evaluation.reasons.flatMap((reason) => reason.cause == null ? [] : [reason.cause]),
      ])],
      causeGapIds: [...new Set([
        ...evaluation.causeGapIds, ...(evaluation.excludedCauseGapIds ?? []),
        ...evaluation.reasons.flatMap((reason) => reason.causeGapIds ?? []),
      ])].sort(compareText),
    };
  });
  const limitingPillars = includedPillars.flatMap((pillar) => {
    const evaluation = input.pillars[pillar];
    // A diagnostic cause does not make an otherwise assessable pillar unverifiable.
    if (evaluation.evidenceLevel !== "limited" && evaluation.evidenceLevel !== "insufficient") return [];
    const causes = evaluation.limitedEvidenceCauses.filter((cause) => cause === "C" || cause === "U" || cause === "D");
    const excluded = new Set(evaluation.excludedCauseGapIds ?? []);
    const witnessIds = (evaluation.limitingCauseGapIds ?? evaluation.causeGapIds).filter((id) => !excluded.has(id));
    return causes.length === 0 || witnessIds.length === 0 ? [] : [{ pillar, causes, causeGapIds: witnessIds }];
  });
  const excludedConstraints = [...input.peg.reasons, ...(input.methodologyReasons ?? [])].flatMap((reason) => {
    const cause = reason.cause;
    return cause === "A" || cause === "B" ? [{
      cause, causeGapIds: reason.causeGapIds ?? (reason.sourceGapId == null ? [] : [reason.sourceGapId]),
      componentKey: reason.path,
    }] : [];
  });
  const parentExclusions = input.parent.partialEvidence?.causes.map((cause) => ({
    cause, causeGapIds: input.parent.partialEvidence!.causeGapIds, componentKey: "dependency:parent",
  })) ?? [];
  const exclusions = [...excludedConstraints, ...parentExclusions];
  const excludedCauseGapIds = [...new Set([
    ...PILLAR_KEYS.flatMap((pillar) => input.pillars[pillar].excludedCauseGapIds ?? []),
    ...exclusions.flatMap((item) => item.causeGapIds),
  ])].sort(compareText);
  const excludedCauses = [...new Set([
    ...PILLAR_KEYS.flatMap((pillar) => input.pillars[pillar].excludedCauses ?? []),
    ...exclusions.map((item) => item.cause),
  ])].sort(compareText);
  const excludedComponentKeys = [...new Set([
    ...PILLAR_KEYS.flatMap((pillar) => input.pillars[pillar].excludedComponentKeys ?? []),
    ...exclusions.map((item) => item.componentKey),
  ])].sort(compareText);
  if (causeExcludedPillars.length > 0 && (excludedCauseGapIds.length === 0 || excludedCauses.length === 0)) {
    throw new Error("Safety Score v9 excluded pillars lack A/B cause coverage");
  }
  const partialEvidence: V9PartialEvidence | null = excludedPillars.length === 0 && excludedCauseGapIds.length === 0 ? null : {
    reasonCode: "partial-evidence-pipeline-gap", excludedPillars, excludedComponentKeys,
    causeGapIds: excludedCauseGapIds, causes: excludedCauses,
  };
  const baseScoreBearingReasons = scoreBearingReasons(input);
  const normalizedReasons = new WeakMap<V9PillarReason, V9UnresolvedFact>();
  const normalizedScoreBearingReasons = normalizeReasonList(baseScoreBearingReasons, envelope, normalizedReasons);
  const pillarReasonProvenance: V9PillarReasonProvenance[] = PILLAR_KEYS.flatMap((pillar) => [
    ...normalizeReasonList(input.pillars[pillar].reasons, envelope, normalizedReasons).map((fact) => ({
      pillar,
      fact,
    })),
    ...(input.pillars[pillar].boundedComponents ?? []).flatMap((component) =>
      normalizeReasonList([component.reason], envelope, normalizedReasons).map((fact) => ({
        pillar, fact, componentScore: component.score, effectiveScoringWeight: component.effectiveScoringWeight,
      })),
    ),
  ]);
  const measuredPillarAdverseAttribution = PILLAR_KEYS.flatMap(
    (pillar) => input.pillars[pillar].score === null ? [] : input.pillars[pillar].adverseAttribution ?? [],
  );
  const scoringInput = projectV9ScoringInput(
    input,
    envelope,
    {
      parentRequired: input.parent.required,
      parentScore: input.parent.score,
      structuralSignals,
      unresolved: normalizedScoreBearingReasons,
    },
  );
  const ordinaryTrace = scoreV9Input(
    scoringInput,
    envelope,
    input.parent.propagatedReasons,
    input.parent.propagatedAdverseAttribution ?? [],
    measuredPillarAdverseAttribution,
    input.parent.propagatedBoundedUncertaintyAttribution ?? [],
    pillarReasonProvenance,
    aggregationStrategy,
    {
      includedPillars, partialEvidence, unavailablePillars, limitingPillars,
      parentStatus: input.parent.ratingStatus,
      deploymentAuthorities: input.pillars.control.deploymentAuthorities,
      authoritySignalIndices: new Set(authorities.flatMap((authority) =>
        (authority.sourceSignalIndices ?? []).map((index) => index +
          input.pillars.backing.structuralSignals.length + input.pillars.exit.structuralSignals.length))),
    },
  );
  const premium = resolveV9AssetPremium(input, ordinaryTrace, envelope);
  const trace =
    premium === null
      ? ordinaryTrace
      : applyV9AssetPremium(ordinaryTrace, premium, envelope);
  // Preserve economic witnesses independently of the resulting letter grade.
  const boundedUncertaintyAttribution = trace.boundedUncertaintyAttribution;
  const emissionReasons = baseScoreBearingReasons;
  const emissionFacts = normalizedScoreBearingReasons;
  return {
    ...trace,
    boundedUncertaintyAttribution,
    wrapperParentLimit: input.parent.wrapperParentLimit ?? null,
    unresolvedFacts: reconcileBoundedAttributionFacts(
      normalizeReasonList(
        [...emissionReasons, ...(input.unresolvedEvidence ?? [])],
        envelope,
        normalizedReasons,
      ),
      emissionFacts,
      boundedUncertaintyAttribution,
    ),
    factSetDigest: input.identity.factSetDigest,
    baseInputGenerationId: input.identity.baseInputGenerationId,
    evaluationBuildDigest: input.identity.evaluationBuildDigest,
    asOfSec: input.identity.asOfSec,
    sourceGenerations: input.identity.sourceGenerations,
  };
}
