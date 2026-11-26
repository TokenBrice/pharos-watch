import { toErrorMessage } from "@shared/lib/error-utils";
import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v9/evaluation-build-manifest-v1";
import { computeReportCardsRegistryFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import { applySafetyScoreV9GradeHysteresis } from "@shared/lib/safety-score-v9/grade-hysteresis";
import {
  assertV9ValidatedPolicyEnvelope,
  loadV9CandidateMethodologyPolicy,
} from "@shared/lib/safety-score-v9/policy";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import { sha256HexFromUtf8Chunks } from "../hash";
import { stableJsonStringifyChunksV1 } from "@shared/lib/stable-json";
import type { V9DocumentationClassification } from "@shared/lib/safety-score-v9/documentation";
import type { V9DependencyEvaluationPlan } from "@shared/lib/safety-score-v9/dependencies";
import type { V9StructuralSignal } from "@shared/types/safety-score-v9";
import type { V9FactSetCoreV3 } from "@shared/types/safety-score-v9-facts";
import type { V9PublicationHealth, V9PublicationHoldReason } from "@shared/types/report-cards-v9";
import { V9_MINIMUM_RATEABLE_ASSETS } from "@shared/types/safety-score-v9-coverage";
import type { V9LaneEmitterDescriptor, V9LaneIncidentCertificate } from "@shared/types/safety-score-v9-incidents";
import type { V9ContinuationMessage } from "@shared/types/v9-continuation";
import { throwIfAborted } from "../abort";
import { persistAlertSafetyV9SourceEnvelope } from "../alert-safety-source-cache";
import { executeAtomicBatch } from "../db";
import { runWithOverloadRetry } from "../d1-overload-retry";
import { buildSafetyScoreV9PublicationIdentity } from "../report-cards-v9-cache";
import { logWorkerEvent } from "../structured-log";
import { loadSafetyScoreV9AcceptedBaselineState } from "./accepted-projection-readers";
import { buildSafetyScoreV9AcceptedProjections } from "./accepted-projections";
import { archiveSafetyScoreCapture } from "./capture-archive";
import { measuredExitExpiryMessage, v9PolicyVersion, type SafetyScoreV9BridgeJoinDiagnostic } from "./candidate";
import {
  assembleV9ChunkedCandidate,
  compileV9ChunkAssets,
  planV9ChunkedEvaluation,
  evaluateV9Chunk,
  V9_EVAL_DEFAULT_MAX_CHUNK_ASSETS,
  type V9EvalCardShardPayload,
  type V9EvalChunkSummaryPayload,
  type V9EvalUpstreamStatePayload,
} from "./chunked-eval-plan";
import {
  buildNextV9ContinuationMessage,
  buildWriteV9EvalChunkStatements,
  claimActiveV9EvalRunForCronResume,
  confirmV9EvalRunOwnership,
  loadLatestActiveV9EvalRun,
  markV9EvalRunCompletedAndPrune,
  markV9EvalRunFailedAndPrune,
  readV9EvalChunk,
  supersedeActiveV9EvalRuns,
  sweepStaleV9EvalRuns,
  workerVersionsMatch,
  writeV9EvalChunk,
  type V9EvalChunkWriteFence,
  type V9EvalRunRow,
} from "./chunked-eval-store";
import type { LaneIncidentCertificateView } from "./extension-incidents";
import type { V9AssetQuarantine } from "./fact-set";
import { loadReviewedLaneEmitterCatalog } from "./lane-emitter-catalog";
import { loadLaneIncidentCertificates } from "./lane-incident-certificate-store";
import {
  withNormalizedV9JournalProjections,
  type SafetyScoreV9CompilerInput,
} from "./native-input";
import {
  assessV9Publication,
  expiredMeasuredExitAssetIdsFromRoutes,
  projectExpiredMeasuredExitRoutes,
  resolveMeasuredExitExpiry,
  type SafetyScoreV9AcceptedPublicationBaseline,
  type SafetyScoreV9DexExpiryWitness,
  type SafetyScoreV9ExpiredMeasuredExitRoutes,
  type SafetyScoreV9VerifiedEmptyExitWitness,
  type V9PublicationAssessment,
  type V9PublicationCoverageFloor,
  type V9PublicationInputHealth,
} from "./publication-assessment";
import type { V9PublicationAttempt } from "./publication-attempts";
import { safeFailure, SafetyScoreV9AcceptedBaselineProjectionError } from "./publication-failure";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "./publication-health";
import { journalSafetyScorePublication } from "./publication-journal";
import { retryPendingSafetyScoreV9PublicMaterialization } from "./publication-materialization";
import {
  buildSafetyScoreV9PublicationReplayCapture,
  SafetyScoreV9ReplayCaptureIdentityError,
  type SafetyScoreV9ReplayCaptureInput,
} from "./publication-replay-capture";
import { persistSafetyScoreV9Publication } from "./publication-store";
import type { SafetyScoreV9TransferMaterialityGeneration } from "./transfer-materiality";

const RUN_CONTEXT_HEADER_INDEX = 0;
const RUN_CONTEXT_PINNED_INPUT_INDEX = 1;
const RUN_CONTEXT_COMMIT_INDEX = 2;
const RUN_CONTEXT_DOC_GAPS_INDEX = 3;
const RUN_CONTEXT_REPLAY_INDEX = 4;

export interface V9EvalRunContextHeader {
  schemaVersion: 1;
  runId: string;
  quarantineEpoch: number;
  clockSec: number;
  policyVersion: string;
  factSetDigest: string;
  baseInputGenerationId: string;
  evaluationBuildDigest: string;
  sourceGenerations: Readonly<Record<string, string>>;
  compilerFactSchemaDigest: string;
  producerCapabilityDigest: string;
  dexExitRouteMaxAgeSec: number;
  dependencyPlan: Readonly<V9DependencyEvaluationPlan>;
  factSetHeader: Omit<V9FactSetCoreV3, "assets">;
  marketRanks: Readonly<Record<string, number>>;
  commonModeSignals: Readonly<Record<string, readonly V9StructuralSignal[]>>;
  chunkAssetIds: string[][];
  exportedUpstreamsByChunk: string[][];
  requiredPriorChunksByChunk: number[][];
  sortedGlobalAssetIds: string[];
  evaluationFailures: Array<[string, string]>;
  expiryWitnesses: Array<[string, SafetyScoreV9DexExpiryWitness[]]>;
  quarantines: readonly V9AssetQuarantine[];
  quarantineAffectedAssetIds: readonly string[];
  maxChunkAssets: number;
  deferPublicMaterialization: boolean;
  hasFixedInputCacheValue: boolean;
}

export interface V9EvalPinnedInputBlob {
  schemaVersion: 1;
  fixedInput: SafetyScoreV9CompilerInput;
}

export interface V9EvalReplayInputBlob {
  schemaVersion: 1;
  replayInput: SafetyScoreV9ReplayCaptureInput;
  fixedInputCacheValue: string;
}

export interface V9EvalCumulativeDocGapsBlob {
  schemaVersion: 1;
  completedThroughChunkIndex: number;
  entries: Array<[string, V9DocumentationClassification]>;
}

interface SerializedExpiredMeasuredExitRoutes {
  clockSec: number;
  dexGenerationId: string;
  windowsByAssetId: Array<[string, Array<[string, { observationWindowEndedAt: number; freshnessMaxSec: number }]>]>;
  byAssetId: Array<[string, string[]]>;
}

export interface V9EvalCommitContextBlob {
  schemaVersion: 1;
  previousHealth: V9PublicationHealth | null;
  expiredRoutes: SerializedExpiredMeasuredExitRoutes;
  verifiedEmptyExitByAssetId?: Readonly<Record<string, SafetyScoreV9VerifiedEmptyExitWitness>>;
  transferMaterialityGeneration: SafetyScoreV9TransferMaterialityGeneration | null;
  laneIncidentCertificates: Array<[string, { screeningSetId: string; certificate: V9LaneIncidentCertificate }]>;
  laneEmitterDescriptors: readonly V9LaneEmitterDescriptor[];
  laneCertificateWarnings: string[];
  bridgeJoinDiagnostics: readonly SafetyScoreV9BridgeJoinDiagnostic[];
  inputHealth: V9PublicationInputHealth;
  activeAssetCount: number;
  sourceGeneration: string;
  baseInputGenerationId: string;
  dexGenerationId: string;
  redemptionGenerationId: string;
  registryFingerprint: string;
  inputFreshness: SafetyScoreV9CompilerInput["inputFreshness"];
}

export interface V9MaterializeHeaderBlob {
  schemaVersion: 1;
  publicationGenerationId: string;
  payloadSha256: string | null;
  publishedAtSec: number;
}

function serializeExpiredRoutes(routes: SafetyScoreV9ExpiredMeasuredExitRoutes): SerializedExpiredMeasuredExitRoutes {
  return {
    clockSec: routes.clockSec,
    dexGenerationId: routes.dexGenerationId,
    windowsByAssetId: [...routes.windowsByAssetId.entries()].map(([assetId, windows]) => [
      assetId,
      [...windows.entries()],
    ]),
    byAssetId: [...routes.byAssetId.entries()],
  };
}

function deserializeExpiredRoutes(serialized: SerializedExpiredMeasuredExitRoutes): SafetyScoreV9ExpiredMeasuredExitRoutes {
  return {
    clockSec: serialized.clockSec,
    dexGenerationId: serialized.dexGenerationId,
    windowsByAssetId: new Map(
      serialized.windowsByAssetId.map(([assetId, entries]) => [assetId, new Map(entries)]),
    ),
    byAssetId: new Map(serialized.byAssetId),
  };
}

function observationCoverageFloors(
  observedCount: number,
  expectedCount: number,
  rateableCount: number,
): V9PublicationCoverageFloor[] {
  const exactCount = observedCount === expectedCount;
  return [
    {
      id: "active-result-count",
      status: exactCount ? "pass" : "fail",
      observed: observedCount,
      required: `= ${expectedCount}`,
      detail: exactCount
        ? "The V9 publication contains one result for every active asset"
        : "The V9 publication result count does not match the active registry",
    },
    {
      id: "minimum-rateable-assets",
      status: rateableCount >= V9_MINIMUM_RATEABLE_ASSETS ? "pass" : "fail",
      observed: rateableCount,
      required: `>= ${V9_MINIMUM_RATEABLE_ASSETS}`,
      detail:
        rateableCount >= V9_MINIMUM_RATEABLE_ASSETS
          ? "The V9 publication meets the active-asset rateability floor"
          : "The V9 publication is below the active-asset rateability floor",
    },
  ];
}

function heldPublicationHealth(args: {
  attemptedAtSec: number;
  reasons: V9PublicationHoldReason[];
  acceptedPublication: SafetyScoreV9AcceptedPublicationBaseline | null;
  previousHealth: V9PublicationHealth | null;
}): V9PublicationHealth {
  return {
    schemaVersion: 2,
    status: "held",
    acceptedPublicationGenerationId:
      args.acceptedPublication?.publicationGenerationId ??
      args.previousHealth?.acceptedPublicationGenerationId ??
      null,
    acceptedAtSec:
      args.acceptedPublication?.publishedAtSec ??
      args.previousHealth?.acceptedAtSec ??
      null,
    attemptedAtSec: args.attemptedAtSec,
    heldSinceSec:
      args.previousHealth?.status === "held" ? args.previousHealth.heldSinceSec : args.attemptedAtSec,
    reasons: args.reasons,
  };
}

function publicationAttempt(args: {
  attemptedAtSec: number;
  outcome: V9PublicationAttempt["outcome"];
  publicationGenerationId: string | null;
  quarantines: readonly V9AssetQuarantine[];
  affectedAssetIds: readonly string[];
}): V9PublicationAttempt {
  return {
    schemaVersion: 1,
    attemptedAtSec: args.attemptedAtSec,
    outcome: args.outcome,
    publicationGenerationId: args.publicationGenerationId,
    quarantines: [...args.quarantines],
    affectedAssetIds: [...args.affectedAssetIds],
  };
}

export function currentV9PolicyDigestForClock(clockSec: number): string {
  const policy = loadV9CandidateMethodologyPolicy(clockSec);
  assertV9ValidatedPolicyEnvelope(policy);
  return policy.semanticDigest;
}

function extractReplayCaptureInput(fixedInput: Readonly<SafetyScoreV9CompilerInput>): SafetyScoreV9ReplayCaptureInput {
  return {
    baseInputGenerationId: fixedInput.baseInputGenerationId,
    clockSec: fixedInput.clockSec,
    safetyScoreV9SupplyAttributionById: fixedInput.safetyScoreV9SupplyAttributionById,
    evidenceJournalById: fixedInput.evidenceJournalById,
    supplyAttributionJournalById: fixedInput.supplyAttributionJournalById,
    pegProvenanceById: fixedInput.pegProvenanceById,
    pipelineGapByAssetId: fixedInput.pipelineGapByAssetId,
  };
}

function buildEpochStageArtifacts(input: {
  runId: string;
  quarantineEpoch: number;
  fixedInput: Readonly<SafetyScoreV9CompilerInput>;
  verifiedEmptyExitByAssetId?: V9EvalCommitContextBlob["verifiedEmptyExitByAssetId"];
  previousHealth: V9PublicationHealth | null;
  transferMaterialityGeneration: SafetyScoreV9TransferMaterialityGeneration | null;
  laneIncidentCertificates: ReadonlyMap<string, LaneIncidentCertificateView>;
  laneEmitterDescriptors: readonly V9LaneEmitterDescriptor[];
  laneCertificateWarnings: readonly string[];
  evaluationFailures: ReadonlyMap<string, string>;
  expiryWitnesses: ReadonlyMap<string, SafetyScoreV9DexExpiryWitness[]>;
  maxChunkAssets: number;
  deferPublicMaterialization: boolean;
  hasFixedInputCacheValue: boolean;
}): {
  header: V9EvalRunContextHeader;
  commitContext: V9EvalCommitContextBlob;
  policyDigest: string;
  planDigest: string;
  factSetDigest: string;
} {
  const clockSec = input.fixedInput.clockSec;
  const policy = loadV9CandidateMethodologyPolicy(clockSec);
  assertV9ValidatedPolicyEnvelope(policy);
  const policyVersion = v9PolicyVersion(policy);

  const { verifiedEmptyExitByAssetId } = input;
  const plan = planV9ChunkedEvaluation({
    fixedInput: input.fixedInput,
    policy,
    extensionOptions: {
      transferMaterialityGeneration: input.transferMaterialityGeneration,
      laneIncidentCertificates: input.laneIncidentCertificates,
      laneEmitterDescriptors: input.laneEmitterDescriptors,
    },
    evaluationFailures: input.evaluationFailures,
    verifiedEmptyExitByAssetId,
    maxChunkAssets: input.maxChunkAssets,
  });

  const header: V9EvalRunContextHeader = {
    schemaVersion: 1,
    runId: input.runId,
    quarantineEpoch: input.quarantineEpoch,
    clockSec,
    policyVersion,
    factSetDigest: plan.factSetDigest,
    baseInputGenerationId: plan.factSetHeader.baseInputGenerationId,
    evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
    sourceGenerations: plan.sourceGenerations,
    compilerFactSchemaDigest: plan.compilerFactSchemaDigest,
    producerCapabilityDigest: plan.producerCapabilityDigest,
    dexExitRouteMaxAgeSec: plan.dexExitRouteMaxAgeSec,
    dependencyPlan: plan.dependencyPlan,
    factSetHeader: plan.factSetHeader,
    marketRanks: plan.marketRanks,
    commonModeSignals: plan.commonModeSignals,
    chunkAssetIds: plan.partition.chunks,
    exportedUpstreamsByChunk: plan.partition.exportedUpstreamsByChunk,
    requiredPriorChunksByChunk: plan.partition.requiredPriorChunksByChunk,
    sortedGlobalAssetIds: plan.factSetHeader.activeAssetIds,
    evaluationFailures: [...input.evaluationFailures.entries()].sort(([a], [b]) => compareText(a, b)),
    expiryWitnesses: [...input.expiryWitnesses.entries()].sort(([a], [b]) => compareText(a, b)),
    quarantines: plan.quarantines,
    quarantineAffectedAssetIds: plan.quarantineAffectedAssetIds,
    maxChunkAssets: input.maxChunkAssets,
    deferPublicMaterialization: input.deferPublicMaterialization,
    hasFixedInputCacheValue: input.hasFixedInputCacheValue,
  };

  const commitContext: V9EvalCommitContextBlob = {
    schemaVersion: 1,
    previousHealth: input.previousHealth,
    expiredRoutes: serializeExpiredRoutes(projectExpiredMeasuredExitRoutes(input.fixedInput)),
    ...(verifiedEmptyExitByAssetId === undefined ? {} : { verifiedEmptyExitByAssetId }),
    transferMaterialityGeneration: input.transferMaterialityGeneration,
    laneIncidentCertificates: [...input.laneIncidentCertificates.entries()].sort(([a], [b]) => compareText(a, b)),
    laneEmitterDescriptors: input.laneEmitterDescriptors,
    laneCertificateWarnings: [...input.laneCertificateWarnings],
    bridgeJoinDiagnostics: plan.bridgeJoinDiagnostics,
    inputHealth: input.fixedInput.v9PublicationInputHealth,
    activeAssetCount: input.fixedInput.activeAssetIds.length,
    sourceGeneration: input.fixedInput.sourceGeneration,
    baseInputGenerationId: input.fixedInput.baseInputGenerationId,
    dexGenerationId: input.fixedInput.dexGenerationId,
    redemptionGenerationId: input.fixedInput.redemptionGenerationId,
    registryFingerprint: input.fixedInput.registryFingerprint,
    inputFreshness: input.fixedInput.inputFreshness,
  };

  return {
    header,
    commitContext,
    policyDigest: policy.semanticDigest,
    planDigest: plan.dependencyPlan.planDigest,
    factSetDigest: plan.factSetDigest,
  };
}

async function persistEpochStagingChunks(
  db: D1Database,
  input: {
    runId: string;
    quarantineEpoch: number;
    header: V9EvalRunContextHeader;
    commitContext: V9EvalCommitContextBlob;
    nowSec: number;
    fence: V9EvalChunkWriteFence;
    signal?: AbortSignal;
  },
): Promise<{ totalChunkBytes: number }> {
  let totalChunkBytes = 0;
  const headerWrite = await writeV9EvalChunk(
    db,
    {
      runId: input.runId,
      chunkKind: "run_context",
      chunkIndex: RUN_CONTEXT_HEADER_INDEX,
      quarantineEpoch: input.quarantineEpoch,
      value: input.header,
      createdAt: input.nowSec,
      fence: input.fence,
    },
    input.signal,
  );
  totalChunkBytes += headerWrite.totalBytes;

  const commitWrite = await writeV9EvalChunk(
    db,
    {
      runId: input.runId,
      chunkKind: "run_context",
      chunkIndex: RUN_CONTEXT_COMMIT_INDEX,
      quarantineEpoch: input.quarantineEpoch,
      value: input.commitContext,
      createdAt: input.nowSec,
      fence: input.fence,
    },
    input.signal,
  );
  totalChunkBytes += commitWrite.totalBytes;

  return { totalChunkBytes };
}

export interface SeedChunkedV9EvaluationInput {
  db: D1Database;
  fixedInput: Readonly<SafetyScoreV9CompilerInput>;
  fixedInputCacheValue?: string;
  transferMaterialityGeneration: SafetyScoreV9TransferMaterialityGeneration | null;
  slotStartedAt: number;
  sourceInvocationId: string;
  workerVersion: string | null;
  deferPublicMaterialization: boolean;
  maxChunkAssets?: number;
  signal?: AbortSignal;
}

export interface SeedChunkedV9EvaluationResult {
  runId: string;
  chunkCount: number;
  factSetDigest: string;
  planDigest: string;
  policyDigest: string;
  sweptRunIds: string[];
  supersededRunIds: string[];
  totalStagedBytes: number;
  nextMessage: V9ContinuationMessage;
}

/**
 * ADR-26 Seed stage (`:22` or fresh `:52` when `WORKER_V9_QUEUE_MODE = "on"`).
 * Sweeps stale `> 1h` runs, pins one immutable evaluation snapshot in
 * `v9_eval_runs` + bounded `<= 512 KiB` `v9_eval_chunks`, and returns the
 * first continuation hint to send after lease settlement.
 */
export async function seedChunkedV9Evaluation(
  input: SeedChunkedV9EvaluationInput,
): Promise<SeedChunkedV9EvaluationResult> {
  throwIfAborted(input.signal);
  const workerVersion = input.workerVersion?.trim() || null;
  if (!workerVersion) {
    throw new Error("V9 chunked evaluation requires non-empty workerVersion metadata");
  }
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1_000);
  const swept = await sweepStaleV9EvalRuns(input.db, nowSec, nowMs, input.signal);

  const { acceptedBaselineSha256, acceptedPublicationGenerationId, previousHealth, verifiedEmptyExitByAssetId } = await (async () => {
    const state = await loadSafetyScoreV9AcceptedBaselineState(input.db, input.signal);
    if (state.kind === "unavailable") {
      throw new SafetyScoreV9AcceptedBaselineProjectionError(state.reason);
    }
    const baseline = state.kind === "accepted" ? state.projection.baseline : null;
    return {
      acceptedBaselineSha256: baseline === null ? null : sha256HexFromUtf8Chunks(stableJsonStringifyChunksV1(baseline)),
      acceptedPublicationGenerationId: baseline?.publicationGenerationId ?? null,
      previousHealth: state.health,
      verifiedEmptyExitByAssetId: baseline?.verifiedEmptyExitByAssetId,
    };
  })();

  const laneIncidentCertificates = new Map<string, LaneIncidentCertificateView>();
  const { descriptors: laneEmitterDescriptors, reasons: laneCertificateWarnings } = loadReviewedLaneEmitterCatalog();
  try {
    const reads = await loadLaneIncidentCertificates(
      input.db,
      laneEmitterDescriptors.map((descriptor) => ({
        deploymentKey: descriptor.subjectDeploymentKey,
        screeningSetId: descriptor.screeningSetId,
      })),
      { nowSec: input.fixedInput.clockSec, signal: input.signal },
    );
    for (const [deploymentKey, read] of reads) {
      if (read.state !== "current") {
        laneCertificateWarnings.push(`lane-incident-certificate-${read.state}:${deploymentKey}`);
        continue;
      }
      laneIncidentCertificates.set(deploymentKey, {
        screeningSetId: read.screeningSetId,
        certificate: read.certificate,
      });
    }
  } catch (error) {
    if (input.signal?.aborted) throw error;
    laneIncidentCertificates.clear();
    laneCertificateWarnings.push(`lane-incident-certificates-unavailable:${toErrorMessage(error).slice(0, 120)}`);
  }

  const normalizedInput = withNormalizedV9JournalProjections(input.fixedInput);
  const runId = `v9-eval:${input.slotStartedAt}:${normalizedInput.baseInputGenerationId.slice(0, 16)}:${crypto.randomUUID().slice(0, 8)}`;
  const maxChunkAssets = input.maxChunkAssets ?? V9_EVAL_DEFAULT_MAX_CHUNK_ASSETS;
  const artifacts = buildEpochStageArtifacts({
    runId,
    quarantineEpoch: 0,
    fixedInput: normalizedInput,
    verifiedEmptyExitByAssetId,
    previousHealth,
    transferMaterialityGeneration: input.transferMaterialityGeneration,
    laneIncidentCertificates,
    laneEmitterDescriptors,
    laneCertificateWarnings,
    evaluationFailures: new Map(),
    expiryWitnesses: new Map(),
    maxChunkAssets,
    deferPublicMaterialization: input.deferPublicMaterialization,
    hasFixedInputCacheValue: input.fixedInputCacheValue !== undefined,
  });

  const supersededRunIds = await supersedeActiveV9EvalRuns(input.db, runId, nowSec, input.signal);

  const planMetadata = JSON.stringify({
    chunkCount: artifacts.header.chunkAssetIds.length,
    chunkSizes: artifacts.header.chunkAssetIds.map((ids) => ids.length),
    maxChunkAssets,
    activeAssets: normalizedInput.activeAssetIds.length,
  });

  await executeAtomicBatch(
    input.db,
    [
      input.db.prepare(
        `INSERT INTO v9_eval_runs (
          run_id, schema_version, schedule_key, slot_started_at, clock_sec,
          source_generation, base_input_generation_id, registry_fingerprint,
          evaluation_build_digest, worker_version,
          accepted_baseline_generation_id, accepted_baseline_sha256,
          dex_generation_id, redemption_generation_id,
          fact_set_digest, plan_digest, policy_digest,
          quarantine_epoch, chunk_count, next_chunk_index,
          materialize_step_count, next_materialize_step,
          stage, state, execution_generation, execution_owner,
          plan_metadata_json, created_at, updated_at
        ) VALUES (
          ?, 1, 'v9PublicationOffset', ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?,
          ?, ?,
          ?, ?, ?,
          0, ?, 0,
          0, 0,
          'seeded', 'active', 1, ?,
          ?, ?, ?
        )`,
      ).bind(
        runId,
        input.slotStartedAt,
        normalizedInput.clockSec,
        normalizedInput.sourceGeneration,
        normalizedInput.baseInputGenerationId,
        normalizedInput.registryFingerprint,
        SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
        workerVersion,
        acceptedPublicationGenerationId,
        acceptedBaselineSha256,
        normalizedInput.dexGenerationId,
        normalizedInput.redemptionGenerationId,
        artifacts.factSetDigest,
        artifacts.planDigest,
        artifacts.policyDigest,
        artifacts.header.chunkAssetIds.length,
        input.sourceInvocationId,
        planMetadata,
        nowSec,
        nowSec,
      ),
    ],
    { signal: input.signal },
  );

  const seedFence: V9EvalChunkWriteFence = { executionGeneration: 1, expectedQuarantineEpoch: 0 };
  try {
    const pinnedWrite = await writeV9EvalChunk(
      input.db,
      {
        runId,
        chunkKind: "run_context",
        chunkIndex: RUN_CONTEXT_PINNED_INPUT_INDEX,
        quarantineEpoch: 0,
        value: {
          schemaVersion: 1,
          fixedInput: normalizedInput,
        } satisfies V9EvalPinnedInputBlob,
        createdAt: nowSec,
        fence: seedFence,
      },
      input.signal,
    );
    let replayBytes = 0;
    if (input.fixedInputCacheValue !== undefined) {
      const replayWrite = await writeV9EvalChunk(
        input.db,
        {
          runId,
          chunkKind: "run_context",
          chunkIndex: RUN_CONTEXT_REPLAY_INDEX,
          quarantineEpoch: 0,
          value: {
            schemaVersion: 1,
            replayInput: extractReplayCaptureInput(normalizedInput),
            fixedInputCacheValue: input.fixedInputCacheValue,
          } satisfies V9EvalReplayInputBlob,
          createdAt: nowSec,
          fence: seedFence,
        },
        input.signal,
      );
      replayBytes = replayWrite.totalBytes;
    }
    const epochWrite = await persistEpochStagingChunks(input.db, {
      runId,
      quarantineEpoch: 0,
      header: artifacts.header,
      commitContext: artifacts.commitContext,
      nowSec,
      fence: seedFence,
      signal: input.signal,
    });
    const transition = await runWithOverloadRetry(
      () =>
        input.db.batch([
          input.db.prepare(
            `UPDATE v9_eval_runs
                SET stage = 'evaluating',
                    next_chunk_index = 0,
                    updated_at = ?
              WHERE run_id = ?
                AND state = 'active'
                AND stage = 'seeded'
                AND execution_generation = 1
                AND worker_version = ?`,
          ).bind(nowSec, runId, workerVersion),
        ]),
      3,
      input.signal,
    );
    if (transition[0]?.meta.changes !== 1) {
      throw new Error(`V9 eval run ${runId} lost ownership before entering evaluating stage`);
    }

    const nextMessage = buildNextV9ContinuationMessage(
      {
        run_id: runId,
        slot_started_at: input.slotStartedAt,
        stage: "evaluating",
        next_chunk_index: 0,
        quarantine_epoch: 0,
        execution_generation: 1,
        evaluation_build_digest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
        registry_fingerprint: normalizedInput.registryFingerprint,
        policy_digest: artifacts.policyDigest,
      },
      input.sourceInvocationId,
    )!;

    return {
      runId,
      chunkCount: artifacts.header.chunkAssetIds.length,
      factSetDigest: artifacts.factSetDigest,
      planDigest: artifacts.planDigest,
      policyDigest: artifacts.policyDigest,
      sweptRunIds: swept.sweptRunIds,
      supersededRunIds,
      totalStagedBytes: pinnedWrite.totalBytes + replayBytes + epochWrite.totalChunkBytes,
      nextMessage,
    };
  } catch (error) {
    await markV9EvalRunFailedAndPrune(
      input.db,
      runId,
      `seed-failed:${toErrorMessage(error).slice(0, 200)}`,
      Math.floor(Date.now() / 1_000),
      undefined,
      { expectedGeneration: 1, expectedQuarantineEpoch: 0 },
    ).catch(() => undefined);
    throw error;
  }
}

