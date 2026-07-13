import {
  SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
  SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST,
} from "@shared/data/safety-score-v9/evaluation-build-manifest-v1";
import { loadV9MethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import {
  computeV9CoverageEvaluationProjectionDigestFromEvaluatedSet,
  projectV9CoverageEvaluationSnapshot,
} from "@shared/lib/safety-score-v9/coverage";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { V9ReleaseCoverageReportV1 } from "@shared/types/safety-score-v9-coverage";
import { CompiledV9FactSetV2Schema } from "@shared/types/safety-score-v9-facts";
import { SafetyScoreV9ResponseSchema } from "@shared/types/safety-score-v9-public";
import { V9MethodologyPolicySchema } from "@shared/types/safety-score-v9";
import { z } from "zod";
import { throwIfAborted } from "./abort";
import { normalizeFixedInput } from "./report-cards-fixed-input";
import {
  SafetyScoreV9CompilerFactSchemaIdentityV1Schema,
  SafetyScoreV9ProducerCapabilityIdentityV1Schema,
  buildSafetyScoreV9Candidate,
  computeSafetyScoreV9CompilerFactSchemaDigest,
  computeSafetyScoreV9ProducerCapabilityDigest,
} from "./safety-score-v9-candidate";
import { SafetyScoreV9FactSetExtensionV1Schema } from "./safety-score-v9-fact-set";
import {
  SAFETY_SCORE_V9_RELEASE_WINDOW_DAYS,
  SafetyScoreV9ReleaseWindowIdentitySchema,
  assessSafetyScoreV9ReleaseEvidence,
  evaluateSafetyScoreV9ReleaseWindow,
  type SafetyScoreV9ReleaseEvidenceInput,
  type SafetyScoreV9ReleaseWindowIdentity,
  type SafetyScoreV9ReleaseWindowReport,
} from "./safety-score-v9-release-window";
import {
  SafetyScoreV9ReplayArtifactKindSchema,
  SafetyScoreV9ShadowEnvelopeCoreSchema,
  assessSafetyScoreV9ShadowQualification,
  buildSafetyScoreV9ShadowAttempt,
  computeSafetyScoreV9ShadowEnvelopeDigest,
  rebuildSafetyScoreV9ShadowEnvelope,
  type SafetyScoreV9ReplayArtifact,
  type SafetyScoreV9ReplayArtifactKind,
  type SafetyScoreV9ShadowAttempt,
  type SafetyScoreV9ShadowDay,
} from "./safety-score-v9-shadow";
import {
  loadSafetyScoreV9ReplayArtifact,
  loadSafetyScoreV9ShadowHistory,
  parseSafetyScoreV9ReplayArtifact,
  type SafetyScoreV9StoredReplayArtifact,
} from "./safety-score-v9-store";

export const SAFETY_SCORE_V9_RELEASE_AUTHORIZATION_SCHEMA_VERSION = 1;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const UtcDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NonEmptyTextSchema = z.string().trim().min(1);

export const SafetyScoreV9ReleaseAuthorizationBlockerCodeSchema = z.enum([
  "release-evidence-no-go",
  "release-snapshot-identity-mismatch",
  "shadow-history-unreadable",
  "canonical-attempt-missing",
  "attempt-identity-mismatch",
  "artifact-missing",
  "artifact-unreadable",
  "artifact-shape-invalid",
  "base-input-replay-mismatch",
  "policy-replay-mismatch",
  "evaluation-build-not-current",
  "compiler-identity-mismatch",
  "producer-identity-mismatch",
  "fact-set-replay-mismatch",
  "evaluated-set-replay-mismatch",
  "candidate-replay-mismatch",
  "result-artifact-replay-mismatch",
  "envelope-replay-mismatch",
  "qualification-replay-mismatch",
  "daily-coverage-replay-mismatch",
  "release-window-no-go",
]);
export type SafetyScoreV9ReleaseAuthorizationBlockerCode = z.infer<
  typeof SafetyScoreV9ReleaseAuthorizationBlockerCodeSchema
>;

const AuthorizationBlockerSchema = z
  .object({
    code: SafetyScoreV9ReleaseAuthorizationBlockerCodeSchema,
    utcDay: UtcDaySchema.nullable(),
    artifactKind: SafetyScoreV9ReplayArtifactKindSchema.nullable(),
    detail: NonEmptyTextSchema,
  })
  .strict();
export type SafetyScoreV9ReleaseAuthorizationBlocker = z.infer<
  typeof AuthorizationBlockerSchema
>;

const ArtifactVerificationSchema = z
  .object({
    kind: SafetyScoreV9ReplayArtifactKindSchema,
    identity: NonEmptyTextSchema,
    contentSha256: Sha256Schema.nullable(),
    status: z.enum(["verified", "missing", "unreadable"]),
  })
  .strict();

const AuthorizationDaySchema = z
  .object({
    utcDay: UtcDaySchema,
    canonicalAttemptId: NonEmptyTextSchema.nullable(),
    verified: z.boolean(),
    publicationGenerationId: NonEmptyTextSchema.nullable(),
    baseInputGenerationId: NonEmptyTextSchema.nullable(),
    factSetDigest: Sha256Schema.nullable(),
    evaluatedSetDigest: Sha256Schema.nullable(),
    resultDigest: Sha256Schema.nullable(),
    envelopeDigest: Sha256Schema.nullable(),
    artifacts: z.array(ArtifactVerificationSchema),
    blockers: z.array(AuthorizationBlockerSchema),
  })
  .strict();

const AuthorizationReportPayloadSchema = z
  .object({
    schemaVersion: z.literal(SAFETY_SCORE_V9_RELEASE_AUTHORIZATION_SCHEMA_VERSION),
    lifecycle: z.literal("candidate-release-check"),
    identity: SafetyScoreV9ReleaseWindowIdentitySchema,
    windowStartUtcDay: UtcDaySchema,
    windowEndUtcDay: UtcDaySchema,
    decision: z.enum(["gate-passed", "no-go"]),
    releaseWindowReport: z.unknown().nullable(),
    days: z.array(AuthorizationDaySchema),
    blockers: z.array(AuthorizationBlockerSchema),
  })
  .strict();

export const SafetyScoreV9ReleaseAuthorizationReportSchema = AuthorizationReportPayloadSchema.extend({
  reportDigest: Sha256Schema,
})
  .strict()
  .superRefine((report, ctx) => {
    const { reportDigest: _reportDigest, ...payload } = report;
    const expected = computeSafetyScoreV9ReleaseAuthorizationReportDigest(payload);
    if (report.reportDigest !== expected) {
      ctx.addIssue({ code: "custom", path: ["reportDigest"], message: "Authorization report digest mismatch" });
    }
    if ((report.decision === "gate-passed") !== (report.blockers.length === 0)) {
      ctx.addIssue({ code: "custom", path: ["decision"], message: "Authorization decision and blockers disagree" });
    }
    if (report.releaseWindowReport !== null) {
      const parsed = z
        .object({ decision: z.enum(["gate-passed", "no-go"]) })
        .passthrough()
        .safeParse(report.releaseWindowReport);
      if (!parsed.success || (report.decision === "gate-passed" && parsed.data.decision !== "gate-passed")) {
        ctx.addIssue({ code: "custom", path: ["releaseWindowReport"], message: "Release-window decision mismatch" });
      }
    }
  });
export type SafetyScoreV9ReleaseAuthorizationReport = z.infer<
  typeof SafetyScoreV9ReleaseAuthorizationReportSchema
> & { releaseWindowReport: SafetyScoreV9ReleaseWindowReport | null };

type AuthorizationReportPayload = z.infer<typeof AuthorizationReportPayloadSchema>;

export interface VerifySafetyScoreV9ReleaseAuthorizationInput {
  db: D1Database;
  identity: SafetyScoreV9ReleaseWindowIdentity;
  evidence: SafetyScoreV9ReleaseEvidenceInput;
  windowEndUtcDay: string;
  signal?: AbortSignal;
}

const FactArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    extension: SafetyScoreV9FactSetExtensionV1Schema,
    compiledFacts: CompiledV9FactSetV2Schema,
  })
  .strict();

