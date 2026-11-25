import { toErrorMessage } from "@shared/lib/error-utils";
import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v9/evaluation-build-manifest-v1";
import { computeReportCardsRegistryFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { applySafetyScoreV9GradeHysteresis } from "@shared/lib/safety-score-v9/grade-hysteresis";
import {
  assertV9ValidatedPolicyEnvelope,
  loadV9CandidateMethodologyPolicy,
} from "@shared/lib/safety-score-v9/policy";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { V9DocumentationClassification } from "@shared/lib/safety-score-v9/documentation";
import type { V9DependencyEvaluationPlan } from "@shared/lib/safety-score-v9/dependencies";
import type { V9OpenEvidenceAsset } from "@shared/lib/safety-score-v9/open-questions";
import type { V9PublicationHealth, V9PublicationHoldReason } from "@shared/types/report-cards-v9";
import { V9_MINIMUM_RATEABLE_ASSETS } from "@shared/types/safety-score-v9-coverage";
import type { V9LaneEmitterDescriptor, V9LaneIncidentCertificate } from "@shared/types/safety-score-v9-incidents";
import type { SafetyScoreV9CurrentResponse, V9ReserveCompositionAdmission } from "@shared/types/safety-score-v9-public";
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
import type { SafetyScoreV9BridgeJoinDiagnostic } from "./candidate";
import {
  assembleV9ChunkedCandidate,
  buildV9DependencyPlanForCompiledFacts,
  computeV9CommonModeSignalsForPlan,
  computeV9CompilerFactSchemaDigestForExtension,
  computeV9MarketRanks,
  computeV9ProducerCapabilityDigestForExtension,
  computeV9QuarantineAffectedAssetIds,
  evaluateV9Chunk,
  extractV9SourceGenerations,
  formatV9MeasuredExitExpiryMessage,
  partitionV9DependencyChunks,
  projectV9PublicDisplayMetadata,
  resolveV9ReleasePolicyVersion,
  serializeV9PublicDependencyMetadata,
  V9_EVAL_DEFAULT_MAX_CHUNK_ASSETS,
  type V9EvalCardShardPayload,
  type V9EvalChunkSummaryPayload,
  type V9EvalFactShardAsset,
  type V9EvalFactShardPayload,
  type V9EvalUpstreamStatePayload,
} from "./chunked-eval-plan";
import {
  buildNextV9ContinuationMessage,
  buildWriteV9EvalChunkStatements,
  claimActiveV9EvalRunForCronResume,
  loadLatestActiveV9EvalRun,
  markV9EvalRunCompletedAndPrune,
  markV9EvalRunFailedAndPrune,
  readV9EvalChunk,
  supersedeActiveV9EvalRuns,
  sweepStaleV9EvalRuns,
  writeV9EvalChunk,
  type V9EvalRunRow,
} from "./chunked-eval-store";
import {
  createSafetyScoreV9BaselineExtensionSource,
  type BuildSafetyScoreV9BaselineExtensionOptions,
} from "./extension";
import type { LaneIncidentCertificateView } from "./extension-incidents";
import {
  compileSafetyScoreV9FactSetFromExtensionSource,
  type V9AssetQuarantine,
} from "./fact-set";
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
  type V9PublicationCoverageFloor,
  type V9PublicationInputHealth,
} from "./publication-assessment";
import type { V9PublicationAttempt } from "./publication-attempts";
import { safeFailure, SafetyScoreV9AcceptedBaselineProjectionError } from "./publication-failure";
import { journalSafetyScorePublication } from "./publication-journal";
import { retryPendingSafetyScoreV9PublicMaterialization } from "./publication-materialization";
import {
  buildSafetyScoreV9PublicationReplayCapture,
  SafetyScoreV9ReplayCaptureIdentityError,
} from "./publication-replay-capture";
import { persistSafetyScoreV9Publication } from "./publication-store";
import type { SafetyScoreV9TransferMaterialityGeneration } from "./transfer-materiality";