async function abortRunFenced(
  db: D1Database,
  run: V9EvalRunRow,
  stage: "eval" | "commit",
  reason: string,
  signal?: AbortSignal,
): Promise<Extract<V9ChunkedStageStepResult, { status: "aborted" }>> {
  const marked = await markV9EvalRunFailedAndPrune(
    db,
    run.run_id,
    reason,
    Math.floor(Date.now() / 1_000),
    signal,
    { expectedGeneration: run.execution_generation, expectedQuarantineEpoch: run.quarantine_epoch },
  );
  if (!marked) throw new Error(`V9 eval run ${run.run_id} lost ownership handling ${reason}`);
  return { status: "aborted", stage, reason, nextMessage: null };
}

function failRunOnMissingBlob(
  db: D1Database,
  run: V9EvalRunRow,
  stage: "eval" | "commit",
  blobName: string,
  signal?: AbortSignal,
): Promise<Extract<V9ChunkedStageStepResult, { status: "aborted" }>> {
  return abortRunFenced(db, run, stage, `missing-staging-blob:${blobName}`, signal);
}

async function requireRunOwnership(
  db: D1Database,
  run: V9EvalRunRow,
  expectedStage: "committing",
  workerVersion: string,
  nowSec: number,
  action: string,
  signal?: AbortSignal,
): Promise<void> {
  const owned = await confirmV9EvalRunOwnership(
    db,
    {
      runId: run.run_id,
      expectedStage,
      expectedGeneration: run.execution_generation,
      expectedQuarantineEpoch: run.quarantine_epoch,
      workerVersion,
      nowSec,
    },
    signal,
  );
  if (!owned) throw new Error(`V9 eval run ${run.run_id} lost ownership ${action}`);
}

