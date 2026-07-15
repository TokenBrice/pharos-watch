import candidatePolicyAsset from "../../data/safety-score-v9/methodology-policy-candidate-v1.json";
import {
  V9MethodologyPolicySchema,
  V9MethodologySemanticPayloadSchema,
  V9ReasonCodeSchema,
  type V9FactDisposition,
  type V9MethodologyPolicy,
  type V9MethodologySemanticPayload,
  type V9ReasonCode,
  type V9ReasonRegistryEntry,
  type V9UnresolvedFact,
  type V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";

const V9_POLICY_DIGEST_DOMAIN = "safety-score-v9.methodology-policy.v1";

const validatedPolicyEnvelopes = new WeakSet<object>();

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function semanticPayload(policy: V9MethodologyPolicy): V9MethodologySemanticPayload {
  return V9MethodologySemanticPayloadSchema.parse({
    schemaVersion: policy.schemaVersion,
    semantic: {
      ...policy.semantic,
      materiality: {
        ...policy.semantic.materiality,
        matureChains: sortedUnique(policy.semantic.materiality.matureChains),
      },
      backing: {
        ...policy.semantic.backing,
        reserve: {
          ...policy.semantic.backing.reserve,
          maturityNotApplicableClasses: sortedUnique(policy.semantic.backing.reserve.maturityNotApplicableClasses),
        },
        archetypes: Object.fromEntries(
          Object.entries(policy.semantic.backing.archetypes).map(([archetype, rubric]) => [
            archetype,
            {
              ...rubric,
              serialComponentKeys: sortedUnique(rubric.serialComponentKeys),
            },
          ]),
        ) as V9MethodologySemanticPayload["semantic"]["backing"]["archetypes"],
      },
      evidence: {
        ...policy.semantic.evidence,
        dispositions: [...policy.semantic.evidence.dispositions].sort((left, right) =>
          compareCodeUnits(left.factClass, right.factClass),
        ),
      },
      exit: {
        ...policy.semantic.exit,
        scoreableEvidenceKinds: {
          dex: sortedUnique(policy.semantic.exit.scoreableEvidenceKinds.dex),
          redemption: sortedUnique(policy.semantic.exit.scoreableEvidenceKinds.redemption),
        },
        strongEvidenceKinds: sortedUnique(policy.semantic.exit.strongEvidenceKinds),
      },
      accessPostureVocabulary: {
        transfer: sortedUnique(policy.semantic.accessPostureVocabulary.transfer),
        freezeExposure: sortedUnique(policy.semantic.accessPostureVocabulary.freezeExposure),
        primaryExit: sortedUnique(policy.semantic.accessPostureVocabulary.primaryExit),
        governance: sortedUnique(policy.semantic.accessPostureVocabulary.governance),
      },
    },
    reasonRegistry: [...policy.reasonRegistry]
      .map((entry) => ({
        ...entry,
        archetypes: sortedUnique(entry.archetypes),
        pathKinds: sortedUnique(entry.pathKinds),
        permittedTreatments: sortedUnique(entry.permittedTreatments),
      }))
      .sort((left, right) => compareCodeUnits(left.code, right.code)),
  });
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function computeV9PolicySemanticDigest(policy: V9MethodologyPolicy): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: V9_POLICY_DIGEST_DOMAIN,
      policy: semanticPayload(policy),
    }),
  );
}

/** Parse, cross-validate, digest, and freeze one explicit methodology policy. */
export function loadV9MethodologyPolicy(rawPolicy: unknown): V9ValidatedPolicyEnvelope {
  const policy = V9MethodologyPolicySchema.parse(rawPolicy);
  const envelope = {
    policy,
    semanticDigest: computeV9PolicySemanticDigest(policy),
  } satisfies V9ValidatedPolicyEnvelope;
  const frozen = deepFreeze(envelope) as V9ValidatedPolicyEnvelope;
  validatedPolicyEnvelopes.add(frozen);
  return frozen;
}

export function assertV9ValidatedPolicyEnvelope(
  envelope: V9ValidatedPolicyEnvelope,
): asserts envelope is V9ValidatedPolicyEnvelope {
  if (!validatedPolicyEnvelopes.has(envelope)) {
    throw new Error("Safety Score v9 policy must be created by loadV9MethodologyPolicy()");
  }
}

