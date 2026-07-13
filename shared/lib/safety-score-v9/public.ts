import {
  SafetyScoreV9ResponseSchema,
  type SafetyScoreV9EvidenceFreshness,
  type SafetyScoreV9NrReason,
  type SafetyScoreV9PublicReason,
  type SafetyScoreV9Response,
  type SafetyScoreV9Card,
} from "../../types/safety-score-v9-public";
import type { V9EvidenceLevel, V9QualityPillar, V9ReasonCode } from "../../types/safety-score-v9";
import type { V9AccessPostureResult } from "./access-posture";
import type { V9BackingResult } from "./backing";
import type { V9EconomicControlResult } from "./control";
import type { V9ResolvedDependencyInputs } from "./dependencies";
import type { V9ExitEvaluationResult } from "./exit";
import type { V9PillarReason, V9ProductionScoreInput, V9ProductionScoreTrace } from "./score";
import type { V9PublicStressState } from "./stress";
import { computeV9ResultDigest } from "./trace";

type V9PublicAccessProjectionInput = V9AccessPostureResult & {
  reasons?: readonly V9PillarReason[];
};

export interface V9PublicCardProjectionInput {
  trace: V9ProductionScoreTrace;
  scoreInput: Pick<V9ProductionScoreInput, "pillars" | "peg" | "dependencyReasons" | "methodologyReasons">;
  access: V9PublicAccessProjectionInput;
  dependencyInputs: V9ResolvedDependencyInputs;
  stressState: Pick<V9PublicStressState, "stateDigest"> | null;
  backing?: Pick<V9BackingResult, "contributions">;
  exit?: Pick<V9ExitEvaluationResult, "routes">;
  control?: Pick<V9EconomicControlResult, "components">;
  freshness?: Partial<Record<V9QualityPillar, SafetyScoreV9EvidenceFreshness>>;
  evidenceReasons?: readonly V9PillarReason[];
  reasonCodes?: readonly V9ReasonCode[];
}

export interface BuildSafetyScoreV9ResponseArgs {
  candidateId: string;
  policyVersion: `candidate-${string}`;
  publicationGenerationId: string;
  publicationEpoch: number;
  publishedAtSec: number;
  results: readonly V9PublicCardProjectionInput[];
}

const PILLARS = ["backing", "exit", "control"] as const satisfies readonly V9QualityPillar[];
const EVIDENCE_RANK: Readonly<Record<V9EvidenceLevel, number>> = {
  strong: 0,
  adequate: 1,
  limited: 2,
  insufficient: 3,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareText);
}

function publicReason(reason: V9PillarReason): SafetyScoreV9PublicReason {
  return { code: reason.code, message: reason.message, path: reason.path || null };
}

function canonicalPublicReasons(reasons: readonly V9PillarReason[]): SafetyScoreV9PublicReason[] {
  return [
    ...new Map(
      reasons.map((reason) => [`${reason.code}\u0000${reason.path}\u0000${reason.message}`, publicReason(reason)]),
    ).values(),
  ].sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.path ?? "", right.path ?? "") ||
      compareText(left.message, right.message),
  );
}