async function completeRunOrThrow(
  db: D1Database,
  run: V9EvalRunRow,
  publicationGenerationId: string | null,
  payloadSha256: string | null,
  nowSec: number,
  action: string,
  signal?: AbortSignal,
): Promise<void> {
  const completed = await markV9EvalRunCompletedAndPrune(
    db,
    { runId: run.run_id, expectedGeneration: run.execution_generation, publicationGenerationId, payloadSha256, nowSec },
    signal,
  );
  if (!completed) throw new Error(`V9 eval run ${run.run_id} lost ownership ${action}`);
}

async function escalateQuarantineEpoch(input: {
  db: D1Database;
  run: V9EvalRunRow;
  header: V9EvalRunContextHeader;
  commitContext: V9EvalCommitContextBlob;
  fixedInput: Readonly<SafetyScoreV9CompilerInput>;
  newFailures: readonly [string, string][];
  updatedExpiryWitnesses: ReadonlyMap<string, SafetyScoreV9DexExpiryWitness[]>;
  sourceInvocationId: string;
  workerVersion: string;
  signal?: AbortSignal;
}): Promise<{ quarantineEpoch: number; nextMessage: V9ContinuationMessage }> {
  const existingFailures = new Map(input.header.evaluationFailures);
  const existingQuarantines = new Set(input.header.quarantines.map((q) => q.assetId));
  for (const [assetId] of input.newFailures) {
    if (existingFailures.has(assetId) || existingQuarantines.has(assetId)) {
      throw new Error(`V9 quarantine escalation cannot retry already-quarantined asset ${assetId}`);
    }
  }
  for (const [assetId, message] of input.newFailures) {
    existingFailures.set(assetId, message);
  }

  const nextEpoch = input.run.quarantine_epoch + 1;
  const nowSec = Math.floor(Date.now() / 1_000);
  const artifacts = buildEpochStageArtifacts({
    runId: input.run.run_id,
    quarantineEpoch: nextEpoch,
    fixedInput: input.fixedInput,
    verifiedEmptyExitByAssetId: input.commitContext.verifiedEmptyExitByAssetId,
    previousHealth: input.commitContext.previousHealth,
    transferMaterialityGeneration: input.commitContext.transferMaterialityGeneration,
    laneIncidentCertificates: new Map(input.commitContext.laneIncidentCertificates),
    laneEmitterDescriptors: input.commitContext.laneEmitterDescriptors,
    laneCertificateWarnings: input.commitContext.laneCertificateWarnings,
    evaluationFailures: existingFailures,
    expiryWitnesses: input.updatedExpiryWitnesses,
    maxChunkAssets: input.header.maxChunkAssets,
    deferPublicMaterialization: input.header.deferPublicMaterialization,
    hasFixedInputCacheValue: input.header.hasFixedInputCacheValue,
  });

  const epochFence: V9EvalChunkWriteFence = {
    executionGeneration: input.run.execution_generation,
    expectedQuarantineEpoch: input.run.quarantine_epoch,
    workerVersion: input.workerVersion,
  };
  const contextWrite = {
    runId: input.run.run_id,
    chunkKind: "run_context" as const,
    quarantineEpoch: nextEpoch,
    createdAt: nowSec,
    fence: epochFence,
  };
  // Pruning, replacement and epoch advancement must commit together for retries.
  const statements = [
    input.db.prepare(
      `DELETE FROM v9_eval_chunks
        WHERE run_id = ?
          AND NOT (chunk_kind = 'run_context' AND chunk_index IN (?, ?))
          AND EXISTS (
            SELECT 1 FROM v9_eval_runs
             WHERE run_id = ?
               AND state = 'active'
               AND execution_generation = ?
               AND quarantine_epoch = ?
               AND worker_version = ?
          )`,
    ).bind(
      input.run.run_id,
      RUN_CONTEXT_PINNED_INPUT_INDEX,
      RUN_CONTEXT_REPLAY_INDEX,
      input.run.run_id,
      input.run.execution_generation,
      input.run.quarantine_epoch,
      input.workerVersion,
    ),
    ...buildWriteV9EvalChunkStatements(input.db, {
      ...contextWrite, chunkIndex: RUN_CONTEXT_HEADER_INDEX, value: artifacts.header,
    }).statements,
    ...buildWriteV9EvalChunkStatements(input.db, {
      ...contextWrite, chunkIndex: RUN_CONTEXT_COMMIT_INDEX, value: artifacts.commitContext,
    }).statements,
    input.db.prepare(
      `UPDATE v9_eval_runs
          SET quarantine_epoch = ?,
              chunk_count = ?,
              next_chunk_index = 0,
              stage = 'evaluating',
              fact_set_digest = ?,
              plan_digest = ?,
              updated_at = ?
        WHERE run_id = ?
          AND state = 'active'
          AND execution_generation = ?
          AND quarantine_epoch = ?
          AND worker_version = ?`,
    ).bind(
      nextEpoch,
      artifacts.header.chunkAssetIds.length,
      artifacts.factSetDigest,
      artifacts.planDigest,
      nowSec,
      input.run.run_id,
      input.run.execution_generation,
      input.run.quarantine_epoch,
      input.workerVersion,
    ),
  ];
  const update = await runWithOverloadRetry(() => input.db.batch(statements), 3, input.signal);
  if (update[update.length - 1]?.meta.changes !== 1) {
    throw new Error(`V9 eval run ${input.run.run_id} lost ownership during quarantine escalation`);
  }

  const nextMessage = buildNextV9ContinuationMessage(
    {
      ...input.run,
      stage: "evaluating",
      next_chunk_index: 0,
      quarantine_epoch: nextEpoch,
      policy_digest: artifacts.policyDigest,
    },
    input.sourceInvocationId,
  )!;
  return { quarantineEpoch: nextEpoch, nextMessage };
}

