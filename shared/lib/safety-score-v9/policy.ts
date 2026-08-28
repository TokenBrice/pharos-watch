import candidatePolicyAsset from "../../data/safety-score-v9/methodology-policy-candidate-v1.json";
import { CHAIN_MATURITY_ADMITTED_CHAIN_SLUGS } from "../../data/safety-score-v9/chain-maturity-reviews-v1";
import {
  V9MethodologyPolicySchema,
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
import { compareText, deepFreeze, uniqueSorted } from "./primitives";
import {
  V9_SCORE_BEARING_GATES_POLICY_V923,
  parseV9ScoreBearingGatesPolicy,
  type V9ScoreBearingGatesPolicy,
} from "./score-bearing-gates-policy";

const V9_POLICY_DIGEST_DOMAIN = "safety-score-v9.methodology-policy.v1";

const validatedPolicyEnvelopes = new WeakSet<object>();

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function policyWithRegistryMatureChains(rawPolicy: unknown): unknown {
  if (!isUnknownRecord(rawPolicy)) return rawPolicy;
  const semantic = rawPolicy.semantic;
  if (!isUnknownRecord(semantic)) return rawPolicy;
  const materiality = semantic.materiality;
  if (!isUnknownRecord(materiality)) return rawPolicy;

  const authoredMatureChains = materiality.matureChains;
  if (authoredMatureChains !== undefined) {
    if (
      !Array.isArray(authoredMatureChains) ||
      !authoredMatureChains.every((value): value is string => typeof value === "string")
    ) {
      throw new Error("Safety Score v9 matureChains must be an array of reviewed chain slugs");
    }
    const authored = uniqueSorted(authoredMatureChains);
    const reviewed = uniqueSorted(CHAIN_MATURITY_ADMITTED_CHAIN_SLUGS);
    if (authored.length !== reviewed.length || authored.some((value, index) => value !== reviewed[index])) {
      throw new Error(
        "Safety Score v9 matureChains must derive from chain-maturity-reviews-v1.ts",
      );
    }
  }

  return {
    ...rawPolicy,
    semantic: {
      ...semantic,
      materiality: {
        ...materiality,
        matureChains: [...CHAIN_MATURITY_ADMITTED_CHAIN_SLUGS],
      },
    },
  };
}

function semanticPayload(policy: V9MethodologyPolicy): V9MethodologySemanticPayload {
  return {
    schemaVersion: policy.schemaVersion,
    semantic: {
      ...policy.semantic,
      formula: {
        ...policy.semantic.formula,
        assetPremiums: [...policy.semantic.formula.assetPremiums]
          .map((premium) => ({
            ...premium,
            requiredOperationalComponents: uniqueSorted(
              premium.requiredOperationalComponents,
            ),
          }))
          .sort(
            (left, right) =>
              compareText(left.assetId, right.assetId) ||
              compareText(left.kind, right.kind),
          ),
      },
      materiality: {
        ...policy.semantic.materiality,
        matureChains: uniqueSorted(policy.semantic.materiality.matureChains),
        matureVenues: uniqueSorted(policy.semantic.materiality.matureVenues),
      },
      backing: {
        ...policy.semantic.backing,
        reserve: {
          ...policy.semantic.backing.reserve,
          maturityNotApplicableClasses: uniqueSorted(policy.semantic.backing.reserve.maturityNotApplicableClasses),
        },
        archetypes: Object.fromEntries(
          Object.entries(policy.semantic.backing.archetypes).map(([archetype, rubric]) => [
            archetype,
            {
              ...rubric,
              serialComponentKeys: uniqueSorted(rubric.serialComponentKeys),
            },
          ]),
        ) as V9MethodologySemanticPayload["semantic"]["backing"]["archetypes"],
      },
      evidence: {
        ...policy.semantic.evidence,
        dispositions: [...policy.semantic.evidence.dispositions].sort((left, right) =>
          compareText(left.factClass, right.factClass),
        ),
      },
      exit: {
        ...policy.semantic.exit,
        scoreableEvidenceKinds: {
          dex: uniqueSorted(policy.semantic.exit.scoreableEvidenceKinds.dex),
          redemption: uniqueSorted(policy.semantic.exit.scoreableEvidenceKinds.redemption),
        },
        strongEvidenceKinds: uniqueSorted(policy.semantic.exit.strongEvidenceKinds),
      },
      accessPostureVocabulary: {
        transfer: uniqueSorted(policy.semantic.accessPostureVocabulary.transfer),
        freezeExposure: uniqueSorted(policy.semantic.accessPostureVocabulary.freezeExposure),
        primaryExit: uniqueSorted(policy.semantic.accessPostureVocabulary.primaryExit),
        governance: uniqueSorted(policy.semantic.accessPostureVocabulary.governance),
      },
    },
    reasonRegistry: [...policy.reasonRegistry]
      .map((entry) => ({
        ...entry,
        archetypes: uniqueSorted(entry.archetypes),
        pathKinds: uniqueSorted(entry.pathKinds),
        permittedTreatments: uniqueSorted(entry.permittedTreatments),
      }))
      .sort((left, right) => compareText(left.code, right.code)),
  } satisfies V9MethodologySemanticPayload;
}

function computeV9PolicySemanticDigest(
  policy: V9MethodologyPolicy,
  scoreBearingGates: V9ScoreBearingGatesPolicy,
): string {
  const { methodologyVersion: _methodologyVersion, ...gateSemantics } = scoreBearingGates;
  const canonicalGates = {
    ...gateSemantics,
    danger: {
      ...scoreBearingGates.danger,
      withholdCentralizedMintSeverities: uniqueSorted(
        scoreBearingGates.danger.withholdCentralizedMintSeverities,
      ),
      fGateCentralizedMintSeverities: uniqueSorted(
        scoreBearingGates.danger.fGateCentralizedMintSeverities,
      ),
      preExitCentralizedMintSeverities: uniqueSorted(
        scoreBearingGates.danger.preExitCentralizedMintSeverities,
      ),
      dangerOnlyGrades: uniqueSorted(scoreBearingGates.danger.dangerOnlyGrades),
    },
  };
  return sha256Hex(
    stableJsonStringifyV1({
      domain: V9_POLICY_DIGEST_DOMAIN,
      policy: semanticPayload(policy),
      scoreBearingGates: canonicalGates,
    }),
  );
}

export type V9ValidatedPolicyWithScoreBearingGates = V9ValidatedPolicyEnvelope & {
  readonly scoreBearingGates: V9ScoreBearingGatesPolicy;
};

/** Parse, cross-validate, digest, and freeze one explicit methodology policy. */
export function loadV9MethodologyPolicy(
  rawPolicy: unknown,
  rawScoreBearingGates: unknown = V9_SCORE_BEARING_GATES_POLICY_V923,
): V9ValidatedPolicyWithScoreBearingGates {
  const basePolicy = V9MethodologyPolicySchema.parse(policyWithRegistryMatureChains(rawPolicy));
  const scoreBearingGates = parseV9ScoreBearingGatesPolicy(rawScoreBearingGates);
  const policy = {
    ...basePolicy,
    releaseVersion: scoreBearingGates.methodologyVersion,
  } satisfies V9MethodologyPolicy;
  const envelope = {
    policy,
    scoreBearingGates,
    semanticDigest: computeV9PolicySemanticDigest(policy, scoreBearingGates),
  } satisfies V9ValidatedPolicyWithScoreBearingGates;
  const frozen = deepFreeze(envelope) as V9ValidatedPolicyWithScoreBearingGates;
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

export function getV9ScoreBearingGatesPolicy(
  envelope: V9ValidatedPolicyEnvelope,
): V9ScoreBearingGatesPolicy {
  assertV9ValidatedPolicyEnvelope(envelope);
  return (envelope as V9ValidatedPolicyWithScoreBearingGates).scoreBearingGates;
}

export function assertV9ReasonCodesRegistered(
  envelope: V9ValidatedPolicyEnvelope,
  emittedCodes: readonly string[],
): asserts emittedCodes is readonly V9ReasonCode[] {
  assertV9ValidatedPolicyEnvelope(envelope);
  const registered = new Set(envelope.policy.reasonRegistry.map((entry) => entry.code));
  const unknown = uniqueSorted(emittedCodes).filter(
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

export function assertV9UnresolvedFactsMatchPolicy(
  envelope: V9ValidatedPolicyEnvelope,
  facts: readonly V9UnresolvedFact[],
): void {
  assertV9ValidatedPolicyEnvelope(envelope);
  const mismatches = facts
    .filter((fact) => fact.critical !== resolveV9ReasonPolicy(envelope, fact.code).critical)
    .map((fact) => fact.code)
    .filter((code, index, codes) => codes.indexOf(code) === index)
    .sort(compareText);
  if (mismatches.length > 0) {
    throw new Error(`Safety Score v9 unresolved facts contradict policy treatment: ${mismatches.join(", ")}`);
  }
}

export const V9_CANDIDATE_POLICY_V1 = loadV9MethodologyPolicy(candidatePolicyAsset);
