import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { GOLDEN_SCENARIOS, PAIRWISE_CONSTRAINTS } from "@shared/data/safety-score-v9/golden-scenarios-v1";
import {
  scoreV9GoldenScenario,
  type V9GoldenScenario,
  type V9ScenarioPairwiseConstraint,
  type V9ScenarioScoreTrace,
} from "@shared/lib/safety-score-v9/scenario-evaluator";
import { V9_CANDIDATE_POLICY_V1, loadV9MethodologyPolicy } from "@shared/lib/safety-score-v9-research";
import type { V9MethodologyPolicy, V9ValidatedPolicyEnvelope } from "@shared/types/safety-score-v9";
import { assertCliUsage, parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";

const USAGE = `Usage: npx tsx scripts/maintenance/run-safety-score-v9-policy-sensitivity.ts [options]

Candidate-only research tool. Each case changes one numeric semantic policy
parameter, validates the resulting policy, and scores the phase-zero golden corpus.

Options:
  --parameter <path>  Numeric semantic path to test (repeatable)
  --delta <number>    Signed perturbation applied to every selected path (repeatable)
  --output <path>     Write JSON to this path instead of stdout
  --list-parameters   List default-runnable isolated numeric paths and exit
  -h, --help          Show this help`;

const DEFAULT_PARAMETER_PATHS = [
  "semantic.evidence.ceilings.adequate",
  "semantic.evidence.ceilings.limited",
  // activeDepegCaps[0] and [1] limits sit at the top of their grade bands, so
  // any positive perturbation violates the band-coupling invariant (VER-005);
  // they are not default-runnable paths. Test them explicitly with a negative
  // --delta if needed.
  "semantic.formula.compensabilityHeadroom",
  "semantic.formula.pegExponent",
  "semantic.formula.trackRecordCeilings[0].limit",
  "semantic.formula.trackRecordCeilings[1].limit",
  "semantic.formula.trackRecordCeilings[2].limit",
] as const;

const MAX_ABSOLUTE_DELTA = 1_000_000_000;
const NUMERIC_PRECISION = 12;
const PAIRWISE_EPSILON = 1e-9;

interface BindingCapSummary {
  source: string;
  kind: string;
  limit: number;
}

interface CapCandidateSummary extends BindingCapSummary {
  reason: string;
}

interface ScenarioChange {
  scenarioId: string;
  preCapScore: { from: number | null; to: number | null; delta: number | null };
  finalScore: { from: number | null; to: number | null; delta: number | null };
  grade: { from: string; to: string; changed: boolean };
  bindingCap: { from: BindingCapSummary | null; to: BindingCapSummary | null; changed: boolean };
  capCandidates: { from: CapCandidateSummary[]; to: CapCandidateSummary[]; changed: boolean };
}

export interface PairwiseSensitivityEvaluation {
  constraintId: string;
  higherId: string;
  lowerId: string;
  minGap: number;
  rationale: string;
  actualGap: { from: number | null; to: number | null; delta: number | null };
  passed: { from: boolean; to: boolean; changed: boolean };
}

export interface V9PolicySensitivityCase {
  parameterPath: string;
  baselineValue: number;
  delta: number;
  value: number;
  policyDigest: string;
  affectedScenarioCount: number;
  affectedScenarioIds: string[];
  affectedArchetypes: string[];
  changes: ScenarioChange[];
  gradeCliffs: Array<{
    scenarioId: string;
    fromGrade: string;
    toGrade: string;
    fromScore: number | null;
    toScore: number | null;
  }>;
  bindingCapChanges: Array<{
    scenarioId: string;
    from: BindingCapSummary | null;
    to: BindingCapSummary | null;
  }>;
  capCandidateChanges: Array<{
    scenarioId: string;
    from: CapCandidateSummary[];
    to: CapCandidateSummary[];
  }>;
  pairwiseConstraints: PairwiseSensitivityEvaluation[];
  discontinuities: Array<{
    scenarioId: string;
    kinds: Array<"grade-cliff" | "binding-cap-transition" | "cap-candidate-transition">;
  }>;
  scoreSaturation: {
    maskedByBindingCapScenarioIds: string[];
    maskedByRoundingScenarioIds: string[];
    endpointScenarioIds: string[];
  };
}

export interface V9PolicySensitivityReport {
  schemaVersion: 1;
  reportKind: "safety-score-v9-policy-sensitivity-research";
  candidateOnly: true;
  baseline: {
    policyId: string;
    lifecycle: "candidate";
    semanticDigest: string;
    scenarioCount: number;
    scenarioIds: string[];
    pairwiseConstraintCount: number;
    pairwiseConstraintIds: string[];
    pairwiseViolationCount: number;
  };
  selection: {
    parameterPaths: string[];
    explicitDeltas: number[] | null;
  };
  cases: V9PolicySensitivityCase[];
  summary: {
    caseCount: number;
    affectedCaseCount: number;
    totalAffectedScenarioCases: number;
    gradeCliffCount: number;
    bindingCapChangeCount: number;
    capCandidateChangeCount: number;
    maskedByBindingCapCount: number;
    maskedByRoundingCount: number;
    endpointSaturationCount: number;
    pairwiseEvaluationCount: number;
    pairwiseViolationCount: number;
    newPairwiseViolationCount: number;
    pairwiseRecoveryCount: number;
    pairwiseStatusChangeCount: number;
    affectedPairwiseConstraintIds: string[];
    affectedArchetypes: string[];
  };
}

export interface GenerateSensitivityOptions {
  parameterPaths?: readonly string[];
  deltas?: readonly number[];
  scenarios?: readonly V9GoldenScenario[];
  constraints?: readonly V9ScenarioPairwiseConstraint[];
}

export interface V9PolicySensitivityCliOptions {
  help: boolean;
  listParameters: boolean;
  outputPath: string | null;
  parameterPaths: string[] | undefined;
  deltas: number[] | undefined;
}

interface CliIo {
  stdout(text: string): void;
  writeOutput(path: string, text: string): void;
}

function normalizedNumber(value: number): number {
  return Number(value.toFixed(NUMERIC_PRECISION));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function sortedUniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values.map(normalizedNumber))].sort((left, right) => left - right);
}