function classifyRunBuildDrift(
  run: V9EvalRunRow,
  runningWorkerVersion: string | null | undefined,
): "build-drift-aborted" | "worker-version-drift-aborted" | null {
  const registryFingerprint = computeReportCardsRegistryFingerprint();
  const policyDigest = currentV9PolicyDigestForClock(run.clock_sec);
  if (
    run.evaluation_build_digest !== SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST ||
    run.registry_fingerprint !== registryFingerprint ||
    run.policy_digest !== policyDigest
  ) {
    return "build-drift-aborted";
  }
  if (!workerVersionsMatch(run.worker_version, runningWorkerVersion)) {
    return "worker-version-drift-aborted";
  }
  return null;
}

function assertRunMatchesRunningBuild(
  run: V9EvalRunRow,
  runningWorkerVersion: string | null | undefined,
): string {
  const drift = classifyRunBuildDrift(run, runningWorkerVersion);
  if (drift === "build-drift-aborted") {
    throw new Error("v9-eval-build-drift");
  }
  if (drift === "worker-version-drift-aborted") {
    throw new Error("v9-eval-worker-version-drift");
  }
  return runningWorkerVersion!.trim();
}

export type V9ChunkedStageStepResult =
  | {
      status: "ok";
      stage: "eval";
      chunkIndex: number;
      nextStage: "evaluating" | "committing";
      nextMessage: V9ContinuationMessage;
    }
  | {
      status: "quarantine-escalated";
      stage: "eval" | "commit";
      quarantineEpoch: number;
      nextMessage: V9ContinuationMessage;
    }
  | {
      status: "published-pending-materialize";
      stage: "commit";
      publicationGenerationId: string;
      payloadSha256: string | null;
      publishedAtSec: number;
      outcome: "clean" | "partial";
      activeAssets: number;
      quarantineCount: number;
      affectedAssetCount: number;
      nextMessage: V9ContinuationMessage;
    }
  | {
      status: "published-materialized";
      stage: "commit";
      publicationGenerationId: string;
      payloadSha256: string | null;
      publishedAtSec: number;
      outcome: "clean" | "partial";
      activeAssets: number;
      quarantineCount: number;
      affectedAssetCount: number;
      nextMessage: null;
    }
  | {
      status: "held";
      stage: "commit";
      attemptedPublicationGenerationId: string;
      publishedAtSec: number;
      reasons: V9PublicationHoldReason[];
      nextMessage: null;
    }
  | {
      status: "aborted";
      stage: "eval" | "commit";
      reason: string;
      nextMessage: null;
    }
  | {
      status: "completed";
      stage: "materialize";
      publicationGenerationId: string | null;
      materializationStatus: string;
      nextMessage: null;
    };

