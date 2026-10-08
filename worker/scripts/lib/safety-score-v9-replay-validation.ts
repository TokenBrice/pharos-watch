import { z } from "zod";
import { execFileSync } from "node:child_process";
import { V9GradeSchema } from "@shared/types/safety-score-v9";
import { V9RatingStatusSchema } from "@shared/types/safety-score-v9-causes";
import { CompiledV9FactSetV2Schema, CompiledV9FactSetV3Schema } from "@shared/types/safety-score-v9-facts";
import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import { computeV9FactSetDigest } from "@shared/lib/safety-score-v9/facts";
import { computeV9ResultDigest, projectCompactV9ScoreTrace } from "@shared/lib/safety-score-v9/trace";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { deriveNativeV9BaseInputGenerationId, NativeSafetyScoreV9InputSchema } from "../../src/lib/safety-score-v9/native-input";
import { ReportCardsFixedInputSchema } from "../../src/lib/report-cards-fixed-input";
import { buildSafetyScoreV9ReplayArtifact, type SafetyScoreV9ReplayArtifact } from "../replay-safety-score-v9";
import { verifyRegistrySnapshot, type SafetyScoreV9RegistrySnapshot } from "./safety-score-v9-registry";
import type { V9ProductionScoreTrace } from "@shared/lib/safety-score-v9/score";
import { sha256Hex } from "@shared/lib/sha256";
import type { SafetyScoreV9TransferMaterialityGeneration } from "../../src/lib/safety-score-v9/transfer-materiality";
import { Sha256Schema } from "@shared/types/safety-schema-primitives";

const CardProjectionSchema = z.object({
  id: z.string().min(1).refine(id => id.trim() === id && id.length > 0, "canonical nonempty asset ID"),
  score: z.number().finite().min(0).max(100).nullable(),
  grade: V9GradeSchema.nullable(),
  ratingStatus: V9RatingStatusSchema.optional(),
}).loose().superRefine((card, ctx) => {
  const status = card.ratingStatus ?? (card.grade === null ? "pipeline-gap" : card.grade === "NR" ? "not-rated" : "rated");
  if ((status === "rated" && (card.score === null || card.grade === null || card.grade === "NR")) ||
    (status === "not-rated" && (card.score !== null || card.grade !== "NR")) ||
    (status === "pipeline-gap" && (card.score !== null || card.grade !== null))) {
    ctx.addIssue({ code: "custom", message: "inconsistent score/grade/rating status" });
  }
});

function uniqueIds(ids: readonly string[], label: string): string[] {
  if (ids.some(id => typeof id !== "string" || id.trim().length === 0) || new Set(ids).size !== ids.length) {
    throw new Error(`${label}: empty or duplicate asset ID`);
  }
  return [...ids].sort();
}
function same(actual: unknown, expected: unknown, label: string): void {
  if (stableJsonStringifyV1(actual) !== stableJsonStringifyV1(expected)) throw new Error(`${label}: integrity mismatch`);
}

/** Frozen result-v1 projection; no checkout policy/build dependencies. */
function projectLegacyTrace(trace: V9ProductionScoreTrace) {
  const pillars = new Map(trace.pillarContributions.map(entry => [entry.pillar, entry.score]));
  return {
    assetId: trace.assetId, score: trace.finalScore, grade: trace.finalGrade,
    pillars: { backing: pillars.get("backing") ?? null, exit: pillars.get("exit") ?? null, control: pillars.get("control") ?? null },
    weakestPillar: trace.weakestPillar,
    bindingCap: trace.bindingCap ? { kind: trace.bindingCap.kind, limit: trace.bindingCap.limit, source: trace.bindingCap.source } : null,
    reasonCodes: [...new Set(trace.nrReasons.map(reason => reason.code))].sort(),
    factSetDigest: trace.factSetDigest, policyId: trace.policyId, policyDigest: trace.policyDigest,
    evaluationBuildDigest: trace.evaluationBuildDigest, asOfSec: trace.asOfSec,
  };
}

