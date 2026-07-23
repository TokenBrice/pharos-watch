import {
  CompiledV9AssetInputSchema,
  V9ScoringInputSchema,
  type CompiledV9AssetInput,
  type V9EvidenceLevel,
  type V9QualityPillar,
  type V9ScoringInput,
  type V9UnresolvedFact,
  type V9ValidatedPolicyEnvelope,
} from "../types/safety-score-v9";
import {
  scoreV9Input,
  scoreV9InputWithScenarioCaps,
  type V9AttributedScenarioCap,
  type V9ScoreTrace,
  type V9StructuralCap,
} from "./safety-score-v9/formula";
import { assertV9ValidatedPolicyEnvelope } from "./safety-score-v9/policy";

export {
  V9_CANDIDATE_POLICY_V1,
  loadV9MethodologyPolicy,
} from "./safety-score-v9/policy";
export {
  deriveV9ReserveLossSignal,
  resolveV9StructuralCaps,
  scoreV9Input,
  type V9CapTrace,
  type V9NRReason,
  type V9ScoreTrace,
} from "./safety-score-v9/formula";

export interface V9ResearchScenarioCap extends V9StructuralCap {
  pricedInPillar?: V9QualityPillar;
}

const V9_QUALITY_PILLARS = ["backing", "exit", "control"] as const satisfies readonly V9QualityPillar[];

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Phase-zero scenario adapter; arbitrary caps are never accepted by production scoring input. */
export function scoreV9ResearchScenarioInput(
  rawInput: V9ScoringInput,
  policy: V9ValidatedPolicyEnvelope,
  scenarioCaps: readonly V9ResearchScenarioCap[],
): V9ScoreTrace {
  const attributedCaps: V9AttributedScenarioCap[] = scenarioCaps.map((cap) => ({
    ...cap,
    responsibility: "measured-adverse",
  }));
  return scoreV9InputWithScenarioCaps(rawInput, policy, attributedCaps);
}

function weakestEvidenceLevel(input: CompiledV9AssetInput, policy: V9ValidatedPolicyEnvelope): V9EvidenceLevel {
  const rank = policy.policy.semantic.evidence.rank;
  return V9_QUALITY_PILLARS.map((pillar) => input.pillars[pillar].evidenceLevel).sort(
    (left, right) => rank[right] - rank[left],
  )[0]!;
}

function scoringInputFromCompiled(
  input: CompiledV9AssetInput,
  parentScore: number | null,
  policy: V9ValidatedPolicyEnvelope,
): V9ScoringInput {
  const unresolved: V9UnresolvedFact[] = [
    ...input.unresolved,
    ...input.peg.unresolved,
    ...V9_QUALITY_PILLARS.flatMap((pillar) => input.pillars[pillar].unresolved),
  ];
  return V9ScoringInputSchema.parse({
    assetId: input.assetId,
    pillars: {
      backing: input.pillars.backing.score,
      exit: input.pillars.exit.score,
      control: input.pillars.control.score,
    },
    pegScore: input.peg.score,
    pegApplicable: input.peg.applicable,
    evidenceLevel: weakestEvidenceLevel(input, policy),
    trackRecordMonths: input.trackRecordMonths,
    activeDepegBps: input.peg.activeDepegBps,
    parentRequired: input.parent?.required ?? false,
    parentScore,
    structuralSignals: input.structuralSignals,
    unresolved,
  });
}

/** Score one compiled asset. Numeric ceilings are resolved here, never stored in metadata. */
export function scoreCompiledAsset(
  rawInput: CompiledV9AssetInput,
  policy: V9ValidatedPolicyEnvelope,
  parentTrace: V9ScoreTrace | null = null,
): V9ScoreTrace {
  assertV9ValidatedPolicyEnvelope(policy);
  const input = CompiledV9AssetInputSchema.parse(rawInput);
  if (input.compilerPolicy.semanticDigest !== policy.semanticDigest) {
    throw new Error(
      `Compiled Safety Score v9 input ${input.assetId} was produced by ${input.compilerPolicy.policyId}/${input.compilerPolicy.semanticDigest}, not ${policy.policy.policyId}/${policy.semanticDigest}`,
    );
  }
  if (parentTrace && parentTrace.assetId !== input.parent?.assetId) {
    throw new Error(
      `Compiled Safety Score v9 input ${input.assetId} expects parent ${input.parent?.assetId ?? "none"}, not ${parentTrace.assetId}`,
    );
  }
  return scoreV9Input(
    scoringInputFromCompiled(input, parentTrace?.finalScore ?? null, policy),
    policy,
    parentTrace?.nrReasons ?? [],
  );
}

export interface V9CompiledAssetSetResult {
  traces: readonly V9ScoreTrace[];
  evaluatedOrder: readonly string[];
}

/** Deterministic parent-first evaluation with explicit cycle and missing-parent NR traces. */
export function scoreCompiledAssetSet(
  rawInputs: readonly CompiledV9AssetInput[],
  policy: V9ValidatedPolicyEnvelope,
): V9CompiledAssetSetResult {
  assertV9ValidatedPolicyEnvelope(policy);
  const inputs = rawInputs.map((input) => CompiledV9AssetInputSchema.parse(input));
  const byId = new Map<string, CompiledV9AssetInput>();
  for (const input of inputs) {
    if (byId.has(input.assetId)) throw new Error(`Duplicate compiled v9 asset ID: ${input.assetId}`);
    byId.set(input.assetId, input);
  }

  const traces = new Map<string, V9ScoreTrace>();
  const visiting = new Set<string>();
  const visitStack: string[] = [];
  const evaluatedOrder: string[] = [];

  const visit = (assetId: string): V9ScoreTrace => {
    const cached = traces.get(assetId);
    if (cached) return cached;
    const input = byId.get(assetId);
    if (!input) throw new Error(`Unknown compiled v9 asset: ${assetId}`);

    if (visiting.has(assetId)) {
      const cycleStart = visitStack.indexOf(assetId);
      const cycleIds = visitStack.slice(cycleStart).sort(compareCodeUnits);
      const cycleLabel = cycleIds.join(", ");
      for (const cycleId of cycleIds) {
        if (traces.has(cycleId)) continue;
        const cycleInput = byId.get(cycleId)!;
        const trace = scoreCompiledAsset(cycleInput, policy);
        traces.set(cycleId, {
          ...trace,
          caps: trace.caps.map((cap) => ({ ...cap, binding: false })),
          bindingCap: null,
          finalScore: null,
          finalGrade: "NR",
          nrReasons: [
            ...trace.nrReasons.filter((reason) => reason.code !== "missing-parent-score"),
            { code: "parent-cycle", field: "parent.assetId", message: `Parent cycle includes ${cycleLabel}.` },
          ],
          propagatedParentReasons: [],
        });
        evaluatedOrder.push(cycleId);
      }
      return traces.get(assetId)!;
    }

    visiting.add(assetId);
    visitStack.push(assetId);
    const parentTrace = input.parent && byId.has(input.parent.assetId) ? visit(input.parent.assetId) : null;
    visitStack.pop();
    visiting.delete(assetId);
    if (traces.has(assetId)) return traces.get(assetId)!;
    const trace = scoreCompiledAsset(input, policy, parentTrace);
    traces.set(assetId, trace);
    evaluatedOrder.push(assetId);
    return trace;
  };

  for (const assetId of [...byId.keys()].sort()) visit(assetId);
  return {
    traces: [...traces.values()].sort((left, right) => compareCodeUnits(left.assetId, right.assetId)),
    evaluatedOrder,
  };
}