function collectNumericPaths(value: unknown, prefix: string, paths: string[]): void {
  if (typeof value === "number") {
    paths.push(prefix);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectNumericPaths(child, `${prefix}[${index}]`, paths));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const key of Object.keys(value).sort(compareStrings)) {
    collectNumericPaths((value as Record<string, unknown>)[key], `${prefix}.${key}`, paths);
  }
}

function numericPolicyPaths(policy: V9ValidatedPolicyEnvelope = V9_CANDIDATE_POLICY_V1): string[] {
  const paths: string[] = [];
  collectNumericPaths(policy.policy.semantic, "semantic", paths);
  return paths.sort(compareStrings);
}

function supportsDefaultIsolatedPerturbations(policy: V9ValidatedPolicyEnvelope, path: string): boolean {
  const baselineValue = numericValueAtPath(policy.policy, path);
  return defaultDeltasFor(baselineValue).every((delta) => {
    const value = normalizedNumber(baselineValue + delta);
    if (value === baselineValue) return false;
    try {
      mutateNumericPolicyParameter(policy, path, value);
      return true;
    } catch {
      return false;
    }
  });
}

export function listV9PolicySensitivityNumericPaths(
  policy: V9ValidatedPolicyEnvelope = V9_CANDIDATE_POLICY_V1,
): string[] {
  return numericPolicyPaths(policy).filter((path) => supportsDefaultIsolatedPerturbations(policy, path));
}

function pathSegments(path: string): string[] {
  return path.replaceAll(/\[(\d+)\]/g, ".$1").split(".");
}