export interface RunChunkedV9StageOptions {
  captureArchiveBucket?: R2Bucket;
  captureArchiveContext?: ExecutionContext;
  workerVersion: string | null;
  deadlineMs: number;
  signal?: AbortSignal;
  /** Test-only hook for deterministic evaluation-error quarantine tests. */
  onBeforeEvaluateAsset?: (assetId: string, chunkIndex: number, quarantineEpoch: number) => void;
}

/** Execute one claimed `eval` chunk stage. */
export async function runChunkedV9EvalStep(
  db: D1Database,
  run: V9EvalRunRow,
  sourceInvocationId: string,
  options: RunChunkedV9StageOptions,
): Promise<V9ChunkedStageStepResult> {
  throwIfAborted(options.signal);
  const runningWorkerVersion = assertRunMatchesRunningBuild(run, options.workerVersion);
  const chunkIndex = run.next_chunk_index;
  if (run.stage !== "evaluating" || chunkIndex < 0 || chunkIndex >= run.chunk_count) {
    throw new Error(`V9 eval run ${run.run_id} is not ready for eval chunk ${chunkIndex}`);
  }

  const header = await readV9EvalChunk<V9EvalRunContextHeader>(
    db,
    {
      runId: run.run_id,
      chunkKind: "run_context",
      chunkIndex: RUN_CONTEXT_HEADER_INDEX,
      quarantineEpoch: run.quarantine_epoch,
    },
    options.signal,
  );
  if (!header) return failRunOnMissingBlob(db, run, "eval", "run_context[0]", options.signal);

  const pinned = await readV9EvalChunk<V9EvalPinnedInputBlob>(
    db,
    { runId: run.run_id, chunkKind: "run_context", chunkIndex: RUN_CONTEXT_PINNED_INPUT_INDEX, quarantineEpoch: 0 },
    options.signal,
  );
  if (!pinned) return failRunOnMissingBlob(db, run, "eval", "run_context[1]", options.signal);
  const commitContext = await readV9EvalChunk<V9EvalCommitContextBlob>(
    db,
    { runId: run.run_id, chunkKind: "run_context", chunkIndex: RUN_CONTEXT_COMMIT_INDEX, quarantineEpoch: run.quarantine_epoch },
    options.signal,
  );
  if (!commitContext) return failRunOnMissingBlob(db, run, "eval", "run_context[2]", options.signal);

  const priorUpstreams = [];
  for (const priorChunkIndex of header.requiredPriorChunksByChunk[chunkIndex] ?? []) {
    const upstreamPayload = await readV9EvalChunk<V9EvalUpstreamStatePayload>(
      db,
      {
        runId: run.run_id,
        chunkKind: "upstream_state",
        chunkIndex: priorChunkIndex,
        quarantineEpoch: run.quarantine_epoch,
      },
      options.signal,
    );
    if (!upstreamPayload) {
      return failRunOnMissingBlob(db, run, "eval", `upstream_state[${priorChunkIndex}]`, options.signal);
    }
    priorUpstreams.push(...upstreamPayload.upstreams);
  }

  // O(1) read of cumulative doc-gap entries instead of re-inflating every prior chunk_summary.
  let priorDocumentationGapEntries: Array<[string, V9DocumentationClassification]> = [];
  if (chunkIndex > 0) {
    const cumulativeDocGaps = await readV9EvalChunk<V9EvalCumulativeDocGapsBlob>(
      db,
      {
        runId: run.run_id,
        chunkKind: "run_context",
        chunkIndex: RUN_CONTEXT_DOC_GAPS_INDEX,
        quarantineEpoch: run.quarantine_epoch,
      },
      options.signal,
    );
    if (!cumulativeDocGaps || cumulativeDocGaps.completedThroughChunkIndex !== chunkIndex - 1) {
      return failRunOnMissingBlob(db, run, "eval", "run_context[3]", options.signal);
    }
    priorDocumentationGapEntries = cumulativeDocGaps.entries;
  }

  const policy = loadV9CandidateMethodologyPolicy(header.clockSec);
  assertV9ValidatedPolicyEnvelope(policy);
  const sortedGlobalAssetIndexById = new Map(header.sortedGlobalAssetIds.map((id, index) => [id, index]));

  const fixedInput = withNormalizedV9JournalProjections(pinned.fixedInput);
  const outcome = evaluateV9Chunk({
    chunkIndex,
    assets: compileV9ChunkAssets({
      fixedInput,
      factSetHeader: header.factSetHeader,
      assetIds: header.chunkAssetIds[chunkIndex]!,
      evaluationFailures: new Map(header.evaluationFailures),
      verifiedEmptyExitByAssetId: commitContext.verifiedEmptyExitByAssetId,
      extensionOptions: {
        transferMaterialityGeneration: commitContext.transferMaterialityGeneration,
        laneIncidentCertificates: new Map(commitContext.laneIncidentCertificates),
        laneEmitterDescriptors: commitContext.laneEmitterDescriptors,
      },
      marketRanks: header.marketRanks,
      commonModeSignals: header.commonModeSignals,
    }),
    dependencyPlan: header.dependencyPlan,
    envelope: policy,
    identity: {
      factSetDigest: header.factSetDigest,
      baseInputGenerationId: header.baseInputGenerationId,
      evaluationBuildDigest: header.evaluationBuildDigest,
      asOfSec: header.clockSec,
      sourceGenerations: header.sourceGenerations,
    },
    clockSec: header.clockSec,
    dexExitRouteMaxAgeSec: header.dexExitRouteMaxAgeSec,
    priorUpstreams,
    priorDocumentationGapEntries,
    exportedUpstreamIds: new Set(header.exportedUpstreamsByChunk[chunkIndex] ?? []),
    sortedGlobalAssetIndexById,
    onBeforeEvaluateAsset: options.onBeforeEvaluateAsset
      ? (assetId, idx) => options.onBeforeEvaluateAsset!(assetId, idx, run.quarantine_epoch)
      : undefined,
  });

  if (outcome.status === "quarantine-required") {
    const escalated = await escalateQuarantineEpoch({
      db,
      run,
      header,
      commitContext,
      fixedInput,
      newFailures: outcome.failures,
      updatedExpiryWitnesses: new Map(header.expiryWitnesses),
      sourceInvocationId,
      workerVersion: runningWorkerVersion,
      signal: options.signal,
    });
    return {
      status: "quarantine-escalated",
      stage: "eval",
      quarantineEpoch: escalated.quarantineEpoch,
      nextMessage: escalated.nextMessage,
    };
  }

  const nowSec = Math.floor(Date.now() / 1_000);
  const nextChunkIndex = chunkIndex + 1;
  const nextStage: "evaluating" | "committing" = nextChunkIndex < run.chunk_count ? "evaluating" : "committing";
  const writeFence: V9EvalChunkWriteFence = {
    executionGeneration: run.execution_generation,
    expectedQuarantineEpoch: run.quarantine_epoch,
  };

  const statements: D1PreparedStatement[] = [
    ...buildWriteV9EvalChunkStatements(db, {
      runId: run.run_id,
      chunkKind: "card_shard",
      chunkIndex,
      quarantineEpoch: run.quarantine_epoch,
      value: outcome.cardShard,
      createdAt: nowSec,
      fence: writeFence,
    }).statements,
    ...buildWriteV9EvalChunkStatements(db, {
      runId: run.run_id,
      chunkKind: "chunk_summary",
      chunkIndex,
      quarantineEpoch: run.quarantine_epoch,
      value: outcome.chunkSummary,
      createdAt: nowSec,
      fence: writeFence,
    }).statements,
    ...(nextStage === "evaluating"
      ? buildWriteV9EvalChunkStatements(db, {
          runId: run.run_id,
          chunkKind: "run_context",
          chunkIndex: RUN_CONTEXT_DOC_GAPS_INDEX,
          quarantineEpoch: run.quarantine_epoch,
          value: {
            schemaVersion: 1,
            completedThroughChunkIndex: chunkIndex,
            entries: outcome.cumulativeDocumentationGapEntries,
          } satisfies V9EvalCumulativeDocGapsBlob,
          createdAt: nowSec,
          fence: writeFence,
        }).statements
      : []),
    ...(outcome.upstreamState.upstreams.length > 0
      ? buildWriteV9EvalChunkStatements(db, {
          runId: run.run_id,
          chunkKind: "upstream_state",
          chunkIndex,
          quarantineEpoch: run.quarantine_epoch,
          value: outcome.upstreamState,
          createdAt: nowSec,
          fence: writeFence,
        }).statements
      : []),
    db.prepare(
      `UPDATE v9_eval_runs
          SET next_chunk_index = ?,
              stage = ?,
              updated_at = ?
        WHERE run_id = ?
          AND state = 'active'
          AND stage = 'evaluating'
          AND next_chunk_index = ?
          AND quarantine_epoch = ?
          AND execution_generation = ?
          AND worker_version = ?`,
    ).bind(
      nextChunkIndex,
      nextStage,
      nowSec,
      run.run_id,
      chunkIndex,
      run.quarantine_epoch,
      run.execution_generation,
      runningWorkerVersion,
    ),
  ];

  const batchResult = await runWithOverloadRetry(() => db.batch(statements), 3, options.signal);
  if (batchResult[batchResult.length - 1]?.meta.changes !== 1) {
    throw new Error(`V9 eval run ${run.run_id} lost ownership advancing past chunk ${chunkIndex}`);
  }

  const nextMessage = buildNextV9ContinuationMessage(
    {
      ...run,
      stage: nextStage,
      next_chunk_index: nextChunkIndex,
    },
    sourceInvocationId,
  )!;

  return {
    status: "ok",
    stage: "eval",
    chunkIndex,
    nextStage,
    nextMessage,
  };
}