function canonicalNrReasons(trace: V9ProductionScoreTrace): SafetyScoreV9NrReason[] {
  const reasons: SafetyScoreV9NrReason[] = [
    ...trace.nrReasons.map((reason) => ({
      code: reason.code,
      message: reason.message,
      field: reason.field ?? null,
      origin: "asset" as const,
    })),
    ...trace.propagatedParentReasons.map((reason) => ({
      code: reason.code,
      message: reason.message,
      field: reason.field ?? null,
      origin: "upstream" as const,
    })),
  ];
  return [
    ...new Map(
      reasons.map((reason) => [
        `${reason.origin}\u0000${reason.code}\u0000${reason.field ?? ""}\u0000${reason.message}`,
        reason,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      compareText(left.origin, right.origin) ||
      compareText(left.code, right.code) ||
      compareText(left.field ?? "", right.field ?? "") ||
      compareText(left.message, right.message),
  );
}

function pillarComponents(input: V9PublicCardProjectionInput, pillar: V9QualityPillar): string[] {
  if (pillar === "backing") return uniqueSorted(input.backing?.contributions.map((item) => item.componentKey) ?? []);
  if (pillar === "exit") {
    return uniqueSorted(input.exit?.routes.filter((route) => route.included).map((route) => route.routeKey) ?? []);
  }
  return uniqueSorted(input.control?.components.map((item) => item.componentKey) ?? []);
}

function overallEvidenceLevel(input: V9PublicCardProjectionInput): V9EvidenceLevel {
  return [...PILLARS]
    .map((pillar) => input.scoreInput.pillars[pillar].evidenceLevel)
    .sort((left, right) => EVIDENCE_RANK[right] - EVIDENCE_RANK[left])[0]!;
}

function overallFreshness(input: V9PublicCardProjectionInput): SafetyScoreV9EvidenceFreshness {
  const freshness = PILLARS.map((pillar) => input.freshness?.[pillar] ?? "unknown");
  if (freshness.includes("stale")) return "stale";
  return freshness.every((value) => value === "current") ? "current" : "unknown";
}

function projectPillars(input: V9PublicCardProjectionInput): SafetyScoreV9Card["pillars"] {
  const contributions = new Map(
    input.trace.pillarContributions.map((contribution) => [contribution.pillar, contribution.score]),
  );
  const project = (pillar: V9QualityPillar) => {
    const evaluation = input.scoreInput.pillars[pillar];
    const contribution = contributions.get(pillar);
    if (evaluation.score !== null && contribution !== evaluation.score) {
      throw new Error(`Safety Score v9 ${input.trace.assetId} ${pillar} pillar does not match its score trace`);
    }
    if (evaluation.score === null && contribution !== undefined) {
      throw new Error(`Safety Score v9 ${input.trace.assetId} ${pillar} trace contains a missing pillar`);
    }
    return {
      score: evaluation.score,
      evidenceLevel: evaluation.evidenceLevel,
      freshness: input.freshness?.[pillar] ?? "unknown",
      components: pillarComponents(input, pillar),
      reasons: canonicalPublicReasons(evaluation.reasons),
    };
  };
  return { backing: project("backing"), exit: project("exit"), control: project("control") };
}

function projectDependencies(input: V9PublicCardProjectionInput): SafetyScoreV9Card["dependencies"] {
  return {
    serial: [...input.dependencyInputs.serial]
      .sort((left, right) => compareText(left.upstreamAssetId, right.upstreamAssetId))
      .map((dependency) => ({ ...dependency })),
    basket: [...input.dependencyInputs.basket]
      .sort((left, right) => compareText(left.upstreamAssetId, right.upstreamAssetId))
      .map((dependency) => ({ ...dependency })),
    cycleBlocked: input.dependencyInputs.cycleBlocked,
    reasonCodes: uniqueSorted(input.scoreInput.dependencyReasons.map((reason) => reason.code)),
  };
}

function allPublicReasonCodes(input: V9PublicCardProjectionInput): V9ReasonCode[] {
  return uniqueSorted([
    ...input.trace.nrReasons.map((reason) => reason.code),
    ...input.trace.propagatedParentReasons.map((reason) => reason.code),
    ...PILLARS.flatMap((pillar) => input.scoreInput.pillars[pillar].reasons.map((reason) => reason.code)),
    ...input.scoreInput.peg.reasons.map((reason) => reason.code),
    ...input.scoreInput.dependencyReasons.map((reason) => reason.code),
    ...(input.scoreInput.methodologyReasons ?? []).map((reason) => reason.code),
    ...(input.evidenceReasons ?? []).map((reason) => reason.code),
    ...(input.access.reasons ?? []).map((reason) => reason.code),
    ...(input.reasonCodes ?? []),
  ]);
}

export function projectSafetyScoreV9Card(input: V9PublicCardProjectionInput): SafetyScoreV9Card {
  const caps = input.trace.caps.map((cap) => ({
    kind: cap.kind,
    limit: cap.limit,
    source: cap.source,
    reason: cap.reason,
    binding: cap.binding,
  }));
  const bindingCap = caps.find((cap) => cap.binding) ?? null;
  return SafetyScoreV9ResponseSchema.shape.cards.element.parse({
    id: input.trace.assetId,
    score: input.trace.finalScore,
    grade: input.trace.finalGrade,
    qualityScore: input.trace.weightedQuality,
    pegMultiplier: input.trace.pegMultiplier,
    pegAdjustedScore: input.trace.preCapScore,
    pillars: projectPillars(input),
    weakestPillar: input.trace.weakestPillar,
    caps,
    bindingCap,
    nrReasons: canonicalNrReasons(input.trace),
    reasonCodes: allPublicReasonCodes(input),
    evidence: {
      level: overallEvidenceLevel(input),
      freshness: overallFreshness(input),
      reasons: canonicalPublicReasons(input.evidenceReasons ?? []),
    },
    accessPosture: {
      transfer: input.access.transfer,
      freezeExposure: input.access.freezeExposure,
      primaryExit: input.access.primaryExit,
      governance: input.access.governance,
      unknownFields: uniqueSorted(input.access.unknownFields),
      signals: uniqueSorted(input.access.signals),
      reasons: canonicalPublicReasons(input.access.reasons ?? []),
    },
    dependencies: projectDependencies(input),
    stressStateDigest: input.stressState?.stateDigest ?? null,
  });
}

function canonicalSourceGenerations(sourceGenerations: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(sourceGenerations).sort(([left], [right]) => compareText(left, right)));
}

function assertConsistentResultIdentity(results: readonly V9PublicCardProjectionInput[]): void {
  if (results.length === 0) throw new Error("Safety Score v9 publication requires at least one result");
  const first = results[0]!.trace;
  const firstSourceGenerations = JSON.stringify(canonicalSourceGenerations(first.sourceGenerations));
  const seen = new Set<string>();
  for (const { trace } of results) {
    if (seen.has(trace.assetId)) throw new Error(`Duplicate Safety Score v9 result ${trace.assetId}`);
    seen.add(trace.assetId);
    for (const [label, actual, expected] of [
      ["fact-set digest", trace.factSetDigest, first.factSetDigest],
      ["base input generation", trace.baseInputGenerationId, first.baseInputGenerationId],
      ["evaluation build", trace.evaluationBuildDigest, first.evaluationBuildDigest],
      ["policy ID", trace.policyId, first.policyId],
      ["policy digest", trace.policyDigest, first.policyDigest],
      ["evidence clock", String(trace.asOfSec), String(first.asOfSec)],
      [
        "source generations",
        JSON.stringify(canonicalSourceGenerations(trace.sourceGenerations)),
        firstSourceGenerations,
      ],
    ] as const) {
      if (actual !== expected) {
        throw new Error(`Safety Score v9 publication mixes ${label}: ${actual} != ${expected}`);
      }
    }
  }
}

export function buildSafetyScoreV9Response(args: BuildSafetyScoreV9ResponseArgs): SafetyScoreV9Response {
  assertConsistentResultIdentity(args.results);
  const ordered = [...args.results].sort((left, right) => compareText(left.trace.assetId, right.trace.assetId));
  const traces = ordered.map((result) => result.trace);
  const first = traces[0]!;
  const cards = ordered.map(projectSafetyScoreV9Card);
  const notRatedIds = cards.filter((card) => card.grade === "NR").map((card) => card.id);
  return SafetyScoreV9ResponseSchema.parse({
    model: "v9-critical-path",
    schemaVersion: 1,
    lifecycle: "candidate",
    candidateId: args.candidateId,
    policyVersion: args.policyVersion,
    publicationGenerationId: args.publicationGenerationId,
    publicationEpoch: args.publicationEpoch,
    baseInputGenerationId: first.baseInputGenerationId,
    factSetDigest: first.factSetDigest,
    resultDigest: computeV9ResultDigest(traces),
    policy: { id: first.policyId, semanticDigest: first.policyDigest },
    evaluationBuildDigest: first.evaluationBuildDigest,
    sourceGenerations: canonicalSourceGenerations(first.sourceGenerations),
    asOfSec: first.asOfSec,
    publishedAtSec: args.publishedAtSec,
    completeness: {
      expectedCount: cards.length,
      ratedCount: cards.length - notRatedIds.length,
      notRatedCount: notRatedIds.length,
      notRatedIds,
    },
    cards,
  });
}
