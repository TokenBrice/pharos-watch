import {
  V9ScoringInputSchema,
  type V9AssetPremiumPolicy,
  type V9EvidenceLevel,
  type V9QualityPillar,
  type V9ScoringInput,
  type V9StructuralSignal,
  type V9UnresolvedFact,
  type V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import {
  applyV9AssetPremium,
  scoreV9Input,
  type V9AdverseAttribution,
  type V9AggregationStrategy,
  type V9BoundedUncertaintyAttribution,
  type V9NRReason,
  type V9ParentAdverseAttribution,
  type V9ParentBoundedUncertaintyAttribution,
  type V9PillarAdverseAttribution,
  type V9PillarReasonProvenance,
  type V9ScoreTrace,
} from "./formula";
import type { V9OperationalResilienceResult } from "./operational-resilience";
import type { V9WrapperParentLimit } from "./wrapper-risk";
import { assertV9ValidatedPolicyEnvelope, resolveV9ReasonPolicy } from "./policy";
import {
  canonicalUniqueBy,
  compareText,
  parentAttributionFields,
  propagateParentAttribution,
} from "./primitives";
import {
  canonicalizeV9PublicReasons,
  type V9PublicReason,
} from "./reasons";

export type V9PillarReason = V9PublicReason;

export interface V9PillarEvaluation {
  score: number | null;
  evidenceLevel: V9EvidenceLevel;
  reasons: readonly V9PillarReason[];
  structuralSignals: readonly V9StructuralSignal[];
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
  trackRecordMonths: number;
  parent: {
    required: boolean;
    score: number | null;
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
  operationalResilience?: V9OperationalResilienceResult | null;
}

export interface V9ProductionScoreTrace extends V9ScoreTrace {
  factSetDigest: string;
  baseInputGenerationId: string;
  evaluationBuildDigest: string;
  asOfSec: number;
  sourceGenerations: Readonly<Record<string, string>>;
  operationalResilience: V9OperationalResilienceResult | null;
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
  readonly trackRecordMonths: number;
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
  return V9ScoringInputSchema.parse({
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
    activeDepegBps: input.peg.activeDepegBps,
    ...projection,
  });
}

function normalizeReasonList(reasons: readonly V9PillarReason[], envelope: V9ValidatedPolicyEnvelope) {
  return canonicalizeV9PublicReasons(reasons, {
    dedupeSourceGapIds: true,
    conflictSubject: "unresolved fact",
  })
    .map((reason) => ({
      code: reason.code,
      path: reason.path,
      reason: reason.message,
      critical: resolveV9ReasonPolicy(envelope, reason.code).critical,
      responsibility: reason.responsibility,
      ...(reason.sourceGapId == null ? {} : { sourceGapId: reason.sourceGapId }),
    }));
}

function scoreBearingReasons(
  input: V9ProductionScoreInput,
  envelope: V9ValidatedPolicyEnvelope,
): V9PillarReason[] {
  return [
    ...PILLAR_KEYS.flatMap((pillar) => input.pillars[pillar].reasons),
    ...input.peg.reasons,
    ...input.dependencyReasons,
    ...(input.methodologyReasons ?? []),
    ...(input.unresolvedEvidence ?? []).filter(
      (reason) => resolveV9ReasonPolicy(envelope, reason.code).critical,
    ),
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

function wrapperLocalAttribution(limit: V9WrapperParentLimit | null | undefined): {
  adverse: V9AdverseAttribution[];
  bounded: V9BoundedUncertaintyAttribution[];
} {
  if (limit === null || limit === undefined || limit.appliedDiscount <= 0) {
    return { adverse: [], bounded: [] };
  }
  const fallbackDeterminesDiscount =
    !limit.factsComplete &&
    limit.fallbackDiscount > limit.localRiskDiscount;
  if (fallbackDeterminesDiscount) {
    return {
      adverse: [],
      bounded: limit.missingFacts.map((fact) => ({
        source: "wrapper-local",
        code: "bounded-mechanism-review",
        path: `wrapper-local:${fact.factClass}`,
        message:
          `Wrapper-local ${fact.factClass} is ${fact.disposition}; ` +
          `the ${limit.form} fallback discount bounds the unresolved local layer.`,
        responsibility: fact.disposition,
        boundedness: "exposure-bounded",
      })),
    };
  }
  return {
    adverse: limit.adjustments.flatMap((adjustment) =>
      adjustment.discountPoints <= 0
        ? []
        : [{
            source: "wrapper-local",
            path: `wrapper-local:${adjustment.factKey}`,
            message:
              `Reviewed wrapper-local ${adjustment.factKey} risk contributes ` +
              `${adjustment.discountPoints} discount points.`,
            responsibility: "measured-adverse",
          }],
    ),
    bounded: [],
  };
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

function resolvesOnlyPremiumCap(
  trace: V9ScoreTrace,
  premium: V9AssetPremiumPolicy,
): boolean {
  const bindingCapAllowed =
    trace.bindingCap === null ||
    (
      trace.bindingCap.source === premium.capRelief.source &&
      trace.bindingCap.kind === premium.capRelief.kind &&
      trace.bindingCap.limit === premium.capRelief.fromLimit
    );
  if (!bindingCapAllowed) return false;
  return trace.caps.every(
    (cap) =>
      (
        cap.source === premium.capRelief.source &&
        cap.kind === premium.capRelief.kind &&
        cap.limit === premium.capRelief.fromLimit
      ) ||
      cap.limit >= premium.maximumPublishedScore,
  );
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
    ordinaryTrace.finalScore < premium.minimumBaseScore ||
    ordinaryTrace.finalScore >= premium.maximumPublishedScore ||
    input.marketRank !== premium.requiredMarketRank ||
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
    !resolvesOnlyPremiumCap(ordinaryTrace, premium)
  ) {
    return null;
  }
  const evidenceRank = envelope.policy.semantic.evidence.rank;
  const requiredEvidenceRank = evidenceRank[premium.requiredEvidenceLevel];
  if (
    PILLAR_KEYS.some(
      (pillar) => evidenceRank[input.pillars[pillar].evidenceLevel] > requiredEvidenceRank,
    )
  ) {
    return null;
  }
  const resilience = input.operationalResilience;
  if (
    resilience === null ||
    resilience === undefined ||
    !resilience.eligible ||
    resilience.blockerCodes.length > 0
  ) {
    return null;
  }
  const contributed = new Set(
    resilience.contributions.map((contribution) => contribution.component),
  );
  if (
    premium.requiredOperationalComponents.some(
      (component) => !contributed.has(component),
    )
  ) {
    return null;
  }
  const hasRelievableCap = ordinaryTrace.caps.some(
    (cap) =>
      cap.source === premium.capRelief.source &&
      cap.kind === premium.capRelief.kind &&
      cap.limit === premium.capRelief.fromLimit,
  );
  return hasRelievableCap ? premium : null;
}

/** Assemble one production-shaped score from pure pillar and dependency results. */
export function scoreV9EvaluatedAsset(
  input: V9ProductionScoreInput,
  envelope: V9ValidatedPolicyEnvelope,
  aggregationStrategy?: V9AggregationStrategy,
): V9ProductionScoreTrace {
  assertV9ValidatedPolicyEnvelope(envelope);
  validateIdentity(input.identity);
  const structuralSignals = [
    ...PILLAR_KEYS.flatMap((pillar) => input.pillars[pillar].structuralSignals),
    ...input.dependencyStructuralSignals,
  ];
  // Thread the per-pillar `limited` count so the scorer can widen the withhold
  // (Lever 1): only the rolled-up worst evidence level is otherwise visible.
  const limitedPillarCount = PILLAR_KEYS.filter(
    (pillar) => input.pillars[pillar].evidenceLevel === "limited",
  ).length;
  // The withhold only fires when the BACKING pillar itself is unverifiable:
  // a strong-backing asset is assessable (we know it is backed) even if exit
  // and control are limited, so it must be scored, never withheld to NR.
  const backingLimited = input.pillars.backing.evidenceLevel === "limited";
  const normalizedScoreBearingReasons = normalizeReasonList(
    scoreBearingReasons(input, envelope),
    envelope,
  );
  const pillarReasonProvenance: V9PillarReasonProvenance[] = PILLAR_KEYS.flatMap(
    (pillar) =>
      normalizeReasonList(input.pillars[pillar].reasons, envelope).map((fact) => ({
        pillar,
        fact,
      })),
  );
  const measuredPillarAdverseAttribution = PILLAR_KEYS.flatMap(
    (pillar) => input.pillars[pillar].adverseAttribution ?? [],
  );
  const wrapperAttribution = wrapperLocalAttribution(input.parent.wrapperParentLimit);
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
    limitedPillarCount,
    backingLimited,
    input.parent.propagatedAdverseAttribution ?? [],
    measuredPillarAdverseAttribution,
    input.parent.propagatedBoundedUncertaintyAttribution ?? [],
    wrapperAttribution.adverse,
    wrapperAttribution.bounded,
    pillarReasonProvenance,
    aggregationStrategy,
  );
  const premium = resolveV9AssetPremium(input, ordinaryTrace, envelope);
  const trace =
    premium === null
      ? ordinaryTrace
      : applyV9AssetPremium(ordinaryTrace, premium, envelope);
  return {
    ...trace,
    operationalResilience: input.operationalResilience ?? null,
    wrapperParentLimit: input.parent.wrapperParentLimit ?? null,
    unresolvedFacts: reconcileBoundedAttributionFacts(
      normalizeReasonList(
        [
          ...scoreBearingReasons(input, envelope),
          ...(input.unresolvedEvidence ?? []),
        ],
        envelope,
      ),
      normalizedScoreBearingReasons,
      trace.boundedUncertaintyAttribution,
    ),
    factSetDigest: input.identity.factSetDigest,
    baseInputGenerationId: input.identity.baseInputGenerationId,
    evaluationBuildDigest: input.identity.evaluationBuildDigest,
    asOfSec: input.identity.asOfSec,
    sourceGenerations: Object.fromEntries(
      Object.entries(input.identity.sourceGenerations).sort(([a], [b]) => compareText(a, b)),
    ),
  };
}
