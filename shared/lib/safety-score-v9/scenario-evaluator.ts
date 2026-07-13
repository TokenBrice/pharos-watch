/**
 * Expectation-free adapter for the durable Safety Score v9 golden corpus.
 * Scenario-authored caps remain isolated from production-shaped inputs.
 */

import {
  scoreV9ResearchScenarioInput,
  type V9CapTrace,
  type V9NRReason,
  type V9ScoreTrace,
} from "../safety-score-v9-research";
import type { V9EvidenceLevel, V9Grade, V9QualityPillar, V9ValidatedPolicyEnvelope } from "../../types/safety-score-v9";

export const V9_SCENARIO_QUALITY_PILLARS = ["backing", "exit", "control"] as const satisfies readonly V9QualityPillar[];

export interface V9ScenarioStructuralCap {
  readonly kind: string;
  readonly limit: number;
  readonly reason: string;
}

/** Informational research context that never resolves to a numeric cap. */
export interface V9ScenarioStructuralSignal {
  readonly kind: string;
  readonly reason: string;
}

export interface V9ScenarioExpectation {
  readonly allowedGrades: readonly V9Grade[];
  readonly minScore?: number;
  readonly maxScore?: number;
  readonly expectedBindingCapKind?: string | null;
  readonly expectedRated: boolean;
}

export interface V9GoldenScenario {
  readonly id: string;
  readonly name: string;
  readonly archetype: string;
  readonly description: string;
  readonly pillars: Readonly<Record<V9QualityPillar, number | null>>;
  readonly pegScore: number | null;
  readonly pegApplicable: boolean;
  readonly evidenceLevel: V9EvidenceLevel;
  readonly trackRecordMonths: number;
  readonly structuralCaps: readonly V9ScenarioStructuralCap[];
  readonly structuralSignals?: readonly V9ScenarioStructuralSignal[];
  readonly activeDepegBps?: number | null;
  readonly parentApplicable?: boolean;
  readonly parentScore?: number | null;
  readonly expected: V9ScenarioExpectation;
}

export interface V9ScenarioPairwiseConstraint {
  readonly higherId: string;
  readonly lowerId: string;
  readonly minGap: number;
  readonly rationale: string;
}

export interface V9ScenarioScoreTrace {
  readonly scenarioId: string;
  readonly policyId: string;
  readonly policyDigest: string;
  readonly configName: string;
  readonly pillarContributions: V9ScoreTrace["pillarContributions"];
  readonly weightedQuality: number | null;
  readonly weakestPillar: V9ScoreTrace["weakestPillar"];
  readonly pegMultiplier: number | null;
  readonly preCapScore: number | null;
  readonly caps: readonly V9CapTrace[];
  readonly bindingCap: V9CapTrace | null;
  readonly structuralSignals: readonly V9ScenarioStructuralSignal[];
  readonly finalScore: number | null;
  readonly finalGrade: V9Grade;
  readonly nrReasons: readonly V9NRReason[];
}

export function scoreV9GoldenScenario(
  scenario: V9GoldenScenario,
  policy: V9ValidatedPolicyEnvelope,
): V9ScenarioScoreTrace {
  const trace = scoreV9ResearchScenarioInput(
    {
      assetId: scenario.id,
      pillars: scenario.pillars,
      pegScore: scenario.pegScore,
      pegApplicable: scenario.pegApplicable,
      evidenceLevel: scenario.evidenceLevel,
      trackRecordMonths: scenario.trackRecordMonths,
      activeDepegBps: scenario.activeDepegBps ?? null,
      parentRequired: scenario.parentApplicable ?? false,
      parentScore: scenario.parentScore ?? null,
      structuralSignals: [],
      unresolved: [],
    },
    policy,
    scenario.structuralCaps,
  );
  return {
    scenarioId: scenario.id,
    policyId: trace.policyId,
    policyDigest: trace.policyDigest,
    configName: trace.configName,
    pillarContributions: trace.pillarContributions,
    weightedQuality: trace.weightedQuality,
    weakestPillar: trace.weakestPillar,
    pegMultiplier: trace.pegMultiplier,
    preCapScore: trace.preCapScore,
    caps: trace.caps,
    bindingCap: trace.bindingCap,
    structuralSignals: scenario.structuralSignals ?? [],
    finalScore: trace.finalScore,
    finalGrade: trace.finalGrade,
    nrReasons: trace.nrReasons,
  };
}