// Matches candidate.ts rollout UTC epoch seconds (2026-11-20T08:00:00Z).
const RESERVE_COMPOSITION_ADMISSION_ACTIVATION_SEC = 1795161600;
const RUN_CONTEXT_HEADER_INDEX = 0;
const RUN_CONTEXT_PINNED_INPUT_INDEX = 1;
const RUN_CONTEXT_COMMIT_INDEX = 2;

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
  fixedInputCacheValue: string | null;
}

interface SerializedExpiredMeasuredExitRoutes {
  clockSec: number;
  dexGenerationId: string;
  windowsByAssetId: Array<[string, Array<[string, { observationWindowEndedAt: number; freshnessMaxSec: number }]>]>;
  byAssetId: Array<[string, string[]]>;
}

export interface V9EvalCommitContextBlob {
  schemaVersion: 1;
  openEvidenceCatalog: V9OpenEvidenceAsset[];
  acceptedPublication: SafetyScoreV9AcceptedPublicationBaseline | null;
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
  payloadSha256: string;
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

function buildEpochStageArtifacts(input: {
  runId: string;
  quarantineEpoch: number;
  fixedInput: Readonly<SafetyScoreV9CompilerInput>;
  acceptedPublication: SafetyScoreV9AcceptedPublicationBaseline | null;
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
  factShards: V9EvalFactShardPayload[];
  policyDigest: string;
  planDigest: string;
  factSetDigest: string;
} {
  const clockSec = input.fixedInput.clockSec;
  const policy = loadV9CandidateMethodologyPolicy(clockSec);
  assertV9ValidatedPolicyEnvelope(policy);
  const policyVersion = resolveV9ReleasePolicyVersion(policy);

  const includeReserveCompositionAdmission = clockSec >= RESERVE_COMPOSITION_ADMISSION_ACTIVATION_SEC;
  const reserveRejections = includeReserveCompositionAdmission
    ? new Map<string, V9ReserveCompositionAdmission>()
    : undefined;
  const extensionOptions: BuildSafetyScoreV9BaselineExtensionOptions = {
    transferMaterialityGeneration: input.transferMaterialityGeneration,
    laneIncidentCertificates: input.laneIncidentCertificates,
    laneEmitterDescriptors: input.laneEmitterDescriptors,
    onReserveCompositionRejected:
      reserveRejections && ((id, diagnostic) => { reserveRejections.set(id, diagnostic); }),
  };

  const extensionSource = createSafetyScoreV9BaselineExtensionSource(input.fixedInput, extensionOptions);
  const extension = extensionSource.extension;
  const dexExitRouteMaxAgeSec = extension.routeFreshness.dexMaxAgeSec;
  const verifiedEmptyExitByAssetId = input.acceptedPublication?.verifiedEmptyExitByAssetId;

  const compilation = compileSafetyScoreV9FactSetFromExtensionSource(
    input.fixedInput,
    extensionSource,
    input.evaluationFailures,
    verifiedEmptyExitByAssetId,
  );
  const compiledFacts = compilation.factSet;
  const compilerFactSchemaDigest = computeV9CompilerFactSchemaDigestForExtension(
    input.fixedInput,
    extension,
    compiledFacts,
  );
  const producerCapabilityDigest = computeV9ProducerCapabilityDigestForExtension(input.fixedInput, extension);

  const { dependencyPlan, planningById, upstreamsByAssetId, openEvidenceCatalog } =
    buildV9DependencyPlanForCompiledFacts(compiledFacts);
  const marketRanks = computeV9MarketRanks([...planningById.values()], compiledFacts.activeAssetIds);
  const commonSignals = computeV9CommonModeSignalsForPlan(dependencyPlan, policy, planningById);
  const partition = partitionV9DependencyChunks(dependencyPlan, upstreamsByAssetId, input.maxChunkAssets);

  const factsById = new Map(compiledFacts.assets.map((asset) => [asset.assetId, asset]));
  const dexObservedById = new Map(Object.entries(input.fixedInput.dexLiqMap).map(([id, row]) => [id, row.updatedAt]));
  const scoreGradeLiveReserveIds = new Set(
    compiledFacts.assets
      .filter((asset) => asset.reserveExposures.some((exposure) => exposure.provenance === "live"))
      .map((asset) => asset.assetId),
  );

  const factShards: V9EvalFactShardPayload[] = partition.chunks.map((chunkIds, chunkIndex) => {
    const assets: V9EvalFactShardAsset[] = chunkIds.map((assetId) => {
      const facts = factsById.get(assetId);
      if (!facts) throw new Error(`Missing compiled facts for V9 chunk asset ${assetId}`);
      return {
        assetId,
        facts,
        display: projectV9PublicDisplayMetadata(facts),
        dependencyMetadata: serializeV9PublicDependencyMetadata(
          facts,
          compiledFacts,
          input.fixedInput,
          ACTIVE_META_BY_ID.get(assetId),
          reserveRejections,
        ),
        backingFromLiveReserves: scoreGradeLiveReserveIds.has(assetId),
        dexObservedAtSec: dexObservedById.get(assetId) ?? null,
        marketRank: marketRanks.get(assetId) ?? null,
        dependencySignals: commonSignals.get(assetId) ?? [],
      };
    });
    return { chunkIndex, assets };
  });

  const quarantines = compilation.quarantines;
  const quarantineAffectedAssetIds = computeV9QuarantineAffectedAssetIds(compiledFacts, quarantines);
  const sourceGenerations = extractV9SourceGenerations(compiledFacts);
  const sortedGlobalAssetIds = [...compiledFacts.activeAssetIds].sort(compareText);

  const header: V9EvalRunContextHeader = {
    schemaVersion: 1,
    runId: input.runId,
    quarantineEpoch: input.quarantineEpoch,
    clockSec,
    policyVersion,
    factSetDigest: compiledFacts.v9FactSetDigest,
    baseInputGenerationId: compiledFacts.baseInputGenerationId,
    evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
    sourceGenerations,
    compilerFactSchemaDigest,
    producerCapabilityDigest,
    dexExitRouteMaxAgeSec,
    dependencyPlan,
    chunkAssetIds: partition.chunks,
    exportedUpstreamsByChunk: partition.exportedUpstreamsByChunk,
    requiredPriorChunksByChunk: partition.requiredPriorChunksByChunk,
    sortedGlobalAssetIds,
    evaluationFailures: [...input.evaluationFailures.entries()].sort(([a], [b]) => compareText(a, b)),
    expiryWitnesses: [...input.expiryWitnesses.entries()].sort(([a], [b]) => compareText(a, b)),
    quarantines,
    quarantineAffectedAssetIds,
    maxChunkAssets: input.maxChunkAssets,
    deferPublicMaterialization: input.deferPublicMaterialization,
    hasFixedInputCacheValue: input.hasFixedInputCacheValue,
  };

  const commitContext: V9EvalCommitContextBlob = {
    schemaVersion: 1,
    openEvidenceCatalog,
    acceptedPublication: input.acceptedPublication,
    previousHealth: input.previousHealth,
    expiredRoutes: serializeExpiredRoutes(projectExpiredMeasuredExitRoutes(input.fixedInput)),
    ...(verifiedEmptyExitByAssetId === undefined ? {} : { verifiedEmptyExitByAssetId }),
    transferMaterialityGeneration: input.transferMaterialityGeneration,
    laneIncidentCertificates: [...input.laneIncidentCertificates.entries()].sort(([a], [b]) => compareText(a, b)),
    laneEmitterDescriptors: input.laneEmitterDescriptors,
    laneCertificateWarnings: [...input.laneCertificateWarnings],
    bridgeJoinDiagnostics: compilation.bridgeJoinDiagnostics,
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
    factShards,
    policyDigest: policy.semanticDigest,
    planDigest: dependencyPlan.planDigest,
    factSetDigest: compiledFacts.v9FactSetDigest,
  };
}

async function persistEpochStagingChunks(
  db: D1Database,
  input: {
    runId: string;
    quarantineEpoch: number;
    header: V9EvalRunContextHeader;
    commitContext: V9EvalCommitContextBlob;
    factShards: readonly V9EvalFactShardPayload[];
    nowSec: number;
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
    },
    input.signal,
  );
  totalChunkBytes += commitWrite.totalBytes;

  for (const shard of input.factShards) {
    const written = await writeV9EvalChunk(
      db,
      {
        runId: input.runId,
        chunkKind: "fact_shard",
        chunkIndex: shard.chunkIndex,
        quarantineEpoch: input.quarantineEpoch,
        value: shard,
        createdAt: input.nowSec,
      },
      input.signal,
    );
    totalChunkBytes += written.totalBytes;
  }
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
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1_000);
  const swept = await sweepStaleV9EvalRuns(input.db, nowSec, nowMs, input.signal);