const PolicyArtifactSchema = z
  .object({
    policy: V9MethodologyPolicySchema,
    semanticDigest: Sha256Schema,
  })
  .strict();

const EvaluationBuildArtifactSchema = z
  .object({
    manifest: z.unknown(),
    compilerFactSchemaIdentity: SafetyScoreV9CompilerFactSchemaIdentityV1Schema,
    producerCapabilityIdentity: SafetyScoreV9ProducerCapabilityIdentityV1Schema,
  })
  .strict();

const ResultArtifactSchema = z
  .object({
    schemaVersion: z.literal(2),
    evaluatedSet: z.unknown(),
    candidate: SafetyScoreV9ResponseSchema,
    envelopeCore: SafetyScoreV9ShadowEnvelopeCoreSchema,
  })
  .strict();

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function previousUtcDay(utcDay: string, count: number): string {
  const timestamp = Date.parse(`${utcDay}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== utcDay) {
    throw new Error(`Invalid UTC day ${utcDay}`);
  }
  return new Date(timestamp - count * 86_400_000).toISOString().slice(0, 10);
}

function canonicalAttempt(day: SafetyScoreV9ShadowDay): SafetyScoreV9ShadowAttempt | null {
  const generationId = day.projection.canonicalQualifyingGenerationId;
  if (generationId === null) return null;
  return (
    day.attempts.find(
      (attempt) =>
        attempt.outcome === "succeeded" &&
        attempt.qualification?.qualifies === true &&
        attempt.identity?.publicationGenerationId === generationId,
    ) ?? null
  );
}

function expectedArtifactIdentities(attempt: SafetyScoreV9ShadowAttempt): Record<SafetyScoreV9ReplayArtifactKind, string> {
  const identity = attempt.identity;
  if (identity === null) throw new Error("Canonical attempt has no replay identity");
  return {
    "base-input": identity.baseInputGenerationId,
    "fact-set": identity.factSetDigest,
    policy: identity.policyDigest,
    "evaluation-build": identity.evaluationBuildDigest,
    result: identity.resultDigest,
  };
}

function expectedStableAttemptIdentityMatches(
  attempt: SafetyScoreV9ShadowAttempt,
  identity: SafetyScoreV9ReleaseWindowIdentity,
): boolean {
  const actual = attempt.identity;
  return actual !== null &&
    actual.candidateId === identity.candidateId &&
    actual.policyVersion === identity.policyVersion &&
    actual.policyId === identity.policyId &&
    actual.policyDigest === identity.policyDigest &&
    actual.evaluationBuildDigest === identity.evaluationBuildDigest &&
    actual.compilerFactSchemaDigest === identity.compilerFactSchemaDigest &&
    actual.producerCapabilityDigest === identity.producerCapabilityDigest &&
    actual.publicationEpoch === identity.publicationEpoch;
}

function addBlocker(
  blockers: SafetyScoreV9ReleaseAuthorizationBlocker[],
  code: SafetyScoreV9ReleaseAuthorizationBlockerCode,
  detail: string,
  utcDay: string | null = null,
  artifactKind: SafetyScoreV9ReplayArtifactKind | null = null,
): void {
  blockers.push({ code, utcDay, artifactKind, detail });
}

function sortBlockers(
  blockers: SafetyScoreV9ReleaseAuthorizationBlocker[],
): SafetyScoreV9ReleaseAuthorizationBlocker[] {
  return blockers.sort(
    (left, right) =>
      compareText(left.utcDay ?? "", right.utcDay ?? "") ||
      compareText(left.code, right.code) ||
      compareText(left.artifactKind ?? "", right.artifactKind ?? "") ||
      compareText(left.detail, right.detail),
  );
}

export function computeSafetyScoreV9ReleaseAuthorizationReportDigest(
  payload: AuthorizationReportPayload,
): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "safety-score-v9.release-authorization.v1",
      report: AuthorizationReportPayloadSchema.parse(payload),
    }),
  );
}

function buildAuthorizationReport(args: {
  identity: SafetyScoreV9ReleaseWindowIdentity;
  windowStartUtcDay: string;
  windowEndUtcDay: string;
  releaseWindowReport: SafetyScoreV9ReleaseWindowReport | null;
  days: z.infer<typeof AuthorizationDaySchema>[];
  blockers: SafetyScoreV9ReleaseAuthorizationBlocker[];
}): SafetyScoreV9ReleaseAuthorizationReport {
  const blockers = sortBlockers(args.blockers);
  const payload = AuthorizationReportPayloadSchema.parse({
    schemaVersion: SAFETY_SCORE_V9_RELEASE_AUTHORIZATION_SCHEMA_VERSION,
    lifecycle: "candidate-release-check",
    identity: args.identity,
    windowStartUtcDay: args.windowStartUtcDay,
    windowEndUtcDay: args.windowEndUtcDay,
    decision: blockers.length === 0 ? "gate-passed" : "no-go",
    releaseWindowReport: args.releaseWindowReport,
    days: args.days,
    blockers,
  });
  return SafetyScoreV9ReleaseAuthorizationReportSchema.parse({
    ...payload,
    reportDigest: computeSafetyScoreV9ReleaseAuthorizationReportDigest(payload),
  }) as SafetyScoreV9ReleaseAuthorizationReport;
}

async function loadDayArtifacts(args: {
  db: D1Database;
  attempt: SafetyScoreV9ShadowAttempt;
  utcDay: string;
  blockers: SafetyScoreV9ReleaseAuthorizationBlocker[];
  signal?: AbortSignal;
}): Promise<{
  stored: Map<SafetyScoreV9ReplayArtifactKind, SafetyScoreV9StoredReplayArtifact>;
  references: SafetyScoreV9ReplayArtifact[];
  checks: z.infer<typeof ArtifactVerificationSchema>[];
}> {
  const identities = expectedArtifactIdentities(args.attempt);
  const stored = new Map<SafetyScoreV9ReplayArtifactKind, SafetyScoreV9StoredReplayArtifact>();
  const references: SafetyScoreV9ReplayArtifact[] = [];
  const checks: z.infer<typeof ArtifactVerificationSchema>[] = [];
  for (const kind of SafetyScoreV9ReplayArtifactKindSchema.options) {
    const identity = identities[kind];
    try {
      const artifact = await loadSafetyScoreV9ReplayArtifact(args.db, kind, identity, args.signal);
      if (artifact === null) {
        checks.push({ kind, identity, contentSha256: null, status: "missing" });
        addBlocker(args.blockers, "artifact-missing", `No retained ${kind} artifact exists for ${identity}.`, args.utcDay, kind);
        continue;
      }
      const parsed = await parseSafetyScoreV9ReplayArtifact(artifact, {
        expectedKind: kind,
        expectedIdentity: identity,
        signal: args.signal,
      });
      stored.set(kind, artifact);
      references.push(parsed.reference);
      checks.push({ kind, identity, contentSha256: artifact.contentSha256, status: "verified" });
    } catch (error) {
      checks.push({ kind, identity, contentSha256: null, status: "unreadable" });
      addBlocker(
        args.blockers,
        "artifact-unreadable",
        `${kind} artifact verification failed: ${error instanceof Error ? error.message : String(error)}`,
        args.utcDay,
        kind,
      );
    }
  }
  return {
    stored,
    references: references.sort((left, right) => compareText(left.kind, right.kind)),
    checks: checks.sort((left, right) => compareText(left.kind, right.kind)),
  };
}

async function parsedArtifactValue(
  artifacts: Map<SafetyScoreV9ReplayArtifactKind, SafetyScoreV9StoredReplayArtifact>,
  kind: SafetyScoreV9ReplayArtifactKind,
  signal?: AbortSignal,
): Promise<{ value: unknown; canonicalJson: string }> {
  const artifact = artifacts.get(kind);
  if (!artifact) throw new Error(`Missing ${kind} artifact`);
  return parseSafetyScoreV9ReplayArtifact(artifact, { expectedKind: kind, expectedIdentity: artifact.identity, signal });
}

async function verifyReplayDay(args: {
  db: D1Database;
  day: SafetyScoreV9ShadowDay;
  identity: SafetyScoreV9ReleaseWindowIdentity;
  releaseCoverageReport: V9ReleaseCoverageReportV1 | null;
  signal?: AbortSignal;
}): Promise<z.infer<typeof AuthorizationDaySchema>> {
  const blockers: SafetyScoreV9ReleaseAuthorizationBlocker[] = [];
  const attempt = canonicalAttempt(args.day);
  if (attempt === null || attempt.identity === null) {
    addBlocker(blockers, "canonical-attempt-missing", "No canonical qualifying attempt can be replayed.", args.day.utcDay);
    return {
      utcDay: args.day.utcDay,
      canonicalAttemptId: null,
      verified: false,
      publicationGenerationId: null,
      baseInputGenerationId: null,
      factSetDigest: null,
      evaluatedSetDigest: null,
      resultDigest: null,
      envelopeDigest: null,
      artifacts: [],
      blockers,
    };
  }
  if (!expectedStableAttemptIdentityMatches(attempt, args.identity)) {
    addBlocker(
      blockers,
      "attempt-identity-mismatch",
      "The canonical attempt does not match the sealed RC/policy/build/compiler/producer/epoch identity.",
      args.day.utcDay,
    );
  }
  if (
    args.releaseCoverageReport === null ||
    attempt.identity.baseInputGenerationId !== args.releaseCoverageReport.identities.baseInputGenerationId ||
    attempt.identity.factSetDigest !== args.releaseCoverageReport.identities.factSetDigest ||
    attempt.identity.resultDigest !== args.releaseCoverageReport.identities.scoreResultDigest
  ) {
    addBlocker(
      blockers,
      "daily-coverage-replay-mismatch",
      "The canonical attempt does not match the exact base, fact-set, and result identities in the sealed V9-9 coverage report.",
      args.day.utcDay,
    );
  }

  const loaded = await loadDayArtifacts({
    db: args.db,
    attempt,
    utcDay: args.day.utcDay,
    blockers,
    signal: args.signal,
  });
  let replayedEvaluatedSetDigest: string | null = null;
  if (loaded.stored.size === SafetyScoreV9ReplayArtifactKindSchema.options.length) {
    try {
      const baseArtifact = await parsedArtifactValue(loaded.stored, "base-input", args.signal);
      const factArtifact = await parsedArtifactValue(loaded.stored, "fact-set", args.signal);
      const policyArtifact = await parsedArtifactValue(loaded.stored, "policy", args.signal);
      const buildArtifact = await parsedArtifactValue(loaded.stored, "evaluation-build", args.signal);
      const resultArtifact = await parsedArtifactValue(loaded.stored, "result", args.signal);

      const fixedInput = normalizeFixedInput(baseArtifact.value);
      if (stableJsonStringifyV1(fixedInput) !== baseArtifact.canonicalJson ||
          fixedInput.baseInputGenerationId !== attempt.identity.baseInputGenerationId) {
        addBlocker(blockers, "base-input-replay-mismatch", "The retained base input is not its canonical exact generation.", args.day.utcDay, "base-input");
      }

      const facts = FactArtifactSchema.parse(factArtifact.value);
      if (stableJsonStringifyV1(facts) !== factArtifact.canonicalJson ||
          facts.compiledFacts.v9FactSetDigest !== attempt.identity.factSetDigest) {
        addBlocker(blockers, "fact-set-replay-mismatch", "The retained fact artifact is not canonical or digest-bound.", args.day.utcDay, "fact-set");
      }

      const storedPolicy = PolicyArtifactSchema.parse(policyArtifact.value);
      const policy = loadV9MethodologyPolicy(storedPolicy.policy);
      if (stableJsonStringifyV1(storedPolicy) !== policyArtifact.canonicalJson ||
          storedPolicy.semanticDigest !== policy.semanticDigest ||
          policy.semanticDigest !== attempt.identity.policyDigest) {
        addBlocker(blockers, "policy-replay-mismatch", "The stored policy does not reproduce its sealed semantic digest.", args.day.utcDay, "policy");
      }

      const evaluationBuild = EvaluationBuildArtifactSchema.parse(buildArtifact.value);
      if (stableJsonStringifyV1(evaluationBuild.manifest) !== stableJsonStringifyV1(SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST) ||
          attempt.identity.evaluationBuildDigest !== SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST ||
          loaded.stored.get("evaluation-build")!.identity !== SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST) {
        addBlocker(blockers, "evaluation-build-not-current", "The stored evaluation manifest is not the current locked build.", args.day.utcDay, "evaluation-build");
      }

      const compilerDigest = computeSafetyScoreV9CompilerFactSchemaDigest(
        evaluationBuild.compilerFactSchemaIdentity,
      );
      if (compilerDigest !== attempt.identity.compilerFactSchemaDigest ||
          compilerDigest !== args.identity.compilerFactSchemaDigest) {
        addBlocker(blockers, "compiler-identity-mismatch", "The compiler identity does not match the canonical attempt.", args.day.utcDay, "evaluation-build");
      }
      const producerDigest = computeSafetyScoreV9ProducerCapabilityDigest(
        evaluationBuild.producerCapabilityIdentity,
      );
      if (producerDigest !== attempt.identity.producerCapabilityDigest ||
          producerDigest !== args.identity.producerCapabilityDigest) {
        addBlocker(blockers, "producer-identity-mismatch", "The producer capability identity does not match the canonical attempt.", args.day.utcDay, "evaluation-build");
      }

      const result = ResultArtifactSchema.parse(resultArtifact.value);
      replayedEvaluatedSetDigest = z
        .object({ evaluatedSetDigest: Sha256Schema })
        .passthrough()
        .parse(result.evaluatedSet).evaluatedSetDigest;
      const replay = buildSafetyScoreV9Candidate({
        fixedInput,
        extension: facts.extension,
        policy,
        publishedAtSec: result.candidate.publishedAtSec,
        publicationEpoch: result.candidate.publicationEpoch,
        releaseCandidateId: args.identity.candidateId,
      });
      const coverageEvaluation = projectV9CoverageEvaluationSnapshot(
        replay.evaluatedSet,
        replay.producerCapabilityDigest,
      );
      const evaluationProjectionDigest = computeV9CoverageEvaluationProjectionDigestFromEvaluatedSet(
        replay.evaluatedSet,
        replay.producerCapabilityDigest,
      );
      const replayedCoverageIdentities = {
        factSetDigest: replay.compiledFacts.v9FactSetDigest,
        baseInputGenerationId: replay.fixedInput.baseInputGenerationId,
        policyId: coverageEvaluation.policyId,
        policyDigest: coverageEvaluation.policyDigest,
        evaluationBuildDigest: coverageEvaluation.evaluationBuildDigest,
        producerCapabilityDigest: coverageEvaluation.producerCapabilityDigest,
        evaluatedSetDigest: coverageEvaluation.evaluatedSetDigest,
        scoreResultDigest: coverageEvaluation.scoreResultDigest,
        evaluationProjectionDigest,
        asOfSec: coverageEvaluation.asOfSec,
        sourceFingerprints: replay.compiledFacts.sourceFingerprints,
      };
      if (
        args.releaseCoverageReport === null ||
        stableJsonStringifyV1(replayedCoverageIdentities) !==
        stableJsonStringifyV1(args.releaseCoverageReport?.identities)
      ) {
        addBlocker(
          blockers,
          "daily-coverage-replay-mismatch",
          "The sealed V9-9 coverage report does not match this day's replayed base, facts, evaluation, result, source, and clock identities.",
          args.day.utcDay,
          "result",
        );
      }

      if (stableJsonStringifyV1(replay.fixedInput) !== baseArtifact.canonicalJson) {
        addBlocker(blockers, "base-input-replay-mismatch", "Replay normalized a different base input.", args.day.utcDay, "base-input");
      }
      if (stableJsonStringifyV1(replay.extension) !== stableJsonStringifyV1(facts.extension) ||
          stableJsonStringifyV1(replay.compiledFacts) !== stableJsonStringifyV1(facts.compiledFacts)) {
        addBlocker(blockers, "fact-set-replay-mismatch", "Replay did not reproduce the retained extension and compiled facts.", args.day.utcDay, "fact-set");
      }
      if (stableJsonStringifyV1(replay.evaluatedSet) !== stableJsonStringifyV1(result.evaluatedSet)) {
        addBlocker(blockers, "evaluated-set-replay-mismatch", "Replay did not reproduce the retained evaluated set byte-for-byte.", args.day.utcDay, "result");
      }
      if (stableJsonStringifyV1(replay.candidate) !== stableJsonStringifyV1(result.candidate)) {
        addBlocker(blockers, "candidate-replay-mismatch", "Replay did not reproduce the retained candidate byte-for-byte.", args.day.utcDay, "result");
      }
      if (stableJsonStringifyV1(replay.compilerFactSchemaIdentity) !==
            stableJsonStringifyV1(evaluationBuild.compilerFactSchemaIdentity) ||
          stableJsonStringifyV1(replay.producerCapabilityIdentity) !==
            stableJsonStringifyV1(evaluationBuild.producerCapabilityIdentity)) {
        addBlocker(blockers, "result-artifact-replay-mismatch", "Replay build identities differ from the retained evaluation artifact.", args.day.utcDay, "result");
      }

      const expectedResult = {
        schemaVersion: 2,
        evaluatedSet: replay.evaluatedSet,
        candidate: replay.candidate,
        envelopeCore: result.envelopeCore,
      };
      if (stableJsonStringifyV1(expectedResult) !== resultArtifact.canonicalJson) {
        addBlocker(blockers, "result-artifact-replay-mismatch", "Replay did not reproduce the retained result artifact byte-for-byte.", args.day.utcDay, "result");
      }

      const envelope = rebuildSafetyScoreV9ShadowEnvelope({
        candidate: replay.candidate,
        core: result.envelopeCore,
        replayArtifacts: loaded.references,
      });
      const envelopeDigest = computeSafetyScoreV9ShadowEnvelopeDigest(envelope);
      if (envelopeDigest !== attempt.identity.envelopeDigest) {
        addBlocker(blockers, "envelope-replay-mismatch", "The five retained artifacts do not reproduce the counted envelope digest.", args.day.utcDay);
      }
      const rebuiltAttempt = buildSafetyScoreV9ShadowAttempt({
        attemptId: attempt.attemptId,
        trigger: attempt.trigger,
        retryOfAttemptId: attempt.retryOfAttemptId,
        scheduledForSec: attempt.scheduledForSec,
        startedAtSec: attempt.startedAtSec!,
        completedAtSec: attempt.completedAtSec!,
        recordedAtSec: attempt.recordedAtSec,
        outcome: "succeeded",
        envelope,
      });
      if (stableJsonStringifyV1(rebuiltAttempt.identity) !== stableJsonStringifyV1(attempt.identity)) {
        addBlocker(blockers, "attempt-identity-mismatch", "The replayed envelope does not reproduce the full canonical attempt identity.", args.day.utcDay);
      }
      if (stableJsonStringifyV1(assessSafetyScoreV9ShadowQualification(envelope)) !==
          stableJsonStringifyV1(attempt.qualification) ||
          stableJsonStringifyV1(rebuiltAttempt.qualification) !== stableJsonStringifyV1(attempt.qualification)) {
        addBlocker(blockers, "qualification-replay-mismatch", "The replayed envelope does not reproduce the counted qualification.", args.day.utcDay);
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        addBlocker(blockers, "artifact-shape-invalid", `A retained artifact has an invalid strict shape: ${error.issues[0]?.message ?? error.message}`, args.day.utcDay);
      } else {
        addBlocker(blockers, "result-artifact-replay-mismatch", `Deterministic replay failed: ${error instanceof Error ? error.message : String(error)}`, args.day.utcDay);
      }
    }
  }

  sortBlockers(blockers);
  return {
    utcDay: args.day.utcDay,
    canonicalAttemptId: attempt.attemptId,
    verified: blockers.length === 0,
    publicationGenerationId: attempt.identity.publicationGenerationId,
    baseInputGenerationId: attempt.identity.baseInputGenerationId,
    factSetDigest: attempt.identity.factSetDigest,
    evaluatedSetDigest: replayedEvaluatedSetDigest,
    resultDigest: attempt.identity.resultDigest,
    envelopeDigest: attempt.identity.envelopeDigest,
    artifacts: loaded.checks,
    blockers,
  };
}

/**
 * Verify all retained artifacts before invoking the pure 30-day evaluator.
 * The returned report is candidate-only and has no activation side effect.
 */
export async function verifySafetyScoreV9ReleaseAuthorization(
  input: VerifySafetyScoreV9ReleaseAuthorizationInput,
): Promise<SafetyScoreV9ReleaseAuthorizationReport> {
  throwIfAborted(input.signal);
  const identity = SafetyScoreV9ReleaseWindowIdentitySchema.parse(input.identity);
  const windowEndUtcDay = UtcDaySchema.parse(input.windowEndUtcDay);
  const windowStartUtcDay = previousUtcDay(windowEndUtcDay, SAFETY_SCORE_V9_RELEASE_WINDOW_DAYS - 1);
  const blockers: SafetyScoreV9ReleaseAuthorizationBlocker[] = [];
  const evidence = assessSafetyScoreV9ReleaseEvidence(identity, input.evidence);
  if (evidence.blockers.length > 0) {
    for (const blocker of evidence.blockers) {
      addBlocker(blockers, "release-evidence-no-go", `${blocker.code}: ${blocker.detail}`);
    }
    return buildAuthorizationReport({
      identity,
      windowStartUtcDay,
      windowEndUtcDay,
      releaseWindowReport: null,
      days: [],
      blockers,
    });
  }

  let days: SafetyScoreV9ShadowDay[];
  try {
    days = await loadSafetyScoreV9ShadowHistory(input.db, {
      fromUtcDay: windowStartUtcDay,
      toUtcDay: windowEndUtcDay,
      limit: SAFETY_SCORE_V9_RELEASE_WINDOW_DAYS,
      signal: input.signal,
    });
  } catch (error) {
    addBlocker(
      blockers,
      "shadow-history-unreadable",
      `The canonical daily history could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
    return buildAuthorizationReport({
      identity,
      windowStartUtcDay,
      windowEndUtcDay,
      releaseWindowReport: null,
      days: [],
      blockers,
    });
  }

  const orderedDays = [...days].sort((left, right) => compareText(left.utcDay, right.utcDay));
  const verifiedDays: z.infer<typeof AuthorizationDaySchema>[] = [];
  for (const day of orderedDays) {
    throwIfAborted(input.signal);
    const verified = await verifyReplayDay({
      db: input.db,
      day,
      identity,
      releaseCoverageReport:
        evidence.releaseCoverageReport?.entries.find((entry) => entry.utcDay === day.utcDay)?.report ?? null,
      signal: input.signal,
    });
    verifiedDays.push(verified);
    blockers.push(...verified.blockers);
  }

  if (orderedDays.length !== SAFETY_SCORE_V9_RELEASE_WINDOW_DAYS) {
    addBlocker(
      blockers,
      "canonical-attempt-missing",
      `Expected ${SAFETY_SCORE_V9_RELEASE_WINDOW_DAYS} retained UTC days; loaded ${orderedDays.length}.`,
    );
  }
  if (blockers.length > 0) {
    return buildAuthorizationReport({
      identity,
      windowStartUtcDay,
      windowEndUtcDay,
      releaseWindowReport: null,
      days: verifiedDays,
      blockers,
    });
  }

  const releaseWindowReport = evaluateSafetyScoreV9ReleaseWindow({
    identity,
    evidence: input.evidence,
    days: orderedDays,
  });
  if (releaseWindowReport.decision !== "gate-passed") {
    for (const blocker of releaseWindowReport.blockers) {
      addBlocker(
        blockers,
        "release-window-no-go",
        `${blocker.code}: ${blocker.detail}`,
        blocker.utcDay,
      );
    }
  }
  return buildAuthorizationReport({
    identity,
    windowStartUtcDay,
    windowEndUtcDay,
    releaseWindowReport,
    days: verifiedDays,
    blockers,
  });
}
