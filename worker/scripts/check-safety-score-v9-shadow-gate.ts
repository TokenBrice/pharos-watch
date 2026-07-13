import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST } from "../../shared/data/safety-score-v9/evaluation-build-manifest-v1";
import {
  V9_CONSUMER_SCORE_THRESHOLD_REGISTRY_DIGEST,
  V9_SHADOW_MINIMUM_PRODUCER_CYCLES,
  V9_SHADOW_RELEASE_COVERAGE_POLICY_DIGEST,
  V9_SHADOW_SCORE_BEARING_PRODUCER_INTERVALS_SEC,
  V9_SHADOW_SLOWEST_SCORE_BEARING_SOURCE_KEYS,
} from "../../shared/lib/safety-score-v9/operational-gate";
import { V9_CANDIDATE_POLICY_V1, loadV9MethodologyPolicy } from "../../shared/lib/safety-score-v9/policy";
import { stableJsonStringifyV1 } from "../../shared/lib/stable-json";
import { SafetyScoreV9ResponseSchema } from "../../shared/types/safety-score-v9-public";
import { normalizeFixedInput } from "../src/lib/report-cards-fixed-input";
import { buildSafetyScoreV9Candidate } from "../src/lib/safety-score-v9-candidate";
import { z } from "zod";
import {
  SAFETY_SCORE_V9_REQUIRED_SHADOW_COVERAGE_FLOOR_IDS,
  SAFETY_SCORE_V9_SHADOW_MINIMUM_QUALIFYING_DAYS,
  SafetyScoreV9ShadowEnvelopeCoreSchema,
  SafetyScoreV9ShadowDailySchema,
  computeSafetyScoreV9ShadowEnvelopeDigest,
  rebuildSafetyScoreV9ShadowEnvelope,
  type SafetyScoreV9ShadowDaily,
} from "../src/lib/safety-score-v9-shadow";
import {
  SafetyScoreV9StoredReplayArtifactSchema,
  parseSafetyScoreV9ReplayArtifact,
  type SafetyScoreV9StoredReplayArtifact,
} from "../src/lib/safety-score-v9-store";
import {
  assertCliUsage,
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../../scripts/lib/cli-args.mjs";

export const SAFETY_SCORE_V9_SHADOW_GATE_MINIMUM_DAYS = SAFETY_SCORE_V9_SHADOW_MINIMUM_QUALIFYING_DAYS;
export const SAFETY_SCORE_V9_SHADOW_GATE_MINIMUM_PRODUCER_CYCLES = V9_SHADOW_MINIMUM_PRODUCER_CYCLES;
export const SAFETY_SCORE_V9_ARCHIVED_REPLAY_EVIDENCE_SCHEMA_VERSION = 1;

export const SAFETY_SCORE_V9_SCORE_BEARING_PRODUCER_INTERVALS_SEC = V9_SHADOW_SCORE_BEARING_PRODUCER_INTERVALS_SEC;
export const SAFETY_SCORE_V9_SLOWEST_SCORE_BEARING_PRODUCER_INTERVAL_SEC = Math.max(
  ...Object.values(SAFETY_SCORE_V9_SCORE_BEARING_PRODUCER_INTERVALS_SEC),
);
export const SAFETY_SCORE_V9_SLOWEST_SCORE_BEARING_SOURCE_KEYS = V9_SHADOW_SLOWEST_SCORE_BEARING_SOURCE_KEYS;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const UtcDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NonEmptyTextSchema = z.string().trim().min(1);
const ArchiveSelectionReasonSchema = z.enum(["first", "final", "anomaly"]);
const ArchivedFactSetArtifactSchema = z
  .object({ schemaVersion: z.literal(1), extension: z.unknown(), compiledFacts: z.unknown() })
  .strict();
const ArchivedPolicyArtifactSchema = z.object({ policy: z.unknown(), semanticDigest: Sha256Schema }).strict();
const ArchivedEvaluationBuildArtifactSchema = z.object({ manifest: z.unknown() }).strict();
const ArchivedResultArtifactSchema = z
  .object({
    schemaVersion: z.literal(2),
    evaluatedSet: z.unknown(),
    candidate: SafetyScoreV9ResponseSchema,
    envelopeCore: SafetyScoreV9ShadowEnvelopeCoreSchema,
  })
  .strict();
const WranglerResultEnvelopeSchema = z.object({ results: z.array(z.unknown()) }).passthrough();
const ShadowSummaryExportRowSchema = z
  .object({
    utc_day: UtcDaySchema.optional(),
    daily_json: z.string().min(1),
  })
  .passthrough();
const ReplayArtifactExportRowSchema = z
  .object({
    artifact_key: z.string().min(1),
    artifact_kind: NonEmptyTextSchema,
    identity: NonEmptyTextSchema,
    content_sha256: Sha256Schema,
    encoding: z.string(),
    uncompressed_bytes: z.number().int(),
    stored_bytes: z.number().int(),
    payload: z.string().min(1),
    created_at_sec: z.number().int(),
    verified_at_sec: z.number().int(),
  })
  .passthrough();

export const SafetyScoreV9ArchivedReplayEvidenceEntrySchema = z
  .object({
    utcDay: UtcDaySchema,
    selectionReasons: z.array(ArchiveSelectionReasonSchema),
    artifactKeys: z.array(NonEmptyTextSchema),
    expectedResultDigest: Sha256Schema,
    status: z.enum(["passed", "failed"]),
    replayedResultDigest: Sha256Schema.nullable(),
  })
  .strict();
export type SafetyScoreV9ArchivedReplayEvidenceEntry = z.infer<typeof SafetyScoreV9ArchivedReplayEvidenceEntrySchema>;

export const SafetyScoreV9ArchivedReplayEvidenceSchema = z
  .object({
    schemaVersion: z.literal(SAFETY_SCORE_V9_ARCHIVED_REPLAY_EVIDENCE_SCHEMA_VERSION),
    replays: z.array(SafetyScoreV9ArchivedReplayEvidenceEntrySchema),
  })
  .strict();
export type SafetyScoreV9ArchivedReplayEvidence = z.infer<typeof SafetyScoreV9ArchivedReplayEvidenceSchema>;

export const SafetyScoreV9ShadowGateBlockerCodeSchema = z.enum([
  "insufficient-day-count",
  "invalid-utc-day",
  "duplicate-day",
  "calendar-gap",
  "no-successful-attempt",
  "selected-run-missing",
  "candidate-id-drift",
  "policy-drift",
  "evaluation-build-drift",
  "compiler-fact-schema-drift",
  "producer-capability-drift",
  "release-coverage-policy-drift",
  "consumer-threshold-registry-drift",
  "selected-run-day-mismatch",
  "insufficient-producer-cycle-count",
  "insufficient-producer-generation-count",
  "insufficient-archived-producer-generation-count",
  "active-id-bijection-failed",
  "coverage-floor-set-mismatch",
  "coverage-floor-failed",
  "compiler-exception",
  "future-dated-evidence",
  "publication-regression",
  "unresolved-critical-movement",
  "unresolved-review",
  "unresolved-release-blocker",
  "qualification-failed",
  "first-selection-missing",
  "first-selection-mismatch",
  "final-selection-missing",
  "final-selection-mismatch",
  "archived-artifact-set-invalid",
  "replay-evidence-duplicate",
  "replay-evidence-missing",
  "replay-evidence-unexpected",
  "replay-evidence-failed",
  "replay-selection-mismatch",
  "replay-artifact-mismatch",
  "replay-result-mismatch",
]);
export type SafetyScoreV9ShadowGateBlockerCode = z.infer<typeof SafetyScoreV9ShadowGateBlockerCodeSchema>;

export interface SafetyScoreV9ShadowGateBlocker {
  code: SafetyScoreV9ShadowGateBlockerCode;
  utcDay: string | null;
  detail: string;
}

export interface SafetyScoreV9ShadowGateReport {
  schemaVersion: 1;
  decision: "gate-passed" | "no-go";
  minimumDayCount: number;
  observedDayCount: number;
  minimumProducerCycleCount: number;
  slowestScoreBearingProducerIntervalSec: number;
  observedProducerCycleCount: number;
  observedWindowSec: number;
  producerGenerationEvidence: Array<{
    sourceKey: (typeof SAFETY_SCORE_V9_SLOWEST_SCORE_BEARING_SOURCE_KEYS)[number];
    observedGenerationCount: number;
    archivedGenerationCount: number;
  }>;
  windowStartUtcDay: string | null;
  windowEndUtcDay: string | null;
  frozenIdentity: {
    candidateId: string;
    policyId: string;
    policyVersion: string;
    policyDigest: string;
    evaluationBuildDigest: string;
    compilerFactSchemaDigest: string;
    producerCapabilityDigest: string;
    releaseCoveragePolicyDigest: string;
    consumerThresholdRegistryDigest: string;
  } | null;
  requiredReplayDays: Array<{
    utcDay: string;
    selectionReasons: Array<"first" | "final" | "anomaly">;
    resultDigest: string;
  }>;
  verifiedReplayDays: string[];
  blockers: SafetyScoreV9ShadowGateBlocker[];
}

const USAGE = `Usage: npm run safety-score-v9:shadow-gate -- [options]

Options:
  --summaries <path>       Wrangler D1 JSON export of compact V9 shadow daily rows (required)
  --artifacts <path>       Wrangler D1 JSON export of selected replay artifact rows (required)
  -h, --help               Show this help`;

const REQUIRED_ARTIFACT_KINDS = ["base-input", "evaluation-build", "fact-set", "policy", "result"] as const;
const REQUIRED_ARTIFACT_KIND_SET = new Set<string>(REQUIRED_ARTIFACT_KINDS);
const CONTENT_ADDRESSED_ARTIFACT_KEY = /^([a-z-]+):([a-f0-9]{64})$/;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareText);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isCanonicalUtcDay(value: string): boolean {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function nextUtcDay(value: string): string | null {
  if (!isCanonicalUtcDay(value)) return null;
  return new Date(Date.parse(`${value}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

function addBlocker(
  blockers: SafetyScoreV9ShadowGateBlocker[],
  code: SafetyScoreV9ShadowGateBlockerCode,
  utcDay: string | null,
  detail: string,
): void {
  blockers.push({ code, utcDay, detail });
}

function validArtifactKeys(keys: readonly string[]): boolean {
  if (keys.length !== REQUIRED_ARTIFACT_KINDS.length) return false;
  const kinds = keys.map((key) => CONTENT_ADDRESSED_ARTIFACT_KEY.exec(key)?.[1] ?? null);
  return (
    kinds.every((kind): kind is string => kind !== null && REQUIRED_ARTIFACT_KIND_SET.has(kind)) &&
    new Set(kinds).size === REQUIRED_ARTIFACT_KINDS.length &&
    arraysEqual([...keys], [...keys].sort(compareText))
  );
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return stableJsonStringifyV1(left) === stableJsonStringifyV1(right);
}

function unwrapWranglerRows(input: unknown, label: string): unknown[] {
  if (Array.isArray(input)) {
    if (input.length === 0) return [];
    const wrappers = input.map((value) => WranglerResultEnvelopeSchema.safeParse(value));
    if (wrappers.every((result) => result.success)) {
      return wrappers.flatMap((result) => result.data.results);
    }
    if (wrappers.some((result) => result.success)) {
      throw new Error(`${label} export mixes Wrangler result envelopes with direct rows`);
    }
    return input;
  }
  const wrapper = WranglerResultEnvelopeSchema.safeParse(input);
  if (wrapper.success) return wrapper.data.results;
  throw new Error(`${label} export must be a JSON row array or Wrangler D1 result envelope`);
}

export function parseSafetyScoreV9ShadowSummaryExport(input: unknown): SafetyScoreV9ShadowDaily[] {
  return unwrapWranglerRows(input, "Safety Score v9 shadow summary").map((row, index) => {
    const direct = SafetyScoreV9ShadowDailySchema.safeParse(row);
    if (direct.success) return direct.data;
    const exported = ShadowSummaryExportRowSchema.safeParse(row);
    if (!exported.success) {
      throw new Error(`Safety Score v9 shadow summary row ${index} is neither a daily summary nor a D1 daily_json row`);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(exported.data.daily_json) as unknown;
    } catch {
      throw new Error(`Safety Score v9 shadow summary row ${index} contains malformed daily_json`);
    }
    const summary = SafetyScoreV9ShadowDailySchema.parse(decoded);
    if (stableJsonStringifyV1(summary) !== exported.data.daily_json) {
      throw new Error(`Safety Score v9 shadow summary row ${index} daily_json is not canonical`);
    }
    if (exported.data.utc_day !== undefined && exported.data.utc_day !== summary.utcDay) {
      throw new Error(`Safety Score v9 shadow summary row ${index} utc_day does not match daily_json`);
    }
    return summary;
  });
}

export function parseSafetyScoreV9ArtifactExport(input: unknown): SafetyScoreV9StoredReplayArtifact[] {
  return unwrapWranglerRows(input, "Safety Score v9 replay artifact").map((row, index) => {
    const direct = SafetyScoreV9StoredReplayArtifactSchema.safeParse(row);
    if (direct.success) return direct.data;
    const exported = ReplayArtifactExportRowSchema.safeParse(row);
    if (!exported.success) {
      throw new Error(`Safety Score v9 replay artifact row ${index} is neither a stored artifact nor a D1 row`);
    }
    return SafetyScoreV9StoredReplayArtifactSchema.parse({
      artifactKey: exported.data.artifact_key,
      kind: exported.data.artifact_kind,
      identity: exported.data.identity,
      contentSha256: exported.data.content_sha256,
      encoding: exported.data.encoding,
      uncompressedBytes: exported.data.uncompressed_bytes,
      storedBytes: exported.data.stored_bytes,
      payload: exported.data.payload,
      createdAtSec: exported.data.created_at_sec,
      verifiedAtSec: exported.data.verified_at_sec,
    });
  });
}

/**
 * Verifies exported immutable rows and re-executes every selected candidate.
 * The returned evidence is derived output; the CLI never accepts a claimed
 * replay status from an operator-supplied manifest.
 */
export async function verifySafetyScoreV9ArchivedReplays(input: {
  summaries: readonly SafetyScoreV9ShadowDaily[];
  artifacts: readonly SafetyScoreV9StoredReplayArtifact[];
}): Promise<SafetyScoreV9ArchivedReplayEvidence> {
  const summaries = input.summaries.map((summary) => SafetyScoreV9ShadowDailySchema.parse(summary));
  const artifacts = input.artifacts.map((artifact) => SafetyScoreV9StoredReplayArtifactSchema.parse(artifact));
  const artifactByKey = new Map(artifacts.map((artifact) => [artifact.artifactKey, artifact]));
  if (artifactByKey.size !== artifacts.length) throw new Error("Exported V9 replay artifacts contain duplicate keys");

  const replays: SafetyScoreV9ArchivedReplayEvidenceEntry[] = [];
  for (const summary of summaries.filter((day) => (day.selectedRun?.archiveSelectionReasons.length ?? 0) > 0)) {
    const run = summary.selectedRun!;
    let replayedResultDigest: string | null = null;
    let status: "passed" | "failed" = "failed";
    try {
      if (!validArtifactKeys(run.artifactKeys)) throw new Error("Selected replay artifact keys are incomplete");
      const byKind = new Map<string, Awaited<ReturnType<typeof parseSafetyScoreV9ReplayArtifact>>>();
      const expectedIdentities = {
        "base-input": run.identity.baseInputGenerationId,
        "fact-set": run.identity.factSetDigest,
        policy: run.identity.policyDigest,
        "evaluation-build": run.identity.evaluationBuildDigest,
        result: run.identity.resultDigest,
      } as const;
      for (const artifactKey of run.artifactKeys) {
        const artifact = artifactByKey.get(artifactKey);
        if (!artifact) throw new Error(`Selected replay artifact is missing: ${artifactKey}`);
        byKind.set(
          artifact.kind,
          await parseSafetyScoreV9ReplayArtifact(artifact, {
            expectedKind: artifact.kind,
            expectedIdentity: expectedIdentities[artifact.kind],
          }),
        );
      }

      const baseInput = normalizeFixedInput(byKind.get("base-input")!.value);
      const factSetArtifact = ArchivedFactSetArtifactSchema.parse(byKind.get("fact-set")!.value);
      const policyArtifact = ArchivedPolicyArtifactSchema.parse(byKind.get("policy")!.value);
      const evaluationBuildArtifact = ArchivedEvaluationBuildArtifactSchema.parse(
        byKind.get("evaluation-build")!.value,
      );
      const resultArtifact = ArchivedResultArtifactSchema.parse(byKind.get("result")!.value);
      const policy = loadV9MethodologyPolicy(policyArtifact.policy);
      if (policy.semanticDigest !== policyArtifact.semanticDigest) {
        throw new Error("Archived V9 policy semantic digest does not match its payload");
      }
      if (policy.semanticDigest !== V9_CANDIDATE_POLICY_V1.semanticDigest) {
        throw new Error("Archived V9 policy does not match the current candidate policy digest");
      }
      if (!canonicalEqual(evaluationBuildArtifact.manifest, SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST)) {
        throw new Error("Archived V9 evaluation-build manifest does not match the replay build");
      }

      const releaseCandidateId = /^v9-rc-[1-9][0-9]*$/.test(resultArtifact.candidate.candidateId)
        ? resultArtifact.candidate.candidateId
        : undefined;
      const replay = buildSafetyScoreV9Candidate({
        fixedInput: baseInput,
        extension: factSetArtifact.extension,
        policy,
        publishedAtSec: resultArtifact.candidate.publishedAtSec,
        ...(releaseCandidateId ? { releaseCandidateId } : {}),
      });
      replayedResultDigest = replay.candidate.resultDigest;
      const archivedEnvelope = rebuildSafetyScoreV9ShadowEnvelope({
        candidate: resultArtifact.candidate,
        core: resultArtifact.envelopeCore,
        replayArtifacts: [...byKind.values()].map((artifact) => artifact.reference),
      });
      if (
        !canonicalEqual(replay.fixedInput, baseInput) ||
        !canonicalEqual(replay.extension, factSetArtifact.extension) ||
        !canonicalEqual(replay.compiledFacts, factSetArtifact.compiledFacts) ||
        !canonicalEqual(replay.evaluatedSet, resultArtifact.evaluatedSet) ||
        !canonicalEqual(replay.candidate, resultArtifact.candidate) ||
        replay.candidate.candidateId !== run.identity.candidateId ||
        replay.candidate.policyVersion !== run.identity.policyVersion ||
        replay.candidate.publicationGenerationId !== run.identity.publicationGenerationId ||
        replay.candidate.baseInputGenerationId !== run.identity.baseInputGenerationId ||
        replay.candidate.factSetDigest !== run.identity.factSetDigest ||
        replay.candidate.policy.id !== run.identity.policyId ||
        replay.candidate.policy.semanticDigest !== run.identity.policyDigest ||
        replay.candidate.evaluationBuildDigest !== run.identity.evaluationBuildDigest ||
        !canonicalEqual(replay.candidate.sourceGenerations, run.identity.sourceGenerations) ||
        replay.compilerFactSchemaDigest !== run.identity.compilerFactSchemaDigest ||
        replay.producerCapabilityDigest !== run.identity.producerCapabilityDigest ||
        resultArtifact.envelopeCore.compilerFactSchemaDigest !== run.identity.compilerFactSchemaDigest ||
        resultArtifact.envelopeCore.producerCapabilityDigest !== run.identity.producerCapabilityDigest ||
        resultArtifact.envelopeCore.releaseCoveragePolicyDigest !== run.identity.releaseCoveragePolicyDigest ||
        resultArtifact.envelopeCore.consumerThresholdRegistryDigest !== run.identity.consumerThresholdRegistryDigest ||
        resultArtifact.envelopeCore.releaseCoveragePolicyDigest !== V9_SHADOW_RELEASE_COVERAGE_POLICY_DIGEST ||
        resultArtifact.envelopeCore.consumerThresholdRegistryDigest !== V9_CONSUMER_SCORE_THRESHOLD_REGISTRY_DIGEST ||
        !canonicalEqual(resultArtifact.envelopeCore.coverage, run.coverage) ||
        computeSafetyScoreV9ShadowEnvelopeDigest(archivedEnvelope) !== run.identity.envelopeDigest ||
        replay.candidate.resultDigest !== run.identity.resultDigest
      ) {
        throw new Error("Archived V9 candidate does not reproduce byte-for-byte");
      }
      status = "passed";
    } catch {
      status = "failed";
    }
    replays.push({
      utcDay: summary.utcDay,
      selectionReasons: [...run.archiveSelectionReasons],
      artifactKeys: [...run.artifactKeys],
      expectedResultDigest: run.identity.resultDigest,
      status,
      replayedResultDigest,
    });
  }
  return SafetyScoreV9ArchivedReplayEvidenceSchema.parse({
    schemaVersion: SAFETY_SCORE_V9_ARCHIVED_REPLAY_EVIDENCE_SCHEMA_VERSION,
    replays,
  });
}

function frozenIdentity(run: NonNullable<SafetyScoreV9ShadowDaily["selectedRun"]>) {
  return {
    candidateId: run.identity.candidateId,
    policyId: run.identity.policyId,
    policyVersion: run.identity.policyVersion,
    policyDigest: run.identity.policyDigest,
    evaluationBuildDigest: run.identity.evaluationBuildDigest,
    compilerFactSchemaDigest: run.identity.compilerFactSchemaDigest,
    producerCapabilityDigest: run.identity.producerCapabilityDigest,
    releaseCoveragePolicyDigest: run.identity.releaseCoveragePolicyDigest,
    consumerThresholdRegistryDigest: run.identity.consumerThresholdRegistryDigest,
  };
}

function evaluateDay(
  day: SafetyScoreV9ShadowDaily,
  baseline: ReturnType<typeof frozenIdentity> | null,
  blockers: SafetyScoreV9ShadowGateBlocker[],
): void {
  if (day.attemptCounts.successful < 1) {
    addBlocker(blockers, "no-successful-attempt", day.utcDay, "At least one successful shadow run is required");
  }
  if (day.selectedRun === null) {
    addBlocker(blockers, "selected-run-missing", day.utcDay, "The daily summary has no selected successful run");
    return;
  }

  const run = day.selectedRun;
  if (new Date(run.selectedAtSec * 1_000).toISOString().slice(0, 10) !== day.utcDay) {
    addBlocker(
      blockers,
      "selected-run-day-mismatch",
      day.utcDay,
      "The selected run timestamp does not belong to the summary's UTC day",
    );
  }
  if (baseline !== null) {
    if (run.identity.candidateId !== baseline.candidateId) {
      addBlocker(blockers, "candidate-id-drift", day.utcDay, "The release-candidate ID changed inside the window");
    }
    if (
      run.identity.policyId !== baseline.policyId ||
      run.identity.policyVersion !== baseline.policyVersion ||
      run.identity.policyDigest !== baseline.policyDigest
    ) {
      addBlocker(blockers, "policy-drift", day.utcDay, "The frozen policy identity changed inside the window");
    }
    if (run.identity.evaluationBuildDigest !== baseline.evaluationBuildDigest) {
      addBlocker(
        blockers,
        "evaluation-build-drift",
        day.utcDay,
        "The evaluation-build digest changed inside the window",
      );
    }
    if (run.identity.compilerFactSchemaDigest !== baseline.compilerFactSchemaDigest) {
      addBlocker(
        blockers,
        "compiler-fact-schema-drift",
        day.utcDay,
        "The compiler/fact-schema digest changed inside the window",
      );
    }
    if (run.identity.producerCapabilityDigest !== baseline.producerCapabilityDigest) {
      addBlocker(
        blockers,
        "producer-capability-drift",
        day.utcDay,
        "The producer-capability digest changed inside the window",
      );
    }
    if (run.identity.releaseCoveragePolicyDigest !== baseline.releaseCoveragePolicyDigest) {
      addBlocker(
        blockers,
        "release-coverage-policy-drift",
        day.utcDay,
        "The release-coverage policy digest changed inside the window",
      );
    }
    if (run.identity.consumerThresholdRegistryDigest !== baseline.consumerThresholdRegistryDigest) {
      addBlocker(
        blockers,
        "consumer-threshold-registry-drift",
        day.utcDay,
        "The consumer-threshold registry digest changed inside the window",
      );
    }
  }

  const coverage = run.coverage;
  if (
    coverage.expectedActiveCount === 0 ||
    coverage.expectedActiveCount !== coverage.observedResultCount ||
    coverage.expectedActiveCount !== coverage.presentExpectedCount ||
    coverage.expectedActiveIdsDigest !== coverage.presentExpectedIdsDigest ||
    coverage.missingIds.length > 0 ||
    coverage.unexpectedIds.length > 0 ||
    coverage.duplicateIds.length > 0
  ) {
    addBlocker(
      blockers,
      "active-id-bijection-failed",
      day.utcDay,
      `Active-ID coverage is not exact (expected=${coverage.expectedActiveCount}, observed=${coverage.observedResultCount}, present=${coverage.presentExpectedCount})`,
    );
  }
  const failedFloors = coverage.coverageFloors.filter((floor) => floor.status !== "pass").map((floor) => floor.id);
  const floorIds = coverage.coverageFloors.map((floor) => floor.id);
  if (!arraysEqual(floorIds, SAFETY_SCORE_V9_REQUIRED_SHADOW_COVERAGE_FLOOR_IDS)) {
    addBlocker(
      blockers,
      "coverage-floor-set-mismatch",
      day.utcDay,
      `Coverage floors must exactly match the ratified shadow registry: ${SAFETY_SCORE_V9_REQUIRED_SHADOW_COVERAGE_FLOOR_IDS.join(", ")}`,
    );
  }
  if (failedFloors.length > 0) {
    addBlocker(blockers, "coverage-floor-failed", day.utcDay, `Coverage floors failed: ${failedFloors.join(", ")}`);
  }
  if (coverage.compilerExceptions.length > 0) {
    addBlocker(
      blockers,
      "compiler-exception",
      day.utcDay,
      `Compiler exceptions remain: ${coverage.compilerExceptions.join(", ")}`,
    );
  }
  if (coverage.futureDatedEvidenceIds.length > 0) {
    addBlocker(
      blockers,
      "future-dated-evidence",
      day.utcDay,
      `Future-dated evidence remains: ${coverage.futureDatedEvidenceIds.join(", ")}`,
    );
  }
  if (coverage.publicationRegression) {
    addBlocker(
      blockers,
      "publication-regression",
      day.utcDay,
      "The V9 shadow run blocked or corrupted the active V8 publication",
    );
  }
  if (coverage.unresolvedCriticalMovementIds.length > 0) {
    addBlocker(
      blockers,
      "unresolved-critical-movement",
      day.utcDay,
      `Critical movements remain unresolved: ${coverage.unresolvedCriticalMovementIds.join(", ")}`,
    );
  }
  if (run.movement.pendingReviewCount > 0) {
    addBlocker(
      blockers,
      "unresolved-review",
      day.utcDay,
      `${run.movement.pendingReviewCount} material movement review(s) remain pending`,
    );
  }
  if (coverage.unresolvedReleaseBlockers.length > 0) {
    addBlocker(
      blockers,
      "unresolved-release-blocker",
      day.utcDay,
      `Release blockers remain: ${coverage.unresolvedReleaseBlockers.join(", ")}`,
    );
  }
  if (!run.qualification.qualifies || run.qualification.blockers.length > 0) {
    addBlocker(
      blockers,
      "qualification-failed",
      day.utcDay,
      `Daily qualification failed: ${run.qualification.blockers.join(", ") || "unspecified blocker"}`,
    );
  }
}

export function evaluateSafetyScoreV9ShadowGate(input: {
  summaries: readonly SafetyScoreV9ShadowDaily[];
  replayEvidence: SafetyScoreV9ArchivedReplayEvidence;
}): SafetyScoreV9ShadowGateReport {
  const summaries = input.summaries
    .map((summary) => SafetyScoreV9ShadowDailySchema.parse(summary))
    .sort((left, right) => compareText(left.utcDay, right.utcDay));
  const replayEvidence = SafetyScoreV9ArchivedReplayEvidenceSchema.parse(input.replayEvidence);
  const blockers: SafetyScoreV9ShadowGateBlocker[] = [];

  if (summaries.length < SAFETY_SCORE_V9_SHADOW_GATE_MINIMUM_DAYS) {
    addBlocker(
      blockers,
      "insufficient-day-count",
      null,
      `Expected at least ${SAFETY_SCORE_V9_SHADOW_GATE_MINIMUM_DAYS} daily summaries; received ${summaries.length}`,
    );
  }

  const dayCounts = new Map<string, number>();
  for (const summary of summaries) {
    dayCounts.set(summary.utcDay, (dayCounts.get(summary.utcDay) ?? 0) + 1);
    if (!isCanonicalUtcDay(summary.utcDay)) {
      addBlocker(blockers, "invalid-utc-day", summary.utcDay, "UTC day is not a real canonical calendar date");
    }
  }
  for (const [utcDay, count] of [...dayCounts].sort(([left], [right]) => compareText(left, right))) {
    if (count > 1) addBlocker(blockers, "duplicate-day", utcDay, `Received ${count} summaries for the UTC day`);
  }
  for (let index = 1; index < summaries.length; index += 1) {
    const previous = summaries[index - 1]!;
    const current = summaries[index]!;
    if (previous.utcDay === current.utcDay) continue;
    const expected = nextUtcDay(previous.utcDay);
    if (expected === null || current.utcDay !== expected) {
      addBlocker(
        blockers,
        "calendar-gap",
        current.utcDay,
        `Expected the day after ${previous.utcDay} to be ${expected ?? "a valid UTC day"}`,
      );
    }
  }

  const firstSelectedRun = summaries.find((summary) => summary.selectedRun !== null)?.selectedRun ?? null;
  let finalSelectedRun: SafetyScoreV9ShadowDaily["selectedRun"] = null;
  for (let index = summaries.length - 1; index >= 0; index -= 1) {
    if (summaries[index]!.selectedRun !== null) {
      finalSelectedRun = summaries[index]!.selectedRun;
      break;
    }
  }
  const baseline = firstSelectedRun === null ? null : frozenIdentity(firstSelectedRun);
  for (const summary of summaries) evaluateDay(summary, baseline, blockers);
  if (baseline !== null && baseline.releaseCoveragePolicyDigest !== V9_SHADOW_RELEASE_COVERAGE_POLICY_DIGEST) {
    addBlocker(
      blockers,
      "release-coverage-policy-drift",
      summaries[0]?.utcDay ?? null,
      "The frozen window does not use the current release-coverage policy digest",
    );
  }
  if (baseline !== null && baseline.consumerThresholdRegistryDigest !== V9_CONSUMER_SCORE_THRESHOLD_REGISTRY_DIGEST) {
    addBlocker(
      blockers,
      "consumer-threshold-registry-drift",
      summaries[0]?.utcDay ?? null,
      "The frozen window does not use the current consumer-threshold registry digest",
    );
  }

  const observedWindowSec =
    firstSelectedRun !== null && finalSelectedRun !== null
      ? Math.max(0, finalSelectedRun.selectedAtSec - firstSelectedRun.selectedAtSec)
      : 0;
  const observedProducerCycleCount = Math.floor(
    observedWindowSec / SAFETY_SCORE_V9_SLOWEST_SCORE_BEARING_PRODUCER_INTERVAL_SEC,
  );
  if (observedProducerCycleCount < SAFETY_SCORE_V9_SHADOW_GATE_MINIMUM_PRODUCER_CYCLES) {
    addBlocker(
      blockers,
      "insufficient-producer-cycle-count",
      null,
      `Expected at least ${SAFETY_SCORE_V9_SHADOW_GATE_MINIMUM_PRODUCER_CYCLES} complete cycles of the slowest score-bearing producer; observed ${observedProducerCycleCount}`,
    );
  }

  const firstDay = summaries[0]?.utcDay ?? null;
  const finalDay = summaries.length > 0 ? summaries[summaries.length - 1]!.utcDay : null;
  const firstSelections = summaries.filter((day) => day.selectedRun?.archiveSelectionReasons.includes("first"));
  const finalSelections = summaries.filter((day) => day.selectedRun?.archiveSelectionReasons.includes("final"));
  if (firstSelections.length === 0) {
    addBlocker(blockers, "first-selection-missing", firstDay, "No archived first-day selection was supplied");
  } else if (firstSelections.length !== 1 || firstSelections[0]!.utcDay !== firstDay) {
    addBlocker(
      blockers,
      "first-selection-mismatch",
      firstSelections[0]?.utcDay ?? null,
      "Exactly one first selection must match the start of the supplied window",
    );
  }
  if (finalSelections.length === 0) {
    addBlocker(blockers, "final-selection-missing", finalDay, "No archived final-day selection was supplied");
  } else if (finalSelections.length !== 1 || finalSelections[0]!.utcDay !== finalDay) {
    addBlocker(
      blockers,
      "final-selection-mismatch",
      finalSelections[0]?.utcDay ?? null,
      "Exactly one final selection must match the end of the supplied window",
    );
  }

  const selectedDays = summaries.filter((day) => (day.selectedRun?.archiveSelectionReasons.length ?? 0) > 0);
  for (const day of selectedDays) {
    if (!validArtifactKeys(day.selectedRun!.artifactKeys)) {
      addBlocker(
        blockers,
        "archived-artifact-set-invalid",
        day.utcDay,
        "Archived selections require one sorted content-addressed key for each of the five replay artifacts",
      );
    }
  }
  const producerGenerationEvidence = SAFETY_SCORE_V9_SLOWEST_SCORE_BEARING_SOURCE_KEYS.map((sourceKey) => {
    const observedGenerationCount = new Set(
      summaries.flatMap((day) => {
        const generation = day.selectedRun?.identity.sourceGenerations[sourceKey];
        return generation ? [generation] : [];
      }),
    ).size;
    const archivedGenerationCount = new Set(
      selectedDays.flatMap((day) => {
        const generation = day.selectedRun?.identity.sourceGenerations[sourceKey];
        return generation ? [generation] : [];
      }),
    ).size;
    if (observedGenerationCount < SAFETY_SCORE_V9_SHADOW_GATE_MINIMUM_PRODUCER_CYCLES) {
      addBlocker(
        blockers,
        "insufficient-producer-generation-count",
        null,
        `${sourceKey} supplied ${observedGenerationCount} distinct generation(s); at least ${SAFETY_SCORE_V9_SHADOW_GATE_MINIMUM_PRODUCER_CYCLES} are required`,
      );
    }
    if (archivedGenerationCount < SAFETY_SCORE_V9_SHADOW_GATE_MINIMUM_PRODUCER_CYCLES) {
      addBlocker(
        blockers,
        "insufficient-archived-producer-generation-count",
        null,
        `Archived selections cover ${archivedGenerationCount} distinct ${sourceKey} generation(s); at least ${SAFETY_SCORE_V9_SHADOW_GATE_MINIMUM_PRODUCER_CYCLES} are required`,
      );
    }
    return { sourceKey, observedGenerationCount, archivedGenerationCount };
  });

  const replayCounts = new Map<string, number>();
  for (const replay of replayEvidence.replays) {
    replayCounts.set(replay.utcDay, (replayCounts.get(replay.utcDay) ?? 0) + 1);
  }
  for (const [utcDay, count] of [...replayCounts].sort(([left], [right]) => compareText(left, right))) {
    if (count > 1) {
      addBlocker(blockers, "replay-evidence-duplicate", utcDay, `Received ${count} replay evidence entries`);
    }
  }

  const selectedByDay = new Map(selectedDays.map((day) => [day.utcDay, day]));
  const replayByDay = new Map(replayEvidence.replays.map((replay) => [replay.utcDay, replay]));
  const verifiedReplayDays: string[] = [];
  for (const day of selectedDays) {
    const run = day.selectedRun!;
    const replay = replayByDay.get(day.utcDay);
    if (!replay) {
      addBlocker(blockers, "replay-evidence-missing", day.utcDay, "Archived selection has no replay evidence");
      continue;
    }
    if (replay.status !== "passed") {
      addBlocker(blockers, "replay-evidence-failed", day.utcDay, "Archived replay did not pass");
    }
    const canonicalReplayReasons = sortedUnique(replay.selectionReasons);
    if (
      !arraysEqual(replay.selectionReasons, canonicalReplayReasons) ||
      !arraysEqual(canonicalReplayReasons, run.archiveSelectionReasons)
    ) {
      addBlocker(
        blockers,
        "replay-selection-mismatch",
        day.utcDay,
        "Replay evidence selection reasons do not match the daily summary",
      );
    }
    if (!arraysEqual(replay.artifactKeys, run.artifactKeys)) {
      addBlocker(
        blockers,
        "replay-artifact-mismatch",
        day.utcDay,
        "Replay evidence does not use the selected content-addressed artifacts",
      );
    }
    if (
      replay.expectedResultDigest !== run.identity.resultDigest ||
      replay.replayedResultDigest !== run.identity.resultDigest
    ) {
      addBlocker(
        blockers,
        "replay-result-mismatch",
        day.utcDay,
        "Archived replay result does not reproduce the selected result digest",
      );
    }
    if (
      replay.status === "passed" &&
      arraysEqual(replay.selectionReasons, canonicalReplayReasons) &&
      arraysEqual(canonicalReplayReasons, run.archiveSelectionReasons) &&
      arraysEqual(replay.artifactKeys, run.artifactKeys) &&
      replay.expectedResultDigest === run.identity.resultDigest &&
      replay.replayedResultDigest === run.identity.resultDigest
    ) {
      verifiedReplayDays.push(day.utcDay);
    }
  }
  for (const replay of replayEvidence.replays) {
    if (!selectedByDay.has(replay.utcDay)) {
      addBlocker(
        blockers,
        "replay-evidence-unexpected",
        replay.utcDay,
        "Replay evidence does not correspond to an archived first, final, or anomaly selection",
      );
    }
  }

  const requiredReplayDays = selectedDays.map((day) => ({
    utcDay: day.utcDay,
    selectionReasons: [...day.selectedRun!.archiveSelectionReasons],
    resultDigest: day.selectedRun!.identity.resultDigest,
  }));
  return {
    schemaVersion: 1,
    decision: blockers.length === 0 ? "gate-passed" : "no-go",
    minimumDayCount: SAFETY_SCORE_V9_SHADOW_GATE_MINIMUM_DAYS,
    observedDayCount: summaries.length,
    minimumProducerCycleCount: SAFETY_SCORE_V9_SHADOW_GATE_MINIMUM_PRODUCER_CYCLES,
    slowestScoreBearingProducerIntervalSec: SAFETY_SCORE_V9_SLOWEST_SCORE_BEARING_PRODUCER_INTERVAL_SEC,
    observedProducerCycleCount,
    observedWindowSec,
    producerGenerationEvidence,
    windowStartUtcDay: firstDay,
    windowEndUtcDay: finalDay,
    frozenIdentity: baseline,
    requiredReplayDays,
    verifiedReplayDays: sortedUnique(verifiedReplayDays),
    blockers,
  };
}

export interface SafetyScoreV9ShadowGateIo {
  readJson(path: string): unknown;
  stdout: { write(text: string): unknown };
  verifyReplays?(
    summaries: readonly SafetyScoreV9ShadowDaily[],
    artifacts: readonly SafetyScoreV9StoredReplayArtifact[],
  ): Promise<SafetyScoreV9ArchivedReplayEvidence>;
}

const DEFAULT_IO: SafetyScoreV9ShadowGateIo = {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- explicit local operator input path.
  readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
  stdout: process.stdout,
};

export async function runSafetyScoreV9ShadowGateCli(
  argv: readonly string[],
  io: SafetyScoreV9ShadowGateIo = DEFAULT_IO,
): Promise<SafetyScoreV9ShadowGateReport | null> {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      summaries: { type: "string" },
      artifacts: { type: "string" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE, io.stdout)) return null;
  assertCliUsage(typeof values.summaries === "string", "--summaries is required");
  assertCliUsage(typeof values.artifacts === "string", "--artifacts is required");

  const summaries = parseSafetyScoreV9ShadowSummaryExport(io.readJson(values.summaries));
  const artifacts = parseSafetyScoreV9ArtifactExport(io.readJson(values.artifacts));
  const replayEvidence = await (
    io.verifyReplays ?? ((days, rows) => verifySafetyScoreV9ArchivedReplays({ summaries: days, artifacts: rows }))
  )(summaries, artifacts);
  const report = evaluateSafetyScoreV9ShadowGate({ summaries, replayEvidence });
  io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.decision !== "gate-passed") {
    throw new Error(`Safety Score v9 shadow gate is no-go (${report.blockers.length} blocker(s))`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCliEntrypoint(() => runSafetyScoreV9ShadowGateCli(process.argv.slice(2)), {
    label: "safety-score-v9:shadow-gate",
    usage: USAGE,
  });
}