function numericValueAtPath(policy: V9MethodologyPolicy, path: string): number {
  let current: unknown = policy;
  for (const segment of pathSegments(path)) {
    if (current === null || typeof current !== "object") throw new Error(`Invalid policy parameter path: ${path}`);
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current !== "number") throw new Error(`Policy parameter is not numeric: ${path}`);
  return current;
}

function mutateNumericPolicyParameter(
  baseline: V9ValidatedPolicyEnvelope,
  path: string,
  value: number,
): V9ValidatedPolicyEnvelope {
  const policy = structuredClone(baseline.policy) as V9MethodologyPolicy;
  const segments = pathSegments(path);
  let current: Record<string, unknown> = policy as unknown as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (child === null || typeof child !== "object") throw new Error(`Invalid policy parameter path: ${path}`);
    current = child as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
  return loadV9MethodologyPolicy(policy);
}

function defaultDeltasFor(value: number): number[] {
  return Number.isInteger(value) ? [-1, 1] : Math.abs(value) <= 1 ? [-0.05, 0.05] : [-1, 1];
}

function capSummary(trace: V9ScenarioScoreTrace): BindingCapSummary | null {
  return trace.bindingCap
    ? {
        source: trace.bindingCap.source,
        kind: trace.bindingCap.kind,
        limit: trace.bindingCap.limit,
      }
    : null;
}

function capCandidateSummaries(trace: V9ScenarioScoreTrace): CapCandidateSummary[] {
  return trace.caps
    .map((cap) => ({ source: cap.source, kind: cap.kind, limit: cap.limit, reason: cap.reason }))
    .sort(
      (left, right) =>
        compareStrings(left.source, right.source) ||
        compareStrings(left.kind, right.kind) ||
        left.limit - right.limit ||
        compareStrings(left.reason, right.reason),
    );
}

function nullableDelta(from: number | null, to: number | null): number | null {
  return from === null || to === null ? null : normalizedNumber(to - from);
}

function equalCaps(left: BindingCapSummary | null, right: BindingCapSummary | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.source === right.source &&
      left.kind === right.kind &&
      left.limit === right.limit)
  );
}