async function readCommittedPublicationPayloadSha256(
  db: D1Database,
  publicationGenerationId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  throwIfAborted(signal);
  const row = await runWithOverloadRetry(
    () => db.prepare(
      `SELECT json_extract(value, '$.payloadSha256') AS payload_sha256
         FROM cache
        WHERE key = ?
          AND json_extract(value, '$.identity.publicationGenerationId') = ?`,
    ).bind(SAFETY_SCORE_V9_CACHE_KEYS.publication, publicationGenerationId).first<{ payload_sha256: string | null }>(),
    3,
    signal,
  );
  return typeof row?.payload_sha256 === "string" && row.payload_sha256.length > 0 ? row.payload_sha256 : null;
}

async function prepareV9Commit(
  db: D1Database,
  run: V9EvalRunRow,
  header: V9EvalRunContextHeader,
  commitContext: V9EvalCommitContextBlob,
  signal?: AbortSignal,
) {
  // Verify the live baseline before using any of its scoring inputs.
  const liveAcceptedState = await loadSafetyScoreV9AcceptedBaselineState(db, signal);
  if (liveAcceptedState.kind === "unavailable") {
    throw new SafetyScoreV9AcceptedBaselineProjectionError(liveAcceptedState.reason);
  }
  const liveBaseline = liveAcceptedState.kind === "accepted" ? liveAcceptedState.projection.baseline : null;
  const liveGenerationId = liveBaseline?.publicationGenerationId ?? null;
  const liveBaselineSha256 =
    liveBaseline === null ? null : sha256HexFromUtf8Chunks(stableJsonStringifyChunksV1(liveBaseline));
  const baselineMatchesPinned =
    liveGenerationId === run.accepted_baseline_generation_id &&
    liveBaselineSha256 === run.accepted_baseline_sha256;
  if (!baselineMatchesPinned && liveBaseline?.publishedAtSec !== header.clockSec) {
    return { result: await abortRunFenced(db, run, "commit", "accepted-baseline-drift", signal) };
  }

  const chunkSummaries: V9EvalChunkSummaryPayload[] = [];
  for (let chunkIndex = 0; chunkIndex < run.chunk_count; chunkIndex++) {
    const summary = await readV9EvalChunk<V9EvalChunkSummaryPayload>(
      db,
      {
        runId: run.run_id,
        chunkKind: "chunk_summary",
        chunkIndex,
        quarantineEpoch: run.quarantine_epoch,
      },
      signal,
    );
    if (!summary) return { result: await failRunOnMissingBlob(db, run, "commit", `chunk_summary[${chunkIndex}]`, signal) };
    chunkSummaries.push(summary);
  }

  const projectionFailures = chunkSummaries.flatMap((summary) => summary.projectionFailures);
  if (projectionFailures.length > 0) {
    return { newFailures: projectionFailures, expiryWitnesses: new Map(header.expiryWitnesses) };
  }

  let cardShardIndex = 0;
  async function* readCardShards() {
    for (; cardShardIndex < run.chunk_count; cardShardIndex++) {
      yield await readV9EvalChunk<V9EvalCardShardPayload>(db, {
        runId: run.run_id,
        chunkKind: "card_shard",
        chunkIndex: cardShardIndex,
        quarantineEpoch: run.quarantine_epoch,
      }, signal);
    }
  }

  const policy = loadV9CandidateMethodologyPolicy(header.clockSec);
  assertV9ValidatedPolicyEnvelope(policy);

  const assembled = await assembleV9ChunkedCandidate({
    envelope: policy,
    policyVersion: header.policyVersion,
    publishedAtSec: header.clockSec,
    factSetDigest: header.factSetDigest,
    baseInputGenerationId: header.baseInputGenerationId,
    evaluationBuildDigest: header.evaluationBuildDigest,
    asOfSec: header.clockSec,
    sourceGenerations: header.sourceGenerations,
    dependencyPlan: header.dependencyPlan,
    compilerFactSchemaDigest: header.compilerFactSchemaDigest,
    producerCapabilityDigest: header.producerCapabilityDigest,
    dexExitRouteMaxAgeSec: header.dexExitRouteMaxAgeSec,
    chunkSummaries,
    cardShards: readCardShards(),
    verifiedEmptyExitByAssetId: commitContext.verifiedEmptyExitByAssetId,
  });

  if (!assembled) return { result: await failRunOnMissingBlob(db, run, "commit", `card_shard[${cardShardIndex}]`, signal) };

  const alreadyCommitted = liveGenerationId === assembled.publicationGenerationId &&
    liveBaseline?.publishedAtSec === header.clockSec;
  if (!baselineMatchesPinned && !alreadyCommitted) {
    return { result: await abortRunFenced(db, run, "commit", "accepted-baseline-drift", signal) };
  }

  const expiredRoutes = deserializeExpiredRoutes(commitContext.expiredRoutes);
  let publication = assembled.candidate;
  if (alreadyCommitted) {
    // Recover the grade holds from the committed grades and the run's original baseline ID.
    const acceptedGrades = new Map(liveBaseline.cards.map(({ id, grade }) => [id, grade]));
    const heldFromGenerationId = run.accepted_baseline_generation_id;
    if (heldFromGenerationId !== null) {
      publication = { ...publication, cards: publication.cards.map((card) => {
        const grade = acceptedGrades.get(card.id);
        const rawGrade = card.grade;
        return grade == null || grade === rawGrade || rawGrade === null || rawGrade === "NR"
          ? card : { ...card, grade, gradeHold: { rawGrade, heldFromGenerationId } };
      }) };
    }
  } else {
    publication = applySafetyScoreV9GradeHysteresis(publication, liveBaseline);
  }
  const expiry = alreadyCommitted ? null : resolveMeasuredExitExpiry(
    expiredRoutes, publication, liveBaseline, assembled.internalExitRoutesByAssetId,
  );
  const expiryWitnesses = new Map(header.expiryWitnesses);
  for (const [assetId, witnesses] of Object.entries(expiry?.witnessesByAssetId ?? {})) {
    if (!expiryWitnesses.has(assetId)) expiryWitnesses.set(assetId, witnesses);
  }
  const existingFailures = new Map(header.evaluationFailures);
  const pendingExpiry = expiry?.assetIds.filter(
    (assetId) => !existingFailures.has(assetId) && !header.quarantines.some((q) => q.assetId === assetId),
  );
  if (expiry && pendingExpiry && pendingExpiry.length > 0) {
    const newFailures: Array<[string, string]> = pendingExpiry.map((assetId) => [
      assetId,
      measuredExitExpiryMessage(expiry.witnessesByAssetId[assetId]!, header.clockSec).slice(0, 500),
    ]);
    return { newFailures, expiryWitnesses };
  }

  const { verifiedEmptyExitBaselineOptions, lenderCollateralBackingScoresByAssetId } = assembled;
  return {
    publication, liveBaseline, liveHealth: liveAcceptedState.health, alreadyCommitted, expiredRoutes, expiryWitnesses,
    verifiedEmptyExitBaselineOptions, lenderCollateralBackingScoresByAssetId,
  };
}