/** Lightweight live projections are structurally checked, never compiled. */
export function validateReplayCardProjection(value: unknown) {
  const parsed = z.object({ pipeline: z.object({ candidate: z.object({ cards: z.array(CardProjectionSchema) }).loose() }).loose() }).loose().parse(value);
  uniqueIds(parsed.pipeline.candidate.cards.map(card => card.id), "candidate cards");
  if (value && typeof value === "object" && ("kind" in value || "schemaVersion" in value)) {
    validateSafetyScoreV9ReplayIntegrity(value);
  }
  return parsed.pipeline.candidate.cards;
}

/** Pure artifact validation: no current policy/build pin and no compiler execution. */
export function validateSafetyScoreV9ReplayIntegrity(value: unknown): asserts value is SafetyScoreV9ReplayArtifact {
  const envelope = z.object({
    schemaVersion: z.literal(1),
    kind: z.literal("safety-score-v9-candidate-replay"),
    lifecycle: z.literal("active"),
    releaseAuthorization: z.object({ authorized: z.literal(false), reason: z.literal("v9-replay-only") }),
    pipeline: z.object({
      candidateIdentity: z.object({
        schemaVersion: z.literal(1), policyId: z.string().min(1),
        policyDigest: Sha256Schema, evaluationBuildDigest: Sha256Schema,
        compilerFactSchemaDigest: Sha256Schema, producerCapabilityDigest: Sha256Schema,
      }).strict(),
      compilerFactSchemaIdentity: z.object({
        schemaVersion: z.literal(1), fixedInputSchemaVersion: z.number().int().positive(),
        factExtensionSchemaVersion: z.number().int().positive(), compiledFactSchemaVersion: z.number().int().positive(),
        compiledFactSchemaCapabilities: z.array(z.string().min(1)), compilerAdapter: z.string().min(1),
        evaluationBuildDigest: Sha256Schema,
      }).strict(),
      producerCapabilityIdentity: z.object({
        schemaVersion: z.literal(1),
        inputContractVersions: z.object({ fixedInput: z.number().int().positive(), factExtension: z.number().int().positive() }).strict(),
        sourceAdapters: z.record(z.string(), z.string().min(1)),
        scoreBearingMethodologyVersions: z.record(z.string(), z.array(z.string().min(1))),
        dexRouteCapabilityMatrixVersions: z.array(z.string().min(1)),
        freshnessPolicySec: z.record(z.string(), z.number().int().nonnegative().nullable()),
      }).strict(),
      fixedInput: z.object({
        schemaVersion: z.union([z.literal(3), z.literal(4)]),
        activeAssetIds: z.array(z.string()), clockSec: z.number().int().nonnegative(),
      }).loose(),
      extension: z.object({ schemaVersion: z.number().int() }).loose(),
      compiledFacts: z.union([CompiledV9FactSetV2Schema, CompiledV9FactSetV3Schema]),
      evaluatedSet: z.object({
        assets: z.array(z.object({
          assetId: z.string(), trace: z.object({ assetId: z.string() }).loose(),
        }).loose()),
      }).loose(),
      candidate: z.object({
        publishedAtSec: z.number().int().nonnegative(), cards: z.array(CardProjectionSchema),
      }).loose(),
    }).loose(),
  }).loose().parse(value);
  const p = value as SafetyScoreV9ReplayArtifact;
  const pipeline = p.pipeline;
  const ids = uniqueIds(envelope.pipeline.fixedInput.activeAssetIds, "fixed input");
  for (const [label, rows] of [
    ["compiled IDs", envelope.pipeline.compiledFacts.activeAssetIds],
    ["compiled rows", envelope.pipeline.compiledFacts.assets.map(row => row.assetId)],
    ["evaluated rows", envelope.pipeline.evaluatedSet.assets.map(row => row.assetId)],
    ["trace rows", envelope.pipeline.evaluatedSet.assets.map(row => row.trace.assetId)],
    ["candidate cards", envelope.pipeline.candidate.cards.map(row => row.id)],
  ] as const) same(uniqueIds(rows, label), ids, label);
  // The compiler projection erases legacy-only fields and is not a
  // discriminated capture union. Validate the retained capture before hashing
  // with its version's identity contract.
  const fixedInput = pipeline.fixedInput.schemaVersion === 4
    ? NativeSafetyScoreV9InputSchema.parse(pipeline.fixedInput)
    : ReportCardsFixedInputSchema.parse(pipeline.fixedInput);
  const base = fixedInput.schemaVersion === 4
    ? deriveNativeV9BaseInputGenerationId(fixedInput)
    : deriveReportCardsBaseInputGenerationId(fixedInput);
  for (const actual of [pipeline.fixedInput.baseInputGenerationId, pipeline.compiledFacts.baseInputGenerationId, pipeline.candidate.baseInputGenerationId]) same(actual, base, "base generation");
  const facts = computeV9FactSetDigest(pipeline.compiledFacts);
  for (const actual of [pipeline.compiledFacts.v9FactSetDigest, pipeline.evaluatedSet.factSetDigest, pipeline.candidate.factSetDigest]) same(actual, facts, "fact digest");
  const traces = pipeline.evaluatedSet.assets.map(asset => asset.trace);
  const versions = new Set(traces.map(trace => {
    const inheritable = Object.prototype.hasOwnProperty.call(trace, "inheritableScore");
    if (inheritable !== Object.prototype.hasOwnProperty.call(trace, "scoreAdjustments")) throw new Error("Incomplete result-digest trace version");
    return inheritable ? 2 : 1;
  }));
  if (versions.size !== 1) throw new Error("Replay must carry one nonempty result-digest trace version");
  const legacy = versions.has(1);
  const result = legacy
    ? sha256Hex(stableJsonStringifyV1({ domain: "safety-score-v9.result.v1", results: traces.map(projectLegacyTrace).sort((a, b) => a.assetId.localeCompare(b.assetId)) }))
    : computeV9ResultDigest(traces);
  same(pipeline.evaluatedSet.scoreResultDigest, result, "evaluated result digest");
  same(pipeline.candidate.resultDigest, result, "candidate result digest");
  const identity = pipeline.candidateIdentity;
  const compilerDigest = domainDigest("safety-score-v9.compiler-fact-schema.v1", pipeline.compilerFactSchemaIdentity);
  const producerDigest = domainDigest("safety-score-v9.producer-capability-build.v1", pipeline.producerCapabilityIdentity);
  same(pipeline.compilerFactSchemaDigest, compilerDigest, "compiler identity digest");
  same(identity.compilerFactSchemaDigest, compilerDigest, "candidate compiler digest");
  same(pipeline.producerCapabilityDigest, producerDigest, "producer identity digest");
  same(identity.producerCapabilityDigest, producerDigest, "candidate producer digest");
  same(pipeline.compilerFactSchemaIdentity.evaluationBuildDigest, identity.evaluationBuildDigest, "compiler build");
  same(pipeline.compilerFactSchemaIdentity.fixedInputSchemaVersion, pipeline.fixedInput.schemaVersion, "input schema");
  same(pipeline.compilerFactSchemaIdentity.factExtensionSchemaVersion, pipeline.extension.schemaVersion, "extension schema");
  same(pipeline.compilerFactSchemaIdentity.compiledFactSchemaVersion, pipeline.compiledFacts.schemaVersion, "fact schema");
  same(pipeline.evaluatedSet.evaluationBuildDigest, identity.evaluationBuildDigest, "evaluated build");
  same(pipeline.evaluatedSet.policyDigest, identity.policyDigest, "evaluated policy digest");
  same(pipeline.evaluatedSet.policyId, identity.policyId, "evaluated policy ID");
  if (!/^v9-rc-[1-9][0-9]*$/.test(pipeline.candidate.candidateId)) same(pipeline.candidate.candidateId, `safety-score-v9:v1:${domainDigest("safety-score-v9.publication-id.v1", identity)}`, "candidate ID");
  same(pipeline.candidate.publicationGenerationId, `report-cards:v9:v1:${domainDigest("safety-score-v9.publication.v1", {
    candidateId: pipeline.candidate.candidateId, baseInputGenerationId: base, factSetDigest: facts,
    evaluatedSetDigest: pipeline.evaluatedSet.evaluatedSetDigest, resultDigest: result,
    publishedAtSec: pipeline.candidate.publishedAtSec,
  })}`, "publication generation");
  same(pipeline.producerCapabilityIdentity.inputContractVersions, {
    fixedInput: pipeline.fixedInput.schemaVersion, factExtension: pipeline.extension.schemaVersion,
  }, "producer input contracts");
  same(pipeline.compiledFacts.asOfSec, pipeline.fixedInput.clockSec, "compiled clock");
  same(pipeline.evaluatedSet.asOfSec, pipeline.fixedInput.clockSec, "evaluated clock");
  const evaluated = new Map(pipeline.evaluatedSet.assets.map(asset => [asset.assetId, asset]));
  for (const card of pipeline.candidate.cards) {
    const trace = evaluated.get(card.id)!.trace;
    const compact = legacy ? projectLegacyTrace(trace) : projectCompactV9ScoreTrace(trace);
    same([card.score, card.grade], [compact.score, compact.grade], `card ${card.id}`);
    if (!legacy) same(card.ratingStatus, trace.ratingStatus, `card status ${card.id}`);
    same([card.pillars.backing.score, card.pillars.exit.score, card.pillars.control.score], [compact.pillars.backing, compact.pillars.exit, compact.pillars.control], `pillars ${card.id}`);
    same([trace.baseInputGenerationId, trace.factSetDigest, trace.policyId, trace.policyDigest, trace.evaluationBuildDigest, trace.asOfSec], [base, facts, identity.policyId, identity.policyDigest, identity.evaluationBuildDigest, pipeline.fixedInput.clockSec], `trace bindings ${card.id}`);
  }
}

