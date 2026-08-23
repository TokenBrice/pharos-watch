import type { CompiledV9AssetInput } from "@shared/types/safety-score-v9";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import type {
  V9PillarEvaluation,
  V9ProductionScoreIdentity,
  V9ProductionScoreInput,
} from "../safety-score-v9/score";

const DIGEST = "a".repeat(64);
const BUILD_DIGEST = "b".repeat(64);
const BASE_ID = `report-cards-input:v1:${"c".repeat(64)}`;
const AS_OF = new Date(1_780_000_000 * 1_000).toISOString();

export function makeV9Pillar(
  score: number | null,
  overrides: Partial<V9PillarEvaluation> = {},
): V9PillarEvaluation {
  return { score, evidenceLevel: "strong", reasons: [], structuralSignals: [], ...overrides };
}

export function makeV9ProductionScoreInput(
  overrides: Partial<V9ProductionScoreInput> = {},
): V9ProductionScoreInput {
  const identity: V9ProductionScoreIdentity = {
    factSetDigest: DIGEST,
    baseInputGenerationId: BASE_ID,
    evaluationBuildDigest: BUILD_DIGEST,
    asOfSec: 1_000,
    sourceGenerations: {},
    ...overrides.identity,
  };
  return {
    assetId: "asset",
    pillars: { backing: makeV9Pillar(95), exit: makeV9Pillar(95), control: makeV9Pillar(95) },
    peg: { applicable: true, score: 100, activeDepegBps: null, reasons: [] },
    trackRecordMonths: 48,
    parent: { required: false, score: null, propagatedReasons: [] },
    dependencyReasons: [],
    dependencyStructuralSignals: [],
    ...overrides,
    identity,
  };
}

export interface CompiledV9AssetInputOptions {
  assetId: string;
  pillarScore: number;
  parent?: CompiledV9AssetInput["parent"];
  sourceKey: string;
}

export function makeCompiledV9AssetInput({
  assetId,
  pillarScore,
  parent = null,
  sourceKey,
}: CompiledV9AssetInputOptions): CompiledV9AssetInput {
  const pillar = {
    score: pillarScore,
    evidenceLevel: "strong" as const,
    evidence: [{ sourceId: `${sourceKey}:${assetId}`, observedAt: AS_OF }],
    unresolved: [],
    signals: [],
  };
  return {
    schemaVersion: 1,
    compilerPolicy: {
      policyId: V9_CANDIDATE_POLICY_V1.policy.policyId,
      semanticDigest: V9_CANDIDATE_POLICY_V1.semanticDigest,
    },
    assetId,
    asOf: AS_OF,
    compiledAt: AS_OF,
    archetype: "fiat-cash",
    pillars: { backing: pillar, exit: pillar, control: pillar },
    peg: { applicable: false, score: null, activeDepegBps: null, evidence: [], unresolved: [] },
    implementationLaunchDate: "2022-01-01",
    trackRecordMonths: 48,
    parent,
    structuralSignals: [],
    unresolved: [],
    sourceTimestamps: { [sourceKey]: AS_OF },
  };
}
