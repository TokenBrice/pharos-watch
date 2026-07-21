import type {
  V9EvidenceLevel,
  V9ReasonCode,
  V9StructuralSignal,
  V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import { scoreV9Input, type V9NRReason, type V9ScoreTrace } from "./formula";
import { assertV9ValidatedPolicyEnvelope, resolveV9ReasonPolicy } from "./policy";

export interface V9PillarReason {
  code: V9ReasonCode;
  path: string;
  message: string;
}

export interface V9PillarEvaluation {
  score: number | null;
  evidenceLevel: V9EvidenceLevel;
  reasons: readonly V9PillarReason[];
  structuralSignals: readonly V9StructuralSignal[];
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
  };
  dependencyReasons: readonly V9PillarReason[];
  dependencyStructuralSignals: readonly V9StructuralSignal[];
  methodologyReasons?: readonly V9PillarReason[];
}

export interface V9ProductionScoreTrace extends V9ScoreTrace {
  factSetDigest: string;
  baseInputGenerationId: string;
  evaluationBuildDigest: string;
  asOfSec: number;
  sourceGenerations: Readonly<Record<string, string>>;
}

const PILLAR_KEYS = ["backing", "exit", "control"] as const;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function normalizedReasons(input: V9ProductionScoreInput, envelope: V9ValidatedPolicyEnvelope) {
  const reasons = [
    ...PILLAR_KEYS.flatMap((pillar) => input.pillars[pillar].reasons),
    ...input.peg.reasons,
    ...input.dependencyReasons,
    ...(input.methodologyReasons ?? []),
  ];
  return [...reasons]
    .sort(
      (left, right) =>
        compareText(left.code, right.code) ||
        compareText(left.path, right.path) ||
        compareText(left.message, right.message),
    )
    .map((reason) => ({
      code: reason.code,
      path: reason.path,
      reason: reason.message,
      critical: resolveV9ReasonPolicy(envelope, reason.code).critical,
    }));
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
      unresolved: normalizedReasons(input, envelope),
    },
    envelope,
    input.parent.propagatedReasons,
    limitedPillarCount,
    backingLimited,
  );
  return {
    ...trace,
    factSetDigest: input.identity.factSetDigest,
    baseInputGenerationId: input.identity.baseInputGenerationId,
    evaluationBuildDigest: input.identity.evaluationBuildDigest,
    asOfSec: input.identity.asOfSec,
    sourceGenerations: Object.fromEntries(
      Object.entries(input.identity.sourceGenerations).sort(([a], [b]) => compareText(a, b)),
    ),
  };
}