export function assertV9ReasonCodesRegistered(
  envelope: V9ValidatedPolicyEnvelope,
  emittedCodes: readonly string[],
): asserts emittedCodes is readonly V9ReasonCode[] {
  assertV9ValidatedPolicyEnvelope(envelope);
  const registered = new Set(envelope.policy.reasonRegistry.map((entry) => entry.code));
  const unknown = sortedUnique(emittedCodes).filter(
    (code) => !V9ReasonCodeSchema.safeParse(code).success || !registered.has(code as V9ReasonCode),
  );
  if (unknown.length > 0) throw new Error(`Unregistered Safety Score v9 reason codes: ${unknown.join(", ")}`);
}

export interface V9ResolvedReasonPolicy {
  readonly reason: V9ReasonRegistryEntry;
  readonly disposition: V9FactDisposition;
  readonly critical: boolean;
  readonly ceiling: { readonly kind: string; readonly limit: number } | null;
}

export function resolveV9ReasonPolicy(envelope: V9ValidatedPolicyEnvelope, code: V9ReasonCode): V9ResolvedReasonPolicy {
  assertV9ValidatedPolicyEnvelope(envelope);
  const reason = envelope.policy.reasonRegistry.find((entry) => entry.code === code);
  if (!reason) throw new Error(`Safety Score v9 policy does not register reason ${code}`);
  const disposition = envelope.policy.semantic.evidence.dispositions.find(
    (entry) => entry.factClass === reason.defaultFactClass,
  );
  if (!disposition) throw new Error(`Safety Score v9 policy does not dispose ${reason.defaultFactClass}`);
  const ceiling = (() => {
    if (reason.ceilingRule?.source === "evidence-level") {
      const limit = envelope.policy.semantic.evidence.ceilings[reason.ceilingRule.level];
      if (limit === null) throw new Error(`Safety Score v9 reason ${code} references a null evidence ceiling`);
      return { kind: `reason:${code}`, limit };
    }
    if (reason.ceilingRule?.source === "minimum-track-record") {
      const minimumBand = [...envelope.policy.semantic.formula.trackRecordCeilings].sort(
        (left, right) => left.minMonthsInclusive - right.minMonthsInclusive,
      )[0];
      if (!minimumBand || minimumBand.limit === null) {
        throw new Error(`Safety Score v9 reason ${code} has no finite minimum track-record ceiling`);
      }
      return { kind: `reason:${code}`, limit: minimumBand.limit };
    }
    if (reason.ceilingRule?.source === "named-ceiling") {
      return {
        kind: `reason:${code}`,
        limit: envelope.policy.semantic.structural.namedReasonCeilings[reason.ceilingRule.key],
      };
    }
    return null;
  })();
  return {
    reason,
    disposition,
    critical: reason.defaultTreatment === "NR",
    ceiling,
  };
}

export function normalizeV9UnresolvedFacts(
  envelope: V9ValidatedPolicyEnvelope,
  facts: readonly V9UnresolvedFact[],
): V9UnresolvedFact[] {
  assertV9ValidatedPolicyEnvelope(envelope);
  return facts.map((fact) => ({
    ...fact,
    critical: resolveV9ReasonPolicy(envelope, fact.code).critical,
  }));
}

export function assertV9UnresolvedFactsMatchPolicy(
  envelope: V9ValidatedPolicyEnvelope,
  facts: readonly V9UnresolvedFact[],
): void {
  assertV9ValidatedPolicyEnvelope(envelope);
  const mismatches = facts
    .filter((fact) => fact.critical !== resolveV9ReasonPolicy(envelope, fact.code).critical)
    .map((fact) => fact.code)
    .filter((code, index, codes) => codes.indexOf(code) === index)
    .sort(compareCodeUnits);
  if (mismatches.length > 0) {
    throw new Error(`Safety Score v9 unresolved facts contradict policy treatment: ${mismatches.join(", ")}`);
  }
}

export const V9_CANDIDATE_POLICY_V1 = loadV9MethodologyPolicy(candidatePolicyAsset);
