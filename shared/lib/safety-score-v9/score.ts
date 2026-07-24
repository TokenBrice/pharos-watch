import type {
  V9EvidenceResponsibility,
} from "../../types/safety-score-v9-facts";
import type {
  V9EvidenceLevel,
  V9ReasonCode,
  V9StructuralSignal,
  V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import {
  scoreV9Input,
  type V9AdverseAttribution,
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

export interface V9PillarReason {
  code: V9ReasonCode;
  path: string;
  message: string;
  responsibility: V9EvidenceResponsibility;
}

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

const PILLAR_KEYS = ["backing", "exit", "control"] as const;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function propagateV9SerialParentAdverseAttribution(
  upstreamAssetId: string,
  attribution: readonly V9AdverseAttribution[],
): V9ParentAdverseAttribution[] {
  const pathPrefix = `parent:${upstreamAssetId}:`;
  const messagePrefix = `Required parent ${upstreamAssetId}: `;
  return [
    ...new Map(
      attribution.map((item) => {
        const alreadyAttributed =
          item.source === "parent-score" && item.path.startsWith(pathPrefix);
        const propagated: V9ParentAdverseAttribution = {
          source: "parent-score",
          path: alreadyAttributed ? item.path : `${pathPrefix}${item.path}`,
          message:
            alreadyAttributed && item.message.startsWith(messagePrefix)
              ? item.message
              : `${messagePrefix}${item.message}`,
          responsibility: "measured-adverse",
        };
        return [`${propagated.path}\u0000${propagated.message}`, propagated];
      }),
    ).values(),
  ].sort(
    (left, right) =>
      compareText(left.path, right.path) ||
      compareText(left.message, right.message),
  );
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
  if (parentScore === null) return [];
  return [
    ...new Map(
      parents
        .filter((parent) => !parent.blocked && parent.score === parentScore)
        .flatMap((parent) =>
          propagateV9SerialParentAdverseAttribution(
            parent.upstreamAssetId,
            parent.adverseAttribution,
          ),
        )
        .map((item) => [`${item.path}\u0000${item.message}`, item]),
    ).values(),
  ].sort(
    (left, right) =>
      compareText(left.path, right.path) ||
      compareText(left.message, right.message),
  );
}

export function propagateV9SerialParentBoundedUncertaintyAttribution(
  upstreamAssetId: string,
  attribution: readonly V9BoundedUncertaintyAttribution[],
): V9ParentBoundedUncertaintyAttribution[] {
  const pathPrefix = `parent:${upstreamAssetId}:`;
  const messagePrefix = `Required parent ${upstreamAssetId}: `;
  return [
    ...new Map(
      attribution.map((item) => {
        const alreadyAttributed =
          item.source === "parent-score" && item.path.startsWith(pathPrefix);
        const propagated: V9ParentBoundedUncertaintyAttribution = {
          ...item,
          source: "parent-score",
          path: alreadyAttributed ? item.path : `${pathPrefix}${item.path}`,
          message:
            alreadyAttributed && item.message.startsWith(messagePrefix)
              ? item.message
              : `${messagePrefix}${item.message}`,
        };
        return [
          [
            propagated.code,
            propagated.path,
            propagated.message,
            propagated.responsibility,
            propagated.boundedness,
          ].join("\u0000"),
          propagated,
        ];
      }),
    ).values(),
  ].sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.path, right.path) ||
      compareText(left.message, right.message) ||
      compareText(left.responsibility, right.responsibility) ||
      compareText(left.boundedness, right.boundedness),
  );
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
  if (parentScore === null) return [];
  return [
    ...new Map(
      parents
        .filter((parent) => !parent.blocked && parent.score === parentScore)
        .flatMap((parent) =>
          propagateV9SerialParentBoundedUncertaintyAttribution(
            parent.upstreamAssetId,
            parent.boundedUncertaintyAttribution,
          ),
        )
        .map((item) => [
          [
            item.code,
            item.path,
            item.message,
            item.responsibility,
            item.boundedness,
          ].join("\u0000"),
          item,
        ]),
    ).values(),
  ].sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.path, right.path) ||
      compareText(left.message, right.message) ||
      compareText(left.responsibility, right.responsibility) ||
      compareText(left.boundedness, right.boundedness),
  );
}

function worstEvidenceLevel(
  input: V9ProductionScoreInput["pillars"],
  envelope: V9ValidatedPolicyEnvelope,
): V9EvidenceLevel {
  const rank = envelope.policy.semantic.evidence.rank;
  return [...PILLAR_KEYS]
    .map((pillar) => input[pillar].evidenceLevel)
    .sort((left, right) => rank[right] - rank[left])[0]!;
}

function normalizeReasonList(reasons: readonly V9PillarReason[], envelope: V9ValidatedPolicyEnvelope) {
  return [...new Map(
    [...reasons].map((reason) => [
      `${reason.code}\u0000${reason.path}\u0000${reason.message}\u0000${reason.responsibility}`,
      reason,
    ]),
  ).values()]
    .sort(
      (left, right) =>
        compareText(left.code, right.code) ||
        compareText(left.path, right.path) ||
        compareText(left.message, right.message) ||
        compareText(left.responsibility, right.responsibility),
    )
    .map((reason) => ({
      code: reason.code,
      path: reason.path,
      reason: reason.message,
      critical: resolveV9ReasonPolicy(envelope, reason.code).critical,
      responsibility: reason.responsibility,
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

/** Assemble one production-shaped score from pure pillar and dependency results. */
export function scoreV9EvaluatedAsset(
  input: V9ProductionScoreInput,
  envelope: V9ValidatedPolicyEnvelope,
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
  const trace = scoreV9Input(
    {
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
      parentRequired: input.parent.required,
      parentScore: input.parent.score,
      structuralSignals,
      unresolved: normalizedScoreBearingReasons,
    },
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
  );
  return {
    ...trace,
    operationalResilience: input.operationalResilience ?? null,
    wrapperParentLimit: input.parent.wrapperParentLimit ?? null,
    unresolvedFacts: normalizeReasonList(
      [
        ...scoreBearingReasons(input, envelope),
        ...(input.unresolvedEvidence ?? []),
      ],
      envelope,
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