function equalCapCandidates(left: readonly CapCandidateSummary[], right: readonly CapCandidateSummary[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function scenarioChange(
  scenarioId: string,
  baseline: V9ScenarioScoreTrace,
  perturbed: V9ScenarioScoreTrace,
): ScenarioChange {
  const fromCap = capSummary(baseline);
  const toCap = capSummary(perturbed);
  const fromCapCandidates = capCandidateSummaries(baseline);
  const toCapCandidates = capCandidateSummaries(perturbed);
  return {
    scenarioId,
    preCapScore: {
      from: baseline.preCapScore,
      to: perturbed.preCapScore,
      delta: nullableDelta(baseline.preCapScore, perturbed.preCapScore),
    },
    finalScore: {
      from: baseline.finalScore,
      to: perturbed.finalScore,
      delta: nullableDelta(baseline.finalScore, perturbed.finalScore),
    },
    grade: {
      from: baseline.finalGrade,
      to: perturbed.finalGrade,
      changed: baseline.finalGrade !== perturbed.finalGrade,
    },
    bindingCap: {
      from: fromCap,
      to: toCap,
      changed: !equalCaps(fromCap, toCap),
    },
    capCandidates: {
      from: fromCapCandidates,
      to: toCapCandidates,
      changed: !equalCapCandidates(fromCapCandidates, toCapCandidates),
    },
  };
}

function changeIsAffected(change: ScenarioChange): boolean {
  return (
    change.preCapScore.from !== change.preCapScore.to ||
    change.finalScore.from !== change.finalScore.to ||
    change.grade.changed ||
    change.bindingCap.changed ||
    change.capCandidates.changed
  );
}

function scoreScenarioSet(
  scenarios: readonly V9GoldenScenario[],
  policy: V9ValidatedPolicyEnvelope,
): Map<string, V9ScenarioScoreTrace> {
  const traces = new Map<string, V9ScenarioScoreTrace>();
  for (const scenario of [...scenarios].sort((left, right) => compareStrings(left.id, right.id))) {
    if (traces.has(scenario.id)) throw new Error(`Duplicate golden scenario ID: ${scenario.id}`);
    traces.set(scenario.id, scoreV9GoldenScenario(scenario, policy));
  }
  return traces;
}

interface PairwiseSnapshot {
  constraintId: string;
  higherId: string;
  lowerId: string;
  minGap: number;
  rationale: string;
  actualGap: number | null;
  passed: boolean;
}

function pairwiseConstraintId(constraint: V9ScenarioPairwiseConstraint): string {
  return `${constraint.higherId}>${constraint.lowerId}`;
}

function evaluatePairwiseConstraints(
  constraints: readonly V9ScenarioPairwiseConstraint[],
  traces: ReadonlyMap<string, V9ScenarioScoreTrace>,
): Map<string, PairwiseSnapshot> {
  const evaluations = new Map<string, PairwiseSnapshot>();
  for (const constraint of [...constraints].sort((left, right) =>
    compareStrings(pairwiseConstraintId(left), pairwiseConstraintId(right)),
  )) {
    const constraintId = pairwiseConstraintId(constraint);
    assertCliUsage(!evaluations.has(constraintId), `Duplicate pairwise constraint: ${constraintId}`);
    assertCliUsage(
      Number.isFinite(constraint.minGap) && constraint.minGap >= 0,
      `Pairwise constraint ${constraintId} requires a non-negative finite minGap`,
    );
    const higher = traces.get(constraint.higherId);
    const lower = traces.get(constraint.lowerId);
    assertCliUsage(higher !== undefined, `Pairwise constraint ${constraintId} has unknown higher scenario`);
    assertCliUsage(lower !== undefined, `Pairwise constraint ${constraintId} has unknown lower scenario`);
    const actualGap =
      higher.finalScore === null || lower.finalScore === null
        ? null
        : normalizedNumber(higher.finalScore - lower.finalScore);
    evaluations.set(constraintId, {
      constraintId,
      higherId: constraint.higherId,
      lowerId: constraint.lowerId,
      minGap: constraint.minGap,
      rationale: constraint.rationale,
      actualGap,
      passed: actualGap !== null && actualGap >= constraint.minGap - PAIRWISE_EPSILON,
    });
  }
  return evaluations;
}

function buildSensitivityCase(args: {
  parameterPath: string;
  baselineValue: number;
  delta: number;
  policy: V9ValidatedPolicyEnvelope;
  baselineTraces: ReadonlyMap<string, V9ScenarioScoreTrace>;
  baselinePairwise: ReadonlyMap<string, PairwiseSnapshot>;
  scenarios: readonly V9GoldenScenario[];
  constraints: readonly V9ScenarioPairwiseConstraint[];
}): V9PolicySensitivityCase {
  const perturbedTraces = scoreScenarioSet(args.scenarios, args.policy);
  const perturbedPairwise = evaluatePairwiseConstraints(args.constraints, perturbedTraces);
  const allChanges = [...args.baselineTraces.keys()]
    .sort()
    .map((scenarioId) =>
      scenarioChange(scenarioId, args.baselineTraces.get(scenarioId)!, perturbedTraces.get(scenarioId)!),
    );
  const changes = allChanges.filter(changeIsAffected);
  const gradeCliffs = changes
    .filter((change) => change.grade.changed)
    .map((change) => ({
      scenarioId: change.scenarioId,
      fromGrade: change.grade.from,
      toGrade: change.grade.to,
      fromScore: change.finalScore.from,
      toScore: change.finalScore.to,
    }));
  const bindingCapChanges = changes
    .filter((change) => change.bindingCap.changed)
    .map((change) => ({
      scenarioId: change.scenarioId,
      from: change.bindingCap.from,
      to: change.bindingCap.to,
    }));
  const capCandidateChanges = changes
    .filter((change) => change.capCandidates.changed)
    .map((change) => ({
      scenarioId: change.scenarioId,
      from: change.capCandidates.from,
      to: change.capCandidates.to,
    }));
  const discontinuities = changes.flatMap((change) => {
    const kinds: Array<"grade-cliff" | "binding-cap-transition" | "cap-candidate-transition"> = [];
    if (change.grade.changed) kinds.push("grade-cliff");
    if (change.bindingCap.changed) kinds.push("binding-cap-transition");
    if (change.capCandidates.changed) kinds.push("cap-candidate-transition");
    return kinds.length > 0 ? [{ scenarioId: change.scenarioId, kinds }] : [];
  });
  const maskedByBindingCapScenarioIds = allChanges
    .filter(
      (change) =>
        (change.preCapScore.from !== change.preCapScore.to || change.capCandidates.changed) &&
        change.finalScore.from === change.finalScore.to &&
        (change.bindingCap.from !== null || change.bindingCap.to !== null),
    )
    .map((change) => change.scenarioId);
  const maskedByRoundingScenarioIds = allChanges
    .filter(
      (change) =>
        change.preCapScore.from !== change.preCapScore.to &&
        change.finalScore.from === change.finalScore.to &&
        change.bindingCap.to === null,
    )
    .map((change) => change.scenarioId);
  const endpointScenarioIds = [...perturbedTraces.entries()]
    .filter(([, trace]) => trace.finalScore === 0 || trace.finalScore === 100)
    .map(([scenarioId]) => scenarioId)
    .sort();
  const pairwiseConstraints = [...args.baselinePairwise.values()].map((baseline) => {
    const perturbed = perturbedPairwise.get(baseline.constraintId);
    if (!perturbed) throw new Error(`Missing perturbed pairwise constraint ${baseline.constraintId}`);
    return {
      constraintId: baseline.constraintId,
      higherId: baseline.higherId,
      lowerId: baseline.lowerId,
      minGap: baseline.minGap,
      rationale: baseline.rationale,
      actualGap: {
        from: baseline.actualGap,
        to: perturbed.actualGap,
        delta: nullableDelta(baseline.actualGap, perturbed.actualGap),
      },
      passed: {
        from: baseline.passed,
        to: perturbed.passed,
        changed: baseline.passed !== perturbed.passed,
      },
    };
  });

  return {
    parameterPath: args.parameterPath,
    baselineValue: args.baselineValue,
    delta: args.delta,
    value: normalizedNumber(args.baselineValue + args.delta),
    policyDigest: args.policy.semanticDigest,
    affectedScenarioCount: changes.length,
    affectedScenarioIds: changes.map((change) => change.scenarioId),
    affectedArchetypes: sortedUniqueStrings(
      args.scenarios
        .filter((scenario) => changes.some((change) => change.scenarioId === scenario.id))
        .map((scenario) => scenario.archetype),
    ),
    changes,
    gradeCliffs,
    bindingCapChanges,
    capCandidateChanges,
    pairwiseConstraints,
    discontinuities,
    scoreSaturation: {
      maskedByBindingCapScenarioIds,
      maskedByRoundingScenarioIds,
      endpointScenarioIds,
    },
  };
}

export function generateV9PolicySensitivityReport(options: GenerateSensitivityOptions = {}): V9PolicySensitivityReport {
  const baselinePolicy = V9_CANDIDATE_POLICY_V1;
  if (baselinePolicy.policy.lifecycle !== "candidate" || baselinePolicy.policy.releaseVersion !== null) {
    throw new Error("Safety Score v9 sensitivity tooling only accepts an unreleased candidate policy");
  }

  const numericPaths = new Set(numericPolicyPaths(baselinePolicy));
  const parameterPaths = sortedUniqueStrings(options.parameterPaths ?? DEFAULT_PARAMETER_PATHS);
  assertCliUsage(parameterPaths.length > 0, "At least one --parameter is required");
  for (const path of parameterPaths) {
    assertCliUsage(numericPaths.has(path), `Unknown or non-numeric policy parameter: ${path}`);
  }

  const explicitDeltas = options.deltas ? validateDeltas(options.deltas) : null;
  const scenarios = options.scenarios ?? GOLDEN_SCENARIOS;
  assertCliUsage(scenarios.length > 0, "At least one golden scenario is required");
  const constraints = options.constraints ?? PAIRWISE_CONSTRAINTS;
  assertCliUsage(constraints.length > 0, "At least one pairwise constraint is required");
  const baselineTraces = scoreScenarioSet(scenarios, baselinePolicy);
  const baselinePairwise = evaluatePairwiseConstraints(constraints, baselineTraces);
  const cases: V9PolicySensitivityCase[] = [];

  for (const parameterPath of parameterPaths) {
    const baselineValue = numericValueAtPath(baselinePolicy.policy, parameterPath);
    const deltas = explicitDeltas ?? defaultDeltasFor(baselineValue);
    for (const delta of deltas) {
      const value = normalizedNumber(baselineValue + delta);
      assertCliUsage(value !== baselineValue, `Delta ${delta} does not change ${parameterPath}`);
      let perturbedPolicy: V9ValidatedPolicyEnvelope;
      try {
        perturbedPolicy = mutateNumericPolicyParameter(baselinePolicy, parameterPath, value);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid sensitivity case ${parameterPath} ${delta >= 0 ? "+" : ""}${delta}: ${message}`);
      }
      cases.push(
        buildSensitivityCase({
          parameterPath,
          baselineValue,
          delta,
          policy: perturbedPolicy,
          baselineTraces,
          baselinePairwise,
          scenarios,
          constraints,
        }),
      );
    }
  }

  const scenarioIds = [...baselineTraces.keys()].sort();
  const pairwiseConstraintIds = [...baselinePairwise.keys()];
  const pairwiseEvaluations = cases.flatMap((item) => item.pairwiseConstraints);
  return {
    schemaVersion: 1,
    reportKind: "safety-score-v9-policy-sensitivity-research",
    candidateOnly: true,
    baseline: {
      policyId: baselinePolicy.policy.policyId,
      lifecycle: "candidate",
      semanticDigest: baselinePolicy.semanticDigest,
      scenarioCount: scenarioIds.length,
      scenarioIds,
      pairwiseConstraintCount: pairwiseConstraintIds.length,
      pairwiseConstraintIds,
      pairwiseViolationCount: [...baselinePairwise.values()].filter((item) => !item.passed).length,
    },
    selection: { parameterPaths, explicitDeltas },
    cases,
    summary: {
      caseCount: cases.length,
      affectedCaseCount: cases.filter((item) => item.affectedScenarioCount > 0).length,
      totalAffectedScenarioCases: cases.reduce((sum, item) => sum + item.affectedScenarioCount, 0),
      gradeCliffCount: cases.reduce((sum, item) => sum + item.gradeCliffs.length, 0),
      bindingCapChangeCount: cases.reduce((sum, item) => sum + item.bindingCapChanges.length, 0),
      capCandidateChangeCount: cases.reduce((sum, item) => sum + item.capCandidateChanges.length, 0),
      maskedByBindingCapCount: cases.reduce(
        (sum, item) => sum + item.scoreSaturation.maskedByBindingCapScenarioIds.length,
        0,
      ),
      maskedByRoundingCount: cases.reduce(
        (sum, item) => sum + item.scoreSaturation.maskedByRoundingScenarioIds.length,
        0,
      ),
      endpointSaturationCount: cases.reduce((sum, item) => sum + item.scoreSaturation.endpointScenarioIds.length, 0),
      pairwiseEvaluationCount: pairwiseEvaluations.length,
      pairwiseViolationCount: pairwiseEvaluations.filter((item) => !item.passed.to).length,
      newPairwiseViolationCount: pairwiseEvaluations.filter((item) => item.passed.from && !item.passed.to).length,
      pairwiseRecoveryCount: pairwiseEvaluations.filter((item) => !item.passed.from && item.passed.to).length,
      pairwiseStatusChangeCount: pairwiseEvaluations.filter((item) => item.passed.changed).length,
      affectedPairwiseConstraintIds: sortedUniqueStrings(
        pairwiseEvaluations.filter((item) => item.passed.changed).map((item) => item.constraintId),
      ),
      affectedArchetypes: sortedUniqueStrings(cases.flatMap((item) => item.affectedArchetypes)),
    },
  };
}

function parseDelta(raw: string): number {
  const normalized = raw.trim();
  assertCliUsage(normalized.length > 0, "--delta requires a number");
  const value = Number(normalized);
  assertCliUsage(Number.isFinite(value), `--delta must be finite, received ${raw}`);
  assertCliUsage(value !== 0, "--delta must not be zero");
  assertCliUsage(Math.abs(value) <= MAX_ABSOLUTE_DELTA, `--delta must be within +/-${MAX_ABSOLUTE_DELTA}`);
  return normalizedNumber(value);
}

function validateDeltas(values: readonly number[]): number[] {
  assertCliUsage(values.length > 0, "At least one --delta is required when deltas are provided");
  return sortedUniqueNumbers(values.map((value) => parseDelta(String(value))));
}

function cliStringList(value: unknown, name: string): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  assertCliUsage(
    value.every((item) => typeof item === "string"),
    `${name} values must be strings`,
  );
  return value as string[];
}

export function parseV9PolicySensitivityArgs(argv: readonly string[]): V9PolicySensitivityCliOptions {
  const { values } = parseStrictCliArgs(argv, {
    allowNegativeValues: ["delta"],
    options: {
      parameter: { type: "string", multiple: true },
      delta: { type: "string", multiple: true },
      output: { type: "string" },
      "list-parameters": { type: "boolean" },
    },
  });
  const listParameters = values["list-parameters"] === true;
  const rawParameters = cliStringList(values.parameter, "--parameter");
  const rawDeltas = cliStringList(values.delta, "--delta");
  const parameterPaths = rawParameters ? sortedUniqueStrings(rawParameters) : undefined;
  const deltas = rawDeltas ? validateDeltas(rawDeltas.map(parseDelta)) : undefined;
  const outputPath = typeof values.output === "string" ? values.output : null;
  if (listParameters) {
    assertCliUsage(
      !parameterPaths && !deltas && outputPath === null,
      "--list-parameters cannot be combined with other options",
    );
  }
  return {
    help: values.help === true,
    listParameters,
    outputPath,
    parameterPaths,
    deltas,
  };
}

export function runV9PolicySensitivityCli(
  argv: readonly string[],
  io: CliIo = {
    stdout: (text) => process.stdout.write(text),
    writeOutput: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, "utf8");
    },
  },
): void {
  const options = parseV9PolicySensitivityArgs(argv);
  if (options.help) {
    writeCliHelpIfRequested({ help: true }, USAGE, { write: io.stdout });
    return;
  }
  if (options.listParameters) {
    io.stdout(`${JSON.stringify(listV9PolicySensitivityNumericPaths(), null, 2)}\n`);
    return;
  }
  const report = generateV9PolicySensitivityReport({
    parameterPaths: options.parameterPaths,
    deltas: options.deltas,
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath) io.writeOutput(options.outputPath, json);
  else io.stdout(json);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCliEntrypoint(() => runV9PolicySensitivityCli(process.argv.slice(2)), {
    label: "safety-score-v9:policy-sensitivity",
    usage: USAGE,
  });
}