/** Execute one claimed `commit` stage (canonical assembly, 10.35 check, baseline fence, assess, persist). */
async function commitV9Evaluation(
  db: D1Database,
  run: V9EvalRunRow,
  sourceInvocationId: string,
  options: RunChunkedV9StageOptions,
  archive: { input?: Parameters<typeof archiveSafetyScoreCapture>[0] },
): Promise<V9ChunkedStageStepResult> {
  throwIfAborted(options.signal);
  const runningWorkerVersion = assertRunMatchesRunningBuild(run, options.workerVersion);
  if (run.stage !== "committing") {
    throw new Error(`V9 eval run ${run.run_id} is in stage ${run.stage}, not committing`);
  }

  const header = await readV9EvalChunk<V9EvalRunContextHeader>(
    db,
    {
      runId: run.run_id,
      chunkKind: "run_context",
      chunkIndex: RUN_CONTEXT_HEADER_INDEX,
      quarantineEpoch: run.quarantine_epoch,
    },
    options.signal,
  );
  if (!header) return failRunOnMissingBlob(db, run, "commit", "run_context[0]", options.signal);

  const commitContext = await readV9EvalChunk<V9EvalCommitContextBlob>(
    db,
    {
      runId: run.run_id,
      chunkKind: "run_context",
      chunkIndex: RUN_CONTEXT_COMMIT_INDEX,
      quarantineEpoch: run.quarantine_epoch,
    },
    options.signal,
  );
  if (!commitContext) return failRunOnMissingBlob(db, run, "commit", "run_context[2]", options.signal);

  const prepared = await prepareV9Commit(db, run, header, commitContext, options.signal);
  if (prepared.result) return prepared.result;
  if (prepared.newFailures) {
    const pinned = await readV9EvalChunk<V9EvalPinnedInputBlob>(
      db,
      { runId: run.run_id, chunkKind: "run_context", chunkIndex: RUN_CONTEXT_PINNED_INPUT_INDEX, quarantineEpoch: 0 },
      options.signal,
    );
    if (!pinned) return failRunOnMissingBlob(db, run, "commit", "run_context[1]", options.signal);
    const escalated = await escalateQuarantineEpoch({
      db,
      run,
      header,
      commitContext,
      fixedInput: withNormalizedV9JournalProjections(pinned.fixedInput),
      newFailures: prepared.newFailures,
      updatedExpiryWitnesses: prepared.expiryWitnesses,
      sourceInvocationId,
      workerVersion: runningWorkerVersion,
      signal: options.signal,
    });
    return {
      status: "quarantine-escalated",
      stage: "commit",
      quarantineEpoch: escalated.quarantineEpoch,
      nextMessage: escalated.nextMessage,
    };
  }
  const {
    publication, liveBaseline, liveHealth, alreadyCommitted, expiredRoutes, expiryWitnesses,
    verifiedEmptyExitBaselineOptions, lenderCollateralBackingScoresByAssetId,
  } = prepared;

  const coverageFloors = observationCoverageFloors(
    publication.cards.length,
    commitContext.activeAssetCount,
    publication.completeness.ratedCount,
  );
  const measuredExitExpiryAssetIds = [...expiryWitnesses.keys()].sort(compareText);
  const measuredExitExpiryWitnessesByAssetId = Object.fromEntries(
    [...expiryWitnesses].sort(([left], [right]) => compareText(left, right)),
  );

  let assessment: V9PublicationAssessment;
  try {
    assessment = alreadyCommitted
      ? { decision: "publish", reasons: [], affectedAssetIds: [...header.quarantineAffectedAssetIds] }
      : assessV9Publication({
      inputHealth: commitContext.inputHealth,
      expiredMeasuredExitAssetIds: [
        ...new Set([
          ...measuredExitExpiryAssetIds,
          ...expiredMeasuredExitAssetIdsFromRoutes(expiredRoutes, publication, liveBaseline),
        ]),
      ],
      candidate: publication,
      acceptedPublication: liveBaseline,
      coverageFloors,
      quarantinedAssetIds: header.quarantines.map((quarantine) => quarantine.assetId),
      quarantineAffectedAssetIds: header.quarantineAffectedAssetIds,
    });
  } catch (error) {
    assessment = {
      decision: "hold" as const,
      reasons: [
        {
          code: "assessment-failed" as const,
          detail: safeFailure(error, "publication-gate").message.slice(0, 240),
        },
      ],
      affectedAssetIds: [...header.quarantineAffectedAssetIds],
    };
  }

  const nowSec = Math.floor(Date.now() / 1_000);
  // Deterministic per-run attemptId prevents double-journaling after a crash-after-persist retry.
  const attemptedAtSec = Math.max(header.clockSec, run.created_at);
  const attemptId = `safety-score-v9-publication:${run.run_id}`;
  const journalFixedInputSummary = {
    sourceGeneration: commitContext.sourceGeneration,
    baseInputGenerationId: commitContext.baseInputGenerationId,
    dexGenerationId: commitContext.dexGenerationId,
    redemptionGenerationId: commitContext.redemptionGenerationId,
    registryFingerprint: commitContext.registryFingerprint,
    inputFreshness: commitContext.inputFreshness,
  };

  if (assessment.decision === "hold") {
    await requireRunOwnership(db, run, "committing", runningWorkerVersion, nowSec, "before persisting held commit", options.signal);
    const alreadyHeld =
      liveHealth?.status === "held" &&
      liveHealth.attemptedAtSec === header.clockSec;
    if (!alreadyHeld) {
      await persistSafetyScoreV9Publication(db, {
        publicationHealth: heldPublicationHealth({
          attemptedAtSec: header.clockSec,
          reasons: assessment.reasons,
          acceptedPublication: liveBaseline,
          previousHealth: liveHealth ?? commitContext.previousHealth,
        }),
        publicationAttempt: publicationAttempt({
          attemptedAtSec: header.clockSec,
          outcome: "held",
          publicationGenerationId: null,
          quarantines: header.quarantines,
          affectedAssetIds: assessment.affectedAssetIds,
        }),
        publicationClockSec: header.clockSec,
        signal: options.signal,
      });
    }
    await journalSafetyScorePublication({
      db,
      publication,
      fixedInput: journalFixedInputSummary,
      attemptId,
      attemptedAtSec,
      outcome: "held",
      holdReasons: assessment.reasons,
      transferMaterialityGenerationId: commitContext.transferMaterialityGeneration?.generationId ?? null,
      signal: options.signal,
    }).catch(() => undefined);

    await completeRunOrThrow(db, run, null, null, nowSec, "completing held commit", options.signal);
    return {
      status: "held",
      stage: "commit",
      attemptedPublicationGenerationId: publication.publicationGenerationId,
      publishedAtSec: header.clockSec,
      reasons: assessment.reasons,
      nextMessage: null,
    };
  }

  if (commitContext.baseInputGenerationId !== publication.baseInputGenerationId) {
    throw new Error("Accepted Safety Score v9 input does not match the publication base generation");
  }

  await requireRunOwnership(db, run, "committing", runningWorkerVersion, nowSec, "before persisting publication", options.signal);

  const partial = assessment.affectedAssetIds.length > 0;
  let persistedPayloadSha256: string | null = null;
  let shouldDeferMaterialization = header.deferPublicMaterialization;

  if (!alreadyCommitted) {
    let replayCaptureValue: string | undefined;
    let fixedInputCacheValue: string | undefined;
    if (header.hasFixedInputCacheValue) {
      const replayBlob = await readV9EvalChunk<V9EvalReplayInputBlob>(
        db,
        {
          runId: run.run_id,
          chunkKind: "run_context",
          chunkIndex: RUN_CONTEXT_REPLAY_INDEX,
          quarantineEpoch: 0,
        },
        options.signal,
      );
      if (replayBlob) {
        fixedInputCacheValue = replayBlob.fixedInputCacheValue;
        try {
          replayCaptureValue = (
            await buildSafetyScoreV9PublicationReplayCapture(
              publication,
              replayBlob.replayInput,
              commitContext.transferMaterialityGeneration,
              liveBaseline,
              {
                certificates: new Map(commitContext.laneIncidentCertificates),
                descriptors: commitContext.laneEmitterDescriptors,
              },
            )
          ).value;
        } catch (error) {
          if (error instanceof SafetyScoreV9ReplayCaptureIdentityError) throw error;
          logWorkerEvent({
            scope: "lib",
            level: "warn",
            event: "safety_score_v9_replay_capture_retention_failed",
            job: "compute-safety-score-v9",
            message: "Accepted replay delta could not be serialized during chunked commit; canonical publication continues",
            metadata: { reason: toErrorMessage(error).slice(0, 200) },
          });
        }
      } else {
        logWorkerEvent({
          scope: "lib",
          level: "warn",
          event: "safety_score_v9_replay_capture_retention_failed",
          job: "compute-safety-score-v9",
          message: "Accepted replay input is missing during chunked commit",
          metadata: { reason: "missing-staging-blob:run_context[4]" },
        });
      }
    }

    const persisted = await persistSafetyScoreV9Publication(db, {
      publication,
      buildAcceptedProjections: (accepted) =>
        buildSafetyScoreV9AcceptedProjections(
          accepted,
          measuredExitExpiryWitnessesByAssetId,
          verifiedEmptyExitBaselineOptions,
          lenderCollateralBackingScoresByAssetId,
        ),
      publicationReplayCaptureValue: replayCaptureValue,
      publicationReplayBaseValue: replayCaptureValue === undefined ? undefined : fixedInputCacheValue,
      publicationHealth: {
        schemaVersion: 2,
        status: "current",
        acceptedPublicationGenerationId: publication.publicationGenerationId,
        acceptedAtSec: header.clockSec,
        attemptedAtSec: header.clockSec,
        heldSinceSec: null,
        reasons: [],
      },
      publicationAttempt: publicationAttempt({
        attemptedAtSec: header.clockSec,
        outcome: partial ? "published-partial" : "published-clean",
        publicationGenerationId: publication.publicationGenerationId,
        quarantines: header.quarantines,
        affectedAssetIds: assessment.affectedAssetIds,
      }),
      publicationClockSec: header.clockSec,
      signal: options.signal,
      deferPublicMaterialization: header.deferPublicMaterialization,
    });

    if (options.captureArchiveBucket && persisted.captureArchiveCacheRows) {
      archive.input = {
        db,
        bucket: options.captureArchiveBucket,
        publication: {
          publicationGenerationId: publication.publicationGenerationId, publishedAtSec: publication.publishedAtSec,
          policyVersion: publication.policyVersion, policy: publication.policy, evaluationBuildDigest: publication.evaluationBuildDigest,
        },
        cacheRows: persisted.captureArchiveCacheRows,
        signal: options.signal,
        deadlineMs: options.deadlineMs,
        ctx: options.captureArchiveContext,
      };
    }
    persistedPayloadSha256 = persisted.publicationPayloadSha256;
    shouldDeferMaterialization = persisted.acceptedMaterialization !== null;
  } else {
    persistedPayloadSha256 = run.payload_sha256 ??
      await readCommittedPublicationPayloadSha256(db, publication.publicationGenerationId, options.signal);
  }

  // Restore the alert envelope and idempotent journal on crash-after-persist recovery too.
  await persistAlertSafetyV9SourceEnvelope(
    db,
    {
      cards: publication.cards,
      safetyScoreIdentity: buildSafetyScoreV9PublicationIdentity(publication),
      publishedAt: header.clockSec,
    },
    options.signal,
  ).catch((error) => {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "safety_score_v9_alert_source_envelope_persist_failed",
      job: "compute-safety-score-v9",
      message: "Safety Score V9 alert source envelope could not be persisted",
      metadata: { error: String(error).slice(0, 200) },
    });
  });

  await journalSafetyScorePublication({
    db,
    publication,
    fixedInput: journalFixedInputSummary,
    attemptId,
    attemptedAtSec,
    outcome: "accepted",
    transferMaterialityGenerationId: commitContext.transferMaterialityGeneration?.generationId ?? null,
    signal: options.signal,
  }).catch(() => undefined);

  const payloadSha256 = persistedPayloadSha256;

  if (shouldDeferMaterialization) {
    const materializeHeader: V9MaterializeHeaderBlob = {
      schemaVersion: 1,
      publicationGenerationId: publication.publicationGenerationId,
      payloadSha256,
      publishedAtSec: header.clockSec,
    };
    const updateNowSec = Math.floor(Date.now() / 1_000);
    const writeFence: V9EvalChunkWriteFence = {
      executionGeneration: run.execution_generation,
      expectedQuarantineEpoch: run.quarantine_epoch,
    };
    const statements: D1PreparedStatement[] = [
      // Prune evaluation staging blobs only while this owner still holds the committing run.
      db.prepare(
        `DELETE FROM v9_eval_chunks
          WHERE run_id = ?
            AND EXISTS (
              SELECT 1 FROM v9_eval_runs
               WHERE run_id = ?
                 AND state = 'active'
                 AND stage = 'committing'
                 AND execution_generation = ?
                 AND quarantine_epoch = ?
                 AND worker_version = ?
            )`,
      ).bind(
        run.run_id,
        run.run_id,
        run.execution_generation,
        run.quarantine_epoch,
        runningWorkerVersion,
      ),
      ...buildWriteV9EvalChunkStatements(db, {
        runId: run.run_id,
        chunkKind: "materialize_header",
        chunkIndex: 0,
        quarantineEpoch: run.quarantine_epoch,
        value: materializeHeader,
        createdAt: updateNowSec,
        fence: writeFence,
      }).statements,
      db.prepare(
        `UPDATE v9_eval_runs
            SET stage = 'materializing',
                materialize_step_count = 1,
                next_materialize_step = 0,
                publication_generation_id = ?,
                payload_sha256 = ?,
                updated_at = ?
          WHERE run_id = ?
            AND state = 'active'
            AND stage = 'committing'
            AND execution_generation = ?
            AND quarantine_epoch = ?
            AND worker_version = ?`,
      ).bind(
        publication.publicationGenerationId,
        payloadSha256,
        updateNowSec,
        run.run_id,
        run.execution_generation,
        run.quarantine_epoch,
        runningWorkerVersion,
      ),
    ];
    const transitionResults = await runWithOverloadRetry(() => db.batch(statements), 3, options.signal);
    if (transitionResults[transitionResults.length - 1]?.meta.changes !== 1) {
      throw new Error(`V9 eval run ${run.run_id} lost ownership transitioning to materializing`);
    }

    const nextMessage = buildNextV9ContinuationMessage(
      {
        ...run,
        stage: "materializing",
        next_chunk_index: run.chunk_count,
      },
      sourceInvocationId,
    )!;
    return {
      status: "published-pending-materialize",
      stage: "commit",
      publicationGenerationId: publication.publicationGenerationId,
      payloadSha256,
      publishedAtSec: header.clockSec,
      outcome: partial ? "partial" : "clean",
      activeAssets: commitContext.activeAssetCount,
      quarantineCount: header.quarantines.length,
      affectedAssetCount: assessment.affectedAssetIds.length,
      nextMessage,
    };
  }

  await completeRunOrThrow(
    db,
    run,
    publication.publicationGenerationId,
    payloadSha256,
    Math.floor(Date.now() / 1_000),
    "completing commit",
    options.signal,
  );
  return {
    status: "published-materialized",
    stage: "commit",
    publicationGenerationId: publication.publicationGenerationId,
    payloadSha256,
    publishedAtSec: header.clockSec,
    outcome: partial ? "partial" : "clean",
    activeAssets: commitContext.activeAssetCount,
    quarantineCount: header.quarantines.length,
    affectedAssetCount: assessment.affectedAssetIds.length,
    nextMessage: null,
  };
}