  const acceptedState = await loadSafetyScoreV9AcceptedBaselineState(input.db, input.signal);
  if (acceptedState.kind === "unavailable") {
    throw new SafetyScoreV9AcceptedBaselineProjectionError(acceptedState.reason);
  }
  const acceptedPublication = acceptedState.kind === "accepted" ? acceptedState.projection.baseline : null;
  const acceptedBaselineSha256 =
    acceptedPublication === null ? null : sha256Hex(stableJsonStringifyV1(acceptedPublication));
  const previousHealth = acceptedState.health;

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
    acceptedPublication,
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
    chunkCount: artifacts.factShards.length,
    chunkSizes: artifacts.factShards.map((shard) => shard.assets.length),
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
        input.workerVersion,
        acceptedPublication?.publicationGenerationId ?? null,
        acceptedBaselineSha256,
        normalizedInput.dexGenerationId,
        normalizedInput.redemptionGenerationId,
        artifacts.factSetDigest,
        artifacts.planDigest,
        artifacts.policyDigest,
        artifacts.factShards.length,
        input.sourceInvocationId,
        planMetadata,
        nowSec,
        nowSec,
      ),
    ],
    { signal: input.signal },
  );

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
          fixedInputCacheValue: input.fixedInputCacheValue ?? null,
        } satisfies V9EvalPinnedInputBlob,
        createdAt: nowSec,
      },
      input.signal,
    );
    const epochWrite = await persistEpochStagingChunks(input.db, {
      runId,
      quarantineEpoch: 0,
      header: artifacts.header,
      commitContext: artifacts.commitContext,
      factShards: artifacts.factShards,
      nowSec,
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
                AND execution_generation = 1`,
          ).bind(nowSec, runId),
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
      chunkCount: artifacts.factShards.length,
      factSetDigest: artifacts.factSetDigest,
      planDigest: artifacts.planDigest,
      policyDigest: artifacts.policyDigest,
      sweptRunIds: swept.sweptRunIds,
      supersededRunIds,
      totalStagedBytes: pinnedWrite.totalBytes + epochWrite.totalChunkBytes,
      nextMessage,
    };
  } catch (error) {
    await markV9EvalRunFailedAndPrune(
      input.db,
      runId,
      `seed-failed:${toErrorMessage(error).slice(0, 200)}`,
      Math.floor(Date.now() / 1_000),
    ).catch(() => undefined);
    throw error;
  }
}

async function escalateQuarantineEpoch(input: {
  db: D1Database;
  run: V9EvalRunRow;
  header: V9EvalRunContextHeader;
  commitContext: V9EvalCommitContextBlob;
  newFailures: readonly [string, string][];
  updatedExpiryWitnesses: ReadonlyMap<string, SafetyScoreV9DexExpiryWitness[]>;
  sourceInvocationId: string;
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

  const pinned = await readV9EvalChunk<V9EvalPinnedInputBlob>(
    input.db,
    {
      runId: input.run.run_id,
      chunkKind: "run_context",
      chunkIndex: RUN_CONTEXT_PINNED_INPUT_INDEX,
      quarantineEpoch: 0,
    },
    input.signal,
  );
  if (!pinned) {
    throw new Error(`Missing pinned input blob for V9 quarantine escalation on ${input.run.run_id}`);
  }

  const nextEpoch = input.run.quarantine_epoch + 1;
  const nowSec = Math.floor(Date.now() / 1_000);
  const artifacts = buildEpochStageArtifacts({
    runId: input.run.run_id,
    quarantineEpoch: nextEpoch,
    fixedInput: withNormalizedV9JournalProjections(pinned.fixedInput),
    acceptedPublication: input.commitContext.acceptedPublication,
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

  // Prune all previous-epoch staged blobs while preserving immutable pinned input (run_context[1]).
  await executeAtomicBatch(
    input.db,
    [
      input.db.prepare(
        `DELETE FROM v9_eval_chunks
          WHERE run_id = ?
            AND NOT (chunk_kind = 'run_context' AND chunk_index = ?)`,
      ).bind(input.run.run_id, RUN_CONTEXT_PINNED_INPUT_INDEX),
    ],
    { signal: input.signal },
  );

  await persistEpochStagingChunks(input.db, {
    runId: input.run.run_id,
    quarantineEpoch: nextEpoch,
    header: artifacts.header,
    commitContext: artifacts.commitContext,
    factShards: artifacts.factShards,
    nowSec,
    signal: input.signal,
  });

  const update = await runWithOverloadRetry(
    () =>
      input.db.batch([
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
              AND quarantine_epoch = ?`,
        ).bind(
          nextEpoch,
          artifacts.factShards.length,
          artifacts.factSetDigest,
          artifacts.planDigest,
          nowSec,
          input.run.run_id,
          input.run.execution_generation,
          input.run.quarantine_epoch,
        ),
      ]),
    3,
    input.signal,
  );
  if (update[0]?.meta.changes !== 1) {
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

function assertRunMatchesRunningBuild(run: V9EvalRunRow): void {
  const registryFingerprint = computeReportCardsRegistryFingerprint();
  const policyDigest = currentV9PolicyDigestForClock(run.clock_sec);
  if (
    run.evaluation_build_digest !== SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST ||
    run.registry_fingerprint !== registryFingerprint ||
    run.policy_digest !== policyDigest
  ) {
    throw new Error("v9-eval-build-drift");
  }
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
      payloadSha256: string;
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
      payloadSha256: string;
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
      reasons: V9PublicationHoldReason[];
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
  assertRunMatchesRunningBuild(run);
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
  if (!header) throw new Error(`Missing run_context header for ${run.run_id}`);

  const factShard = await readV9EvalChunk<V9EvalFactShardPayload>(
    db,
    {
      runId: run.run_id,
      chunkKind: "fact_shard",
      chunkIndex,
      quarantineEpoch: run.quarantine_epoch,
    },
    options.signal,
  );
  if (!factShard) throw new Error(`Missing fact_shard[${chunkIndex}] for ${run.run_id}`);

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
      throw new Error(`Missing upstream_state[${priorChunkIndex}] required by chunk ${chunkIndex}`);
    }
    priorUpstreams.push(...upstreamPayload.upstreams);
  }

  const priorDocumentationGapEntries: Array<[string, V9DocumentationClassification]> = [];
  for (let prior = 0; prior < chunkIndex; prior++) {
    const summary = await readV9EvalChunk<V9EvalChunkSummaryPayload>(
      db,
      {
        runId: run.run_id,
        chunkKind: "chunk_summary",
        chunkIndex: prior,
        quarantineEpoch: run.quarantine_epoch,
      },
      options.signal,
    );
    if (!summary) throw new Error(`Missing chunk_summary[${prior}] for ${run.run_id}`);
    priorDocumentationGapEntries.push(...summary.localDocumentationGapEntries);
  }

  const policy = loadV9CandidateMethodologyPolicy(header.clockSec);
  assertV9ValidatedPolicyEnvelope(policy);
  const sortedGlobalAssetIndexById = new Map(header.sortedGlobalAssetIds.map((id, index) => [id, index]));

  const outcome = evaluateV9Chunk({
    chunkIndex,
    factShard,
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
    if (!commitContext) throw new Error(`Missing commit context for quarantine escalation on ${run.run_id}`);
    const escalated = await escalateQuarantineEpoch({
      db,
      run,
      header,
      commitContext,
      newFailures: outcome.failures,
      updatedExpiryWitnesses: new Map(header.expiryWitnesses),
      sourceInvocationId,
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

  const statements: D1PreparedStatement[] = [
    ...buildWriteV9EvalChunkStatements(db, {
      runId: run.run_id,
      chunkKind: "card_shard",
      chunkIndex,
      quarantineEpoch: run.quarantine_epoch,
      value: outcome.cardShard,
      createdAt: nowSec,
    }).statements,
    ...buildWriteV9EvalChunkStatements(db, {
      runId: run.run_id,
      chunkKind: "chunk_summary",
      chunkIndex,
      quarantineEpoch: run.quarantine_epoch,
      value: outcome.chunkSummary,
      createdAt: nowSec,
    }).statements,
    ...(outcome.upstreamState.upstreams.length > 0
      ? buildWriteV9EvalChunkStatements(db, {
          runId: run.run_id,
          chunkKind: "upstream_state",
          chunkIndex,
          quarantineEpoch: run.quarantine_epoch,
          value: outcome.upstreamState,
          createdAt: nowSec,
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
          AND execution_generation = ?`,
    ).bind(
      nextChunkIndex,
      nextStage,
      nowSec,
      run.run_id,
      chunkIndex,
      run.quarantine_epoch,
      run.execution_generation,
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

/** Execute one claimed `commit` stage (canonical assembly, 10.35 check, assess, persist). */
export async function runChunkedV9CommitStep(
  db: D1Database,
  run: V9EvalRunRow,
  sourceInvocationId: string,
  options: RunChunkedV9StageOptions,
): Promise<V9ChunkedStageStepResult> {
  throwIfAborted(options.signal);
  assertRunMatchesRunningBuild(run);
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
  if (!header || !commitContext) {
    throw new Error(`Missing commit context for V9 eval run ${run.run_id}`);
  }

  const chunkSummaries: V9EvalChunkSummaryPayload[] = [];
  const cardShards: V9EvalCardShardPayload[] = [];
  for (let chunkIndex = 0; chunkIndex < run.chunk_count; chunkIndex++) {
    const summary = await readV9EvalChunk<V9EvalChunkSummaryPayload>(
      db,
      {
        runId: run.run_id,
        chunkKind: "chunk_summary",
        chunkIndex,
        quarantineEpoch: run.quarantine_epoch,
      },
      options.signal,
    );
    const shard = await readV9EvalChunk<V9EvalCardShardPayload>(
      db,
      {
        runId: run.run_id,
        chunkKind: "card_shard",
        chunkIndex,
        quarantineEpoch: run.quarantine_epoch,
      },
      options.signal,
    );
    if (!summary || !shard) {
      throw new Error(`Missing staged outputs for chunk ${chunkIndex} on ${run.run_id}`);
    }
    chunkSummaries.push(summary);
    cardShards.push(shard);
  }

  const policy = loadV9CandidateMethodologyPolicy(header.clockSec);
  assertV9ValidatedPolicyEnvelope(policy);

  const assembled = assembleV9ChunkedCandidate({
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
    openEvidenceCatalog: commitContext.openEvidenceCatalog,
    chunkSummaries,
    cardShards,
    verifiedEmptyExitByAssetId: commitContext.verifiedEmptyExitByAssetId,
  });

  // 10.35 measured-exit expiry check: escalate quarantine monotonically without partial visibility.
  const expiredRoutes = deserializeExpiredRoutes(commitContext.expiredRoutes);
  const hysteresisCandidate = applySafetyScoreV9GradeHysteresis(
    assembled.candidate,
    commitContext.acceptedPublication,
  );
  const expiry = resolveMeasuredExitExpiry(
    expiredRoutes,
    hysteresisCandidate,
    commitContext.acceptedPublication,
    assembled.internalExitRoutesByAssetId,
  );
  const expiryWitnesses = new Map(header.expiryWitnesses);
  for (const [assetId, witnesses] of Object.entries(expiry.witnessesByAssetId)) {
    if (!expiryWitnesses.has(assetId)) expiryWitnesses.set(assetId, witnesses);
  }
  const existingFailures = new Map(header.evaluationFailures);
  const pendingExpiry = expiry.assetIds.filter(
    (assetId) => !existingFailures.has(assetId) && !header.quarantines.some((q) => q.assetId === assetId),
  );
  if (pendingExpiry.length > 0) {
    const newFailures: Array<[string, string]> = pendingExpiry.map((assetId) => [
      assetId,
      formatV9MeasuredExitExpiryMessage(expiry.witnessesByAssetId[assetId]!, header.clockSec).slice(0, 500),
    ]);
    const escalated = await escalateQuarantineEpoch({
      db,
      run,
      header,
      commitContext,
      newFailures,
      updatedExpiryWitnesses: expiryWitnesses,
      sourceInvocationId,
      signal: options.signal,
    });
    return {
      status: "quarantine-escalated",
      stage: "commit",
      quarantineEpoch: escalated.quarantineEpoch,
      nextMessage: escalated.nextMessage,
    };
  }

  const publication: SafetyScoreV9CurrentResponse = hysteresisCandidate;
  const coverageFloors = observationCoverageFloors(
    publication.cards.length,
    commitContext.activeAssetCount,
    publication.completeness.ratedCount,
  );
  const measuredExitExpiryAssetIds = [...expiryWitnesses.keys()].sort(compareText);
  const measuredExitExpiryWitnessesByAssetId = Object.fromEntries(
    [...expiryWitnesses].sort(([left], [right]) => compareText(left, right)),
  );

  let assessment;
  try {
    assessment = assessV9Publication({
      inputHealth: commitContext.inputHealth,
      expiredMeasuredExitAssetIds: [
        ...new Set([
          ...measuredExitExpiryAssetIds,
          ...expiredMeasuredExitAssetIdsFromRoutes(expiredRoutes, publication, commitContext.acceptedPublication),
        ]),
      ],
      candidate: publication,
      acceptedPublication: commitContext.acceptedPublication,
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
  const attemptedAtSec = Math.max(header.clockSec, nowSec);
  const attemptId = `safety-score-v9-publication:${attemptedAtSec}`;
  const journalFixedInputSummary = {
    sourceGeneration: commitContext.sourceGeneration,
    baseInputGenerationId: commitContext.baseInputGenerationId,
    dexGenerationId: commitContext.dexGenerationId,
    redemptionGenerationId: commitContext.redemptionGenerationId,
    registryFingerprint: commitContext.registryFingerprint,
    inputFreshness: commitContext.inputFreshness,
  };

  if (assessment.decision === "hold") {
    await persistSafetyScoreV9Publication(db, {
      publicationHealth: heldPublicationHealth({
        attemptedAtSec: header.clockSec,
        reasons: assessment.reasons,
        acceptedPublication: commitContext.acceptedPublication,
        previousHealth: commitContext.previousHealth,
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

    await markV9EvalRunCompletedAndPrune(
      db,
      {
        runId: run.run_id,
        expectedGeneration: run.execution_generation,
        publicationGenerationId: null,
        payloadSha256: null,
        nowSec,
      },
      options.signal,
    );
    return {
      status: "held",
      stage: "commit",
      attemptedPublicationGenerationId: publication.publicationGenerationId,
      reasons: assessment.reasons,
      nextMessage: null,
    };
  }

  if (commitContext.baseInputGenerationId !== publication.baseInputGenerationId) {
    throw new Error("Accepted Safety Score v9 input does not match the publication base generation");
  }

  const partial = assessment.affectedAssetIds.length > 0;
  let replayCaptureValue: string | undefined;
  let fixedInputCacheValue: string | undefined;
  if (header.hasFixedInputCacheValue) {
    const pinned = await readV9EvalChunk<V9EvalPinnedInputBlob>(
      db,
      {
        runId: run.run_id,
        chunkKind: "run_context",
        chunkIndex: RUN_CONTEXT_PINNED_INPUT_INDEX,
        quarantineEpoch: 0,
      },
      options.signal,
    );
    if (pinned && pinned.fixedInputCacheValue !== null) {
      fixedInputCacheValue = pinned.fixedInputCacheValue;
      try {
        replayCaptureValue = (
          await buildSafetyScoreV9PublicationReplayCapture(
            publication,
            pinned.fixedInput,
            commitContext.transferMaterialityGeneration,
            commitContext.acceptedPublication,
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
    }
  }

  const persisted = await persistSafetyScoreV9Publication(db, {
    publication,
    buildAcceptedProjections: (accepted) =>
      buildSafetyScoreV9AcceptedProjections(
        accepted,
        measuredExitExpiryWitnessesByAssetId,
        assembled.verifiedEmptyExitBaselineOptions,
        assembled.lenderCollateralBackingScoresByAssetId,
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

  // Post-commit best-effort alert envelope, journal, and archive matching publication-runner.ts.
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

  await archiveSafetyScoreCapture({
    db,
    bucket: options.captureArchiveBucket,
    publication,
    cacheRows: persisted.captureArchiveCacheRows,
    signal: options.signal,
    deadlineMs: options.deadlineMs,
    ctx: options.captureArchiveContext,
  }).catch(() => undefined);

  const payloadSha256 =
    persisted.acceptedMaterialization?.payloadSha256 ?? sha256Hex(stableJsonStringifyV1(publication));

  if (persisted.acceptedMaterialization !== null) {
    const materializeHeader: V9MaterializeHeaderBlob = {
      schemaVersion: 1,
      publicationGenerationId: publication.publicationGenerationId,
      payloadSha256: persisted.acceptedMaterialization.payloadSha256,
      publishedAtSec: header.clockSec,
    };
    const updateNowSec = Math.floor(Date.now() / 1_000);
    const statements: D1PreparedStatement[] = [
      // Prune now-unneeded evaluation staging blobs immediately upon acceptance.
      db.prepare(`DELETE FROM v9_eval_chunks WHERE run_id = ?`).bind(run.run_id),
      ...buildWriteV9EvalChunkStatements(db, {
        runId: run.run_id,
        chunkKind: "materialize_header",
        chunkIndex: 0,
        quarantineEpoch: run.quarantine_epoch,
        value: materializeHeader,
        createdAt: updateNowSec,
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
            AND execution_generation = ?`,
      ).bind(
        publication.publicationGenerationId,
        persisted.acceptedMaterialization.payloadSha256,
        updateNowSec,
        run.run_id,
        run.execution_generation,
      ),
    ];
    await executeAtomicBatch(db, statements, { signal: options.signal });

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
      payloadSha256: persisted.acceptedMaterialization.payloadSha256,
      outcome: partial ? "partial" : "clean",
      activeAssets: commitContext.activeAssetCount,
      quarantineCount: header.quarantines.length,
      affectedAssetCount: assessment.affectedAssetIds.length,
      nextMessage,
    };
  }

  await markV9EvalRunCompletedAndPrune(
    db,
    {
      runId: run.run_id,
      expectedGeneration: run.execution_generation,
      publicationGenerationId: publication.publicationGenerationId,
      payloadSha256,
      nowSec: Math.floor(Date.now() / 1_000),
    },
    options.signal,
  );
  return {
    status: "published-materialized",
    stage: "commit",
    publicationGenerationId: publication.publicationGenerationId,
    payloadSha256,
    outcome: partial ? "partial" : "clean",
    activeAssets: commitContext.activeAssetCount,
    quarantineCount: header.quarantines.length,
    affectedAssetCount: assessment.affectedAssetIds.length,
    nextMessage: null,
  };
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
  assertRunMatchesRunningBuild(run);
  if (run.stage !== "materializing") {
    throw new Error(`V9 eval run ${run.run_id} is in stage ${run.stage}, not materializing`);
  }

  const retry = await retryPendingSafetyScoreV9PublicMaterialization(
    db,
    options.signal,
    options.deadlineMs,
  );
  if (retry === null || retry.status === "materialized" || retry.status === "superseded") {
    await markV9EvalRunCompletedAndPrune(
      db,
      {
        runId: run.run_id,
        expectedGeneration: run.execution_generation,
        publicationGenerationId: retry?.publicationGenerationId ?? run.publication_generation_id,
        payloadSha256: run.payload_sha256,
        nowSec: Math.floor(Date.now() / 1_000),
      },
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
 * unfinished active run on the current build, claims it by bumping
 * `execution_generation` (fencing stale queue deliveries), and executes its
 * unfinished stage under the shared `worker-memory-lane:safety-score-v9` lease.
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

  try {
    assertRunMatchesRunningBuild(active);
  } catch {
    await markV9EvalRunFailedAndPrune(input.db, active.run_id, "build-drift-aborted", nowSec, input.options.signal);
    return null;
  }

  const claimed = await claimActiveV9EvalRunForCronResume(
    input.db,
    {
      runId: active.run_id,
      expectedGeneration: active.execution_generation,
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