export interface ReplayReproductionContext {
  sourceRevision: string;
  policyId: string;
  policyDigest: string;
  evaluationBuildDigest: string;
  registrySnapshot: SafetyScoreV9RegistrySnapshot;
  publishedAtSec: number;
  transferMaterialityGeneration: SafetyScoreV9TransferMaterialityGeneration | null;
}

/** Must run at the intended trusted source revision. Explicit null enrichment is meaningful. */
export function reproduceSafetyScoreV9Replay(value: unknown, context: ReplayReproductionContext): void {
  validateSafetyScoreV9ReplayIntegrity(value);
  if (!context || !/^[a-f0-9]{40}$/.test(context.sourceRevision) ||
    !Object.prototype.hasOwnProperty.call(context, "transferMaterialityGeneration") ||
    context.transferMaterialityGeneration === undefined) throw new Error("Missing intended-revision reproduction context");
  same(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), context.sourceRevision, "source revision");
  same([value.pipeline.candidateIdentity.policyId, value.pipeline.candidateIdentity.policyDigest, value.pipeline.candidateIdentity.evaluationBuildDigest, value.pipeline.candidate.publishedAtSec], [context.policyId, context.policyDigest, context.evaluationBuildDigest, context.publishedAtSec], "intended policy/build/clock");
  same(value.pipeline.fixedInput.registryFingerprint, verifyRegistrySnapshot(context.registrySnapshot).fingerprint, "intended registry");
  const rebuilt = buildSafetyScoreV9ReplayArtifact({ fixedInput: value.pipeline.fixedInput, extension: value.pipeline.extension, publishedAtSec: context.publishedAtSec, registrySnapshot: context.registrySnapshot, transferMaterialityGeneration: context.transferMaterialityGeneration, ...(/^v9-rc-[1-9][0-9]*$/.test(value.pipeline.candidate.candidateId) ? { releaseCandidateId: value.pipeline.candidate.candidateId } : {}) });
  same(rebuilt.pipeline, value.pipeline, "intended-revision reproduction");
}