/** Execute one claimed Commit and await bounded archiving after the transition. */
export async function runChunkedV9CommitStep(
  db: D1Database,
  run: V9EvalRunRow,
  sourceInvocationId: string,
  options: RunChunkedV9StageOptions,
): Promise<V9ChunkedStageStepResult> {
  const archive: { input?: Parameters<typeof archiveSafetyScoreCapture>[0] } = {};
  const result = await commitV9Evaluation(db, run, sourceInvocationId, options, archive);
  if (archive.input) await archiveSafetyScoreCapture(archive.input).catch(() => undefined);
  return result;
}

/**
 * Execute one claimed `materialize` stage. Reuses `retryPendingSafetyScoreV9PublicMaterialization`
 * so `:38` D1-only materialization piggyback and `:52` recovery stay 100% compatible.
 */
export async function runChunkedV9MaterializeStep(
  db: D1Database,
  run: V9EvalRunRow,
  options: RunChunkedV9StageOptions,
): Promise<V9ChunkedStageStepResult> {
  throwIfAborted(options.signal);
  assertRunMatchesRunningBuild(run, options.workerVersion);
  if (run.stage !== "materializing") {
    throw new Error(`V9 eval run ${run.run_id} is in stage ${run.stage}, not materializing`);
  }

  const retry = await retryPendingSafetyScoreV9PublicMaterialization(
    db,
    options.signal,
    options.deadlineMs,
  );
  if (retry === null || retry.status === "materialized" || retry.status === "superseded") {
    await completeRunOrThrow(
      db,
      run,
      retry?.publicationGenerationId ?? run.publication_generation_id,
      run.payload_sha256,
      Math.floor(Date.now() / 1_000),
      "completing materialize",
      options.signal,
    );
    return {
      status: "completed",
      stage: "materialize",
      publicationGenerationId: retry?.publicationGenerationId ?? run.publication_generation_id,
      materializationStatus: retry?.status ?? "already-selected",
      nextMessage: null,
    };
  }

  throw new Error(`V9 chunked materialization did not finish: ${retry.reason}`);
}

export async function executeClaimedV9EvalStage(
  db: D1Database,
  run: V9EvalRunRow,
  sourceInvocationId: string,
  options: RunChunkedV9StageOptions,
): Promise<V9ChunkedStageStepResult> {
  if (run.stage === "evaluating") {
    return runChunkedV9EvalStep(db, run, sourceInvocationId, options);
  }
  if (run.stage === "committing") {
    return runChunkedV9CommitStep(db, run, sourceInvocationId, options);
  }
  if (run.stage === "materializing") {
    return runChunkedV9MaterializeStep(db, run, options);
  }
  throw new Error(`Unsupported active V9 eval run stage: ${run.stage}`);
}

/**
 * `:52` second-chance stage resume. Sweeps stale `> 1h` runs, checks for an
 * unfinished active run on the current build and Worker version, claims it by
 * bumping `execution_generation` (fencing stale queue deliveries), and executes
 * its unfinished stage under the shared `worker-memory-lane:safety-score-v9` lease.
 */
export async function resumeActiveChunkedV9Evaluation(input: {
  db: D1Database;
  sourceInvocationId: string;
  options: RunChunkedV9StageOptions;
}): Promise<{ runId: string; result: V9ChunkedStageStepResult } | null> {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1_000);
  await sweepStaleV9EvalRuns(input.db, nowSec, nowMs, input.options.signal);

  const active = await loadLatestActiveV9EvalRun(input.db, input.options.signal);
  if (!active || active.stage === "seeded") {
    if (active?.stage === "seeded") {
      await markV9EvalRunFailedAndPrune(input.db, active.run_id, "incomplete-seed-aborted", nowSec, input.options.signal);
    }
    return null;
  }

  const drift = classifyRunBuildDrift(active, input.options.workerVersion);
  if (drift !== null) {
    await markV9EvalRunFailedAndPrune(input.db, active.run_id, drift, nowSec, input.options.signal);
    return null;
  }

  const claimed = await claimActiveV9EvalRunForCronResume(
    input.db,
    {
      runId: active.run_id,
      expectedGeneration: active.execution_generation,
      workerVersion: input.options.workerVersion!.trim(),
      owner: input.sourceInvocationId,
      nowSec,
    },
    input.options.signal,
  );
  if (!claimed) return null;

  const result = await executeClaimedV9EvalStage(
    input.db,
    claimed,
    input.sourceInvocationId,
    input.options,
  );
  return { runId: claimed.run_id, result };
}
