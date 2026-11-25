import { z } from "zod";
import type {
  V9StructuralSignal,
  V9ValidatedPolicyEnvelope,
} from "@shared/types/safety-score-v9";
import type {
  CompiledV9FactSetV3,
  V9AssetFactsV3,
} from "@shared/types/safety-score-v9-facts";
import type {
  SafetyScoreV9CurrentCard,
  V9ReserveCompositionAdmission,
} from "@shared/types/safety-score-v9-public";
import {
  SafetyScoreV9CurrentResponseSchema,
  type SafetyScoreV9CurrentResponse,
} from "@shared/types/safety-score-v9-publication-response";
import type { V9QualityPillar } from "@shared/types/safety-score-v9-quality-pillars";
import { assertV9PublicCardProjections } from "@shared/lib/report-cards-v9-projections";
import {
  buildV9DependencyEvaluationPlan,
  createV9DependencyResolutionContext,
  resolveV9DependencyInput,
  type V9DependencyEvaluationPlan,
  type V9UpstreamResult,
} from "@shared/lib/safety-score-v9/dependencies";
import type { V9DocumentationAssetFacts, V9DocumentationClassification } from "@shared/lib/safety-score-v9/documentation";
import {
  evaluateV9Asset,
  type V9EvaluatedAsset,
} from "@shared/lib/safety-score-v9/evaluate-asset";
import {
  buildV9UpstreamResult,
  computeV9EvaluatedSetDigest,
  evaluatedAssetDigestPayload,
  projectPlanningFacts,
  V9AssetEvaluationError,
  type V9AssetDigestPayload,
  type V9PlanningFacts,
} from "@shared/lib/safety-score-v9/evaluate-set";
import type { V9ExitHolderEligibility } from "@shared/lib/safety-score-v9/exit";
import {
  createV9OpenEvidenceCounter,
  type V9OpenEvidenceAsset,
  type V9OpenQuestionFact,
} from "@shared/lib/safety-score-v9/open-questions";
import {
  assertV9ValidatedPolicyEnvelope,
  resolveV9PolicyChainMaturityIdentity,
} from "@shared/lib/safety-score-v9/policy";
import { compareText, uniqueSorted } from "@shared/lib/safety-score-v9/primitives";
import {
  buildV9DocumentationCarriers,
  collectV9DocumentationGapIds,
  projectSafetyScoreV9Card,
  projectSafetyScoreV9CommonModeGroups,
  V9PublicCardProjectionError,
  type V9CommonModeProjectionResult,
  type V9DocumentationCarrierCard,
  type V9PublicCardProjectionFailure,
} from "@shared/lib/safety-score-v9/public";
import { createV9PublicCardShardViewFactory } from "@shared/lib/safety-score-v9/public-card-shard";
import {
  finalizeV9PublicCauseGapCard,
  type V9InternedPublicCardDraft,
} from "@shared/lib/safety-score-v9/public-cause-interning";
import { computeV9CompactResultDigest } from "@shared/lib/safety-score-v9/trace";
import {
  computeSafetyScoreV9CandidateId,
  computeSafetyScoreV9PublicationGenerationId,
  SafetyScoreV9CandidateIdentityV1Schema,
} from "./candidate-identity";
import {
  exitPillarFreshnessFromDexInput,
  extractV9InternalTokenizedFundState,
  publicDependencyMetadata,
} from "./candidate";
import type { SafetyScoreV9CompilerInput } from "./native-input";
import type {
  BuildAcceptedBaselineVerifiedEmptyOptions,
  SafetyScoreV9InternalExitRouteSummary,
  SafetyScoreV9VerifiedEmptyExitWitness,
} from "./publication-assessment";

/** Default ADR-26 chunk cap (<= 140 assets/chunk, <= 4 chunks at 560 assets). */
export const V9_EVAL_DEFAULT_MAX_CHUNK_ASSETS = 140;

const DOCUMENTATION_PILLARS = ["backing", "exit", "control"] as const;

export interface V9PublicDisplayMetadata {
  labels: Record<string, string>;
  exitHolderEligibility: Record<string, V9ExitHolderEligibility>;
  exitRouteDetails: Record<
    string,
    {
      chain: string | null;
      protocol: string | null;
      poolId: string | null;
      evidenceKind: string;
      observedAtSec: number | null;
    }
  >;
}

export interface V9SerializedPublicDependencyMetadata {
  supply: SafetyScoreV9CurrentCard["supply"];
  sharedBookId: string | null;
  dependencyProvenance: Array<
    readonly [string, NonNullable<SafetyScoreV9CurrentCard["dependencies"]["serial"][number]["provenance"]>]
  >;
  dependencyTypes: Array<readonly [string, "wrapper" | "mechanism" | "collateral"]>;
  dependencyCoverage: NonNullable<SafetyScoreV9CurrentCard["dependencyCoverage"]>;
  reserveCompositionAdmission?: V9ReserveCompositionAdmission;
}

export interface V9EvalFactShardAsset {
  assetId: string;
  facts: V9AssetFactsV3;
  display: V9PublicDisplayMetadata;
  dependencyMetadata: V9SerializedPublicDependencyMetadata;
  backingFromLiveReserves: boolean;
  dexObservedAtSec: number | null;
  marketRank: number | null;
  dependencySignals: readonly V9StructuralSignal[];
}

export interface V9EvalFactShardPayload {
  chunkIndex: number;
  assets: V9EvalFactShardAsset[];
}

export interface V9ChunkUpstreamEvaluatedShim {
  assetId: string;
  backing: Pick<V9EvaluatedAsset["backing"], "failureDomains" | "collateralizationApplications">;
  scoreInput: {
    pillars: {
      backing: Pick<
        V9EvaluatedAsset["scoreInput"]["pillars"]["backing"],
        | "score"
        | "reasons"
        | "aggregationDisposition"
        | "excludedCauses"
        | "excludedCauseGapIds"
        | "excludedComponentKeys"
        | "causeGapIds"
        | "limitedEvidenceCauses"
        | "evidenceLevel"
      >;
    };
  };
  trace: Pick<
    V9EvaluatedAsset["trace"],
    | "assetId"
    | "ratingStatus"
    | "finalScore"
    | "inheritableScore"
    | "causeGapIds"
    | "limitedEvidenceCauses"
    | "partialEvidence"
    | "nrReasons"
    | "propagatedParentReasons"
    | "adverseAttribution"
    | "boundedUncertaintyAttribution"
  >;
}

export interface V9ChunkUpstreamSnapshot {
  assetId: string;
  upstreamResult: V9UpstreamResult;
  unavailabilityRoots: readonly string[];
  evaluatedShim: V9ChunkUpstreamEvaluatedShim;
}

export interface V9EvalUpstreamStatePayload {
  chunkIndex: number;
  upstreams: V9ChunkUpstreamSnapshot[];
}

export interface V9SerializedDocumentationCard {
  assetId: string;
  localDocumentationGapIds: string[];
  pillars: Array<{
    pillar: V9QualityPillar;
    evidenceLevel: V9EvaluatedAsset["scoreInput"]["pillars"]["backing"]["evidenceLevel"];
    limitingCauseGapIds?: readonly string[];
  }>;
}

export interface V9ChunkOpenEvidenceAssetInput {
  assetId: string;
  localDocumentationGapEntries: Array<[string, V9DocumentationClassification]>;
  unresolvedFacts: readonly V9OpenQuestionFact[];
}

export interface V9EvalChunkSummaryPayload {
  chunkIndex: number;
  localDocumentationGapEntries: Array<[string, V9DocumentationClassification]>;
  documentationCards: V9SerializedDocumentationCard[];
  openEvidenceInputs: V9ChunkOpenEvidenceAssetInput[];
  assetDigests: V9AssetDigestPayload[];
  commonModeResults: V9CommonModeProjectionResult[];
  internalLenderBackingScores: Array<[string, number]>;
  internalVerifiedEmptyExitState: Array<[string, "verified-empty" | "positive-route"]>;
  internalExitRoutes: Array<[string, SafetyScoreV9InternalExitRouteSummary]>;
  dexObservedAtSec: Array<[string, number | null]>;
  foreignCauseGaps: string[];
}

export interface V9EvalCardShardPayload {
  chunkIndex: number;
  drafts: V9InternedPublicCardDraft[];
}

export interface V9ChunkPartitionPlan {
  chunks: string[][];
  exportedUpstreamsByChunk: string[][];
  requiredPriorChunksByChunk: number[][];
}

/**
 * Partition `dependencyPlan.topologicalOrder` into dependency-ordered chunks of
 * `<= maxChunkAssets` assets, keeping every strongly connected component
 * (`cyclicComponents`) intact in one chunk and preserving exact evaluation order.
 */
export function partitionV9DependencyChunks(
  dependencyPlan: Readonly<V9DependencyEvaluationPlan>,
  upstreamsByAssetId: ReadonlyMap<string, readonly string[]>,
  maxChunkAssets = V9_EVAL_DEFAULT_MAX_CHUNK_ASSETS,
): V9ChunkPartitionPlan {
  if (!Number.isInteger(maxChunkAssets) || maxChunkAssets < 1) {
    throw new Error(`Invalid V9 maxChunkAssets: ${maxChunkAssets}`);
  }
  const sccByAsset = new Map<string, number>();
  for (let index = 0; index < dependencyPlan.cyclicComponents.length; index++) {
    for (const assetId of dependencyPlan.cyclicComponents[index]!) {
      sccByAsset.set(assetId, index);
    }
  }
  const orderIndex = new Map<string, number>();
  for (let index = 0; index < dependencyPlan.topologicalOrder.length; index++) {
    orderIndex.set(dependencyPlan.topologicalOrder[index]!, index);
  }

  // Group SCC members as atomic units in exact topological order.
  const units: string[][] = [];
  const emittedScc = new Set<number>();
  for (const assetId of dependencyPlan.topologicalOrder) {
    const sccIndex = sccByAsset.get(assetId);
    if (sccIndex === undefined) {
      units.push([assetId]);
      continue;
    }
    if (emittedScc.has(sccIndex)) continue;
    emittedScc.add(sccIndex);
    const members = [...dependencyPlan.cyclicComponents[sccIndex]!].sort(
      (left, right) => (orderIndex.get(left) ?? 0) - (orderIndex.get(right) ?? 0),
    );
    units.push(members);
  }

  const chunks: string[][] = [];
  let current: string[] = [];
  for (const unit of units) {
    if (current.length > 0 && current.length + unit.length > maxChunkAssets) {
      chunks.push(current);
      current = [];
    }
    current.push(...unit);
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length === 0) {
    throw new Error("V9 chunk partition requires at least one asset");
  }

  const chunkIndexByAsset = new Map<string, number>();
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    for (const assetId of chunks[chunkIndex]!) {
      chunkIndexByAsset.set(assetId, chunkIndex);
    }
  }

  const exportedSets = chunks.map(() => new Set<string>());
  const requiredPriorSets = chunks.map(() => new Set<number>());
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    for (const assetId of chunks[chunkIndex]!) {
      for (const upstreamId of upstreamsByAssetId.get(assetId) ?? []) {
        const upstreamChunk = chunkIndexByAsset.get(upstreamId);
        if (upstreamChunk === undefined) continue;
        if (upstreamChunk > chunkIndex) {
          throw new Error(
            `V9 chunk partition violates topological order: ${assetId} (chunk ${chunkIndex}) depends on ${upstreamId} (chunk ${upstreamChunk})`,
          );
        }
        if (upstreamChunk < chunkIndex) {
          exportedSets[upstreamChunk]!.add(upstreamId);
          requiredPriorSets[chunkIndex]!.add(upstreamChunk);
        }
      }
    }
  }

  return {
    chunks,
    exportedUpstreamsByChunk: exportedSets.map((set) => [...set].sort(compareText)),
    requiredPriorChunksByChunk: requiredPriorSets.map((set) => [...set].sort((a, b) => a - b)),
  };
}

function collectV9AssetUpstreamsMap(
  assets: readonly Pick<V9AssetFactsV3, "assetId" | "dependencies" | "reserveExposures">[],
): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const asset of assets) {
    map.set(
      asset.assetId,
      uniqueSorted([
        ...asset.dependencies.edges.map((edge) => edge.upstreamAssetId),
        ...asset.reserveExposures.flatMap((exposure) => (exposure.trackedAssetId === null ? [] : [exposure.trackedAssetId])),
      ]),
    );
  }
  return map;
}

export function serializeV9PublicDependencyMetadata(
  asset: CompiledV9FactSetV3["assets"][number],
  factSet: CompiledV9FactSetV3,
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  meta: Parameters<typeof publicDependencyMetadata>[3],
  reserveRejections: ReadonlyMap<string, V9ReserveCompositionAdmission> | undefined,
): V9SerializedPublicDependencyMetadata {
  const raw = publicDependencyMetadata(asset, factSet, fixedInput, meta);
  const reserveCompositionAdmission =
    reserveRejections?.has(asset.assetId) &&
    asset.gaps.some(
      (gap) =>
        (gap.reasonCode === "missing-reserve-composition" ||
          gap.reasonCode === "expired-reviewed-reserve-composition") &&
        asset.reserveStatus.gapIds.includes(gap.gapId),
    )
      ? reserveRejections.get(asset.assetId)
      : undefined;
  return {
    supply: raw.supply,
    sharedBookId: raw.sharedBookId,
    dependencyProvenance: [...raw.dependencyProvenance.entries()],
    dependencyTypes: [...raw.dependencyTypes.entries()],
    dependencyCoverage: raw.dependencyCoverage,
    ...(reserveCompositionAdmission === undefined ? {} : { reserveCompositionAdmission }),
  };
}

function projectChunkUpstreamSnapshot(
  evaluatedAsset: V9EvaluatedAsset,
  upstreamResult: V9UpstreamResult,
  unavailabilityRoots: readonly string[],
): V9ChunkUpstreamSnapshot {
  const backingPillar = evaluatedAsset.scoreInput.pillars.backing;
  const trace = evaluatedAsset.trace;
  return {
    assetId: evaluatedAsset.assetId,
    upstreamResult,
    unavailabilityRoots,
    evaluatedShim: {
      assetId: evaluatedAsset.assetId,
      backing: {
        failureDomains: evaluatedAsset.backing.failureDomains,
        collateralizationApplications: evaluatedAsset.backing.collateralizationApplications,
      },
      scoreInput: {
        pillars: {
          backing: {
            score: backingPillar.score,
            reasons: backingPillar.reasons,
            aggregationDisposition: backingPillar.aggregationDisposition,
            excludedCauses: backingPillar.excludedCauses,
            excludedCauseGapIds: backingPillar.excludedCauseGapIds,
            excludedComponentKeys: backingPillar.excludedComponentKeys,
            causeGapIds: backingPillar.causeGapIds,
            limitedEvidenceCauses: backingPillar.limitedEvidenceCauses,
            evidenceLevel: backingPillar.evidenceLevel,
          },
        },
      },
      trace: {
        assetId: trace.assetId,
        ratingStatus: trace.ratingStatus,
        finalScore: trace.finalScore,
        inheritableScore: trace.inheritableScore,
        causeGapIds: trace.causeGapIds,
        limitedEvidenceCauses: trace.limitedEvidenceCauses,
        partialEvidence: trace.partialEvidence,
        nrReasons: trace.nrReasons,
        propagatedParentReasons: trace.propagatedParentReasons,
        adverseAttribution: trace.adverseAttribution,
        boundedUncertaintyAttribution: trace.boundedUncertaintyAttribution,
      },
    },
  };
}

export type EvaluateV9ChunkOutcome =
  | {
      status: "ok";
      cardShard: V9EvalCardShardPayload;
      upstreamState: V9EvalUpstreamStatePayload;
      chunkSummary: V9EvalChunkSummaryPayload;
      cumulativeDocumentationGapEntries: Array<[string, V9DocumentationClassification]>;
    }
  | {
      status: "quarantine-required";
      failures: Array<[string, string]>;
    };

/**
 * Evaluate exactly one dependency-ordered chunk of V9 assets using strictly
 * pinned state and prior-chunk upstream snapshots, reusing the authoritative
 * `evaluate-set.ts` and `candidate.ts` helpers.
 */
export function evaluateV9Chunk(input: {
  chunkIndex: number;
  factShard: V9EvalFactShardPayload;
  dependencyPlan: Readonly<V9DependencyEvaluationPlan>;
  envelope: V9ValidatedPolicyEnvelope;
  identity: {
    factSetDigest: string;
    baseInputGenerationId: string;
    evaluationBuildDigest: string;
    asOfSec: number;
    sourceGenerations: Readonly<Record<string, string>>;
  };
  clockSec: number;
  dexExitRouteMaxAgeSec: number;
  priorUpstreams: readonly V9ChunkUpstreamSnapshot[];
  priorDocumentationGapEntries: readonly [string, V9DocumentationClassification][];
  exportedUpstreamIds: ReadonlySet<string>;
  sortedGlobalAssetIndexById: ReadonlyMap<string, number>;
  /** Optional test-only hook to inject deterministic evaluation/projection failures. */
  onBeforeEvaluateAsset?: (assetId: string, chunkIndex: number) => void;
}): EvaluateV9ChunkOutcome {
  assertV9ValidatedPolicyEnvelope(input.envelope);
  const dependencyResolutionContext = createV9DependencyResolutionContext(input.dependencyPlan);
  const evaluatedById = new Map<string, V9EvaluatedAsset>();
  const upstreamResultsById = new Map<string, V9UpstreamResult>();
  const unavailabilityRootsById = new Map<string, readonly string[]>();

  for (const snapshot of input.priorUpstreams) {
    evaluatedById.set(snapshot.assetId, snapshot.evaluatedShim as unknown as V9EvaluatedAsset);
    upstreamResultsById.set(snapshot.assetId, snapshot.upstreamResult);
    unavailabilityRootsById.set(snapshot.assetId, snapshot.unavailabilityRoots);
  }

  const docGapIds = new Map<string, V9DocumentationClassification>(input.priorDocumentationGapEntries);
  const localChunkDocGapEntries: Array<[string, V9DocumentationClassification]> = [];
  const documentationCards: V9SerializedDocumentationCard[] = [];
  const openEvidenceInputs: V9ChunkOpenEvidenceAssetInput[] = [];
  const assetDigests: V9AssetDigestPayload[] = [];
  const commonModeResults: V9CommonModeProjectionResult[] = [];
  const internalLenderBackingScores: Array<[string, number]> = [];
  const internalVerifiedEmptyExitState: Array<[string, "verified-empty" | "positive-route"]> = [];
  const internalExitRoutes: Array<[string, SafetyScoreV9InternalExitRouteSummary]> = [];
  const dexObservedAtSec: Array<[string, number | null]> = [];
  const foreignCauseGapSet = new Set<string>();
  const drafts: V9InternedPublicCardDraft[] = [];
  const exportedUpstreams: V9ChunkUpstreamSnapshot[] = [];
  const projectionFailures: V9PublicCardProjectionFailure[] = [];

  for (const item of input.factShard.assets) {
    const asset = item.facts;
    let evaluatedAsset: V9EvaluatedAsset;
    let unavailabilityRoots: readonly string[];
    let upstreamResult: V9UpstreamResult;
    try {
      input.onBeforeEvaluateAsset?.(asset.assetId, input.chunkIndex);
      const resolved = resolveV9DependencyInput(dependencyResolutionContext, asset.assetId, upstreamResultsById);
      const evaluated = evaluateV9Asset({
        asset,
        resolved,
        dependencyPlan: input.dependencyPlan,
        envelope: input.envelope,
        evaluatedById,
        unavailabilityRootsById,
        identity: input.identity,
        marketRank: item.marketRank,
        dependencySignals: item.dependencySignals,
      });
      evaluatedAsset = evaluated.evaluatedAsset;
      unavailabilityRoots = evaluated.unavailabilityRoots;
      upstreamResult = buildV9UpstreamResult(evaluatedAsset);
      evaluatedById.set(asset.assetId, evaluatedAsset);
      upstreamResultsById.set(asset.assetId, upstreamResult);
      unavailabilityRootsById.set(asset.assetId, unavailabilityRoots);
    } catch (error) {
      const wrapped = error instanceof V9AssetEvaluationError ? error : new V9AssetEvaluationError(asset.assetId, error);
      return { status: "quarantine-required", failures: [[wrapped.assetId, wrapped.message]] };
    }

    if (input.exportedUpstreamIds.has(asset.assetId)) {
      exportedUpstreams.push(projectChunkUpstreamSnapshot(evaluatedAsset, upstreamResult, unavailabilityRoots));
    }

    const tokenizedFundState = extractV9InternalTokenizedFundState(evaluatedAsset);
    if (tokenizedFundState !== null) {
      if (tokenizedFundState.lenderBackingScore !== null) {
        internalLenderBackingScores.push([evaluatedAsset.assetId, tokenizedFundState.lenderBackingScore]);
      }
      if (tokenizedFundState.verifiedEmptyExitState !== null) {
        internalVerifiedEmptyExitState.push([evaluatedAsset.assetId, tokenizedFundState.verifiedEmptyExitState]);
      }
      internalExitRoutes.push([evaluatedAsset.assetId, tokenizedFundState.exitRoutes]);
    }

    // Register documentation gaps in exact topological order before projection.
    const admittedExitRouteKeys = new Set<string>();
    for (const route of evaluatedAsset.exit.routes) {
      if (route.included) admittedExitRouteKeys.add(route.routeKey);
    }
    const enrichedDocFacts: V9DocumentationAssetFacts = {
      ...asset,
      admittedExitRouteKeys,
    };
    const assetLocalDocGapIds: string[] = [];
    const assetLocalDocEntries: Array<[string, V9DocumentationClassification]> = [];
    for (const [gapId, classification] of collectV9DocumentationGapIds(input.envelope, [enrichedDocFacts])) {
      assetLocalDocGapIds.push(gapId);
      assetLocalDocEntries.push([gapId, classification]);
      localChunkDocGapEntries.push([gapId, classification]);
      docGapIds.set(gapId, classification);
    }
    documentationCards.push({
      assetId: evaluatedAsset.assetId,
      localDocumentationGapIds: assetLocalDocGapIds,
      pillars: DOCUMENTATION_PILLARS.map((pillar) => ({
        pillar,
        evidenceLevel: evaluatedAsset.scoreInput.pillars[pillar].evidenceLevel,
        limitingCauseGapIds: evaluatedAsset.scoreInput.pillars[pillar].limitingCauseGapIds,
      })),
    });
    openEvidenceInputs.push({
      assetId: evaluatedAsset.assetId,
      localDocumentationGapEntries: assetLocalDocEntries,
      unresolvedFacts: evaluatedAsset.trace.unresolvedFacts,
    });

    assetDigests.push(evaluatedAssetDigestPayload(evaluatedAsset));
    commonModeResults.push({
      trace: {
        assetId: evaluatedAsset.trace.assetId,
        structuralSignals: evaluatedAsset.trace.structuralSignals.map((signal) => ({
          kind: signal.kind,
          severity: signal.severity,
          reason: signal.reason,
          failureDomainKeys: signal.failureDomainKeys,
          economicLossScope: signal.economicLossScope,
          responsibility: signal.responsibility,
          pricedInPillar: signal.pricedInPillar,
        })),
        caps: evaluatedAsset.trace.caps,
        deploymentAdjustments: evaluatedAsset.trace.deploymentAdjustments,
      },
    });
    dexObservedAtSec.push([evaluatedAsset.assetId, item.dexObservedAtSec]);

    try {
      const { card, foreignCauseGaps } = projectSafetyScoreV9Card({
        trace: evaluatedAsset.trace,
        ...(evaluatedAsset.providerRowExclusions?.length
          ? { providerRowExclusions: evaluatedAsset.providerRowExclusions }
          : {}),
        backingFromLiveReserves: item.backingFromLiveReserves,
        supply: item.dependencyMetadata.supply,
        sharedBookId: item.dependencyMetadata.sharedBookId,
        dependencyProvenance: new Map(item.dependencyMetadata.dependencyProvenance),
        dependencyTypes: new Map(item.dependencyMetadata.dependencyTypes),
        dependencyCoverage: item.dependencyMetadata.dependencyCoverage,
        ...(item.dependencyMetadata.reserveCompositionAdmission === undefined
          ? {}
          : { reserveCompositionAdmission: item.dependencyMetadata.reserveCompositionAdmission }),
        scoreInput: evaluatedAsset.scoreInput,
        access: evaluatedAsset.access,
        dependencyInputs: evaluatedAsset.dependencyInputs,
        policy: input.envelope,
        backing: evaluatedAsset.backing,
        exit: evaluatedAsset.exit,
        control: evaluatedAsset.control,
        display: item.display,
        freshness: {
          exit: exitPillarFreshnessFromDexInput(
            input.clockSec,
            item.dexObservedAtSec,
            input.dexExitRouteMaxAgeSec,
          ),
        },
        dexObservedAtSec: item.dexObservedAtSec,
        documentationGapIds: docGapIds,
      });
      assertV9PublicCardProjections(card);
      const { foreignCauseGapRefs: _localRefs, ...draft } = card;
      for (const id of foreignCauseGaps) foreignCauseGapSet.add(id);
      drafts.push({ ...draft, foreignCauseGaps });
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      const globalIndex = input.sortedGlobalAssetIndexById.get(evaluatedAsset.assetId) ?? 0;
      projectionFailures.push({
        assetId: evaluatedAsset.assetId,
        issues: error.issues.map((issue) => ({ ...issue, path: ["cards", globalIndex, ...issue.path] })),
      });
    }
  }

  if (projectionFailures.length > 0) {
    projectionFailures.sort((left, right) => compareText(left.assetId, right.assetId));
    const projectionError = new V9PublicCardProjectionError(projectionFailures);
    return {
      status: "quarantine-required",
      failures: projectionError.failures.map((failure) => [
        failure.assetId,
        projectionError.messageFor(failure.assetId),
      ]),
    };
  }

  return {
    status: "ok",
    cardShard: {
      chunkIndex: input.chunkIndex,
      drafts,
    },
    upstreamState: {
      chunkIndex: input.chunkIndex,
      upstreams: exportedUpstreams,
    },
    chunkSummary: {
      chunkIndex: input.chunkIndex,
      localDocumentationGapEntries: localChunkDocGapEntries,
      documentationCards,
      openEvidenceInputs,
      assetDigests,
      commonModeResults,
      internalLenderBackingScores,
      internalVerifiedEmptyExitState,
      internalExitRoutes,
      dexObservedAtSec,
      foreignCauseGaps: [...foreignCauseGapSet].sort(),
    },
    cumulativeDocumentationGapEntries: [...docGapIds.entries()],
  };
}

/**
 * Assemble the canonical `SafetyScoreV9CurrentResponse` and exact publication
 * metadata from all chunk summaries and card shards, matching monolithic
 * `candidate.ts` byte-for-byte.
 */
export function assembleV9ChunkedCandidate(input: {
  envelope: V9ValidatedPolicyEnvelope;
  policyVersion: string;
  publishedAtSec: number;
  factSetDigest: string;
  baseInputGenerationId: string;
  evaluationBuildDigest: string;
  asOfSec: number;
  sourceGenerations: Readonly<Record<string, string>>;
  dependencyPlan: Readonly<V9DependencyEvaluationPlan>;
  compilerFactSchemaDigest: string;
  producerCapabilityDigest: string;
  dexExitRouteMaxAgeSec: number;
  openEvidenceCatalog: readonly V9OpenEvidenceAsset[];
  chunkSummaries: readonly V9EvalChunkSummaryPayload[];
  cardShards: readonly V9EvalCardShardPayload[];
  verifiedEmptyExitByAssetId?: Readonly<Record<string, SafetyScoreV9VerifiedEmptyExitWitness>>;
}): {
  candidate: SafetyScoreV9CurrentResponse;
  scoreResultDigest: string;
  evaluatedSetDigest: string;
  candidateId: string;
  publicationGenerationId: string;
  verifiedEmptyExitBaselineOptions: BuildAcceptedBaselineVerifiedEmptyOptions;
  lenderCollateralBackingScoresByAssetId: Record<string, number>;
  internalExitRoutesByAssetId: Record<string, SafetyScoreV9InternalExitRouteSummary>;
} {
  assertV9ValidatedPolicyEnvelope(input.envelope);
  const allAssetDigests: V9AssetDigestPayload[] = [];
  const allCommonModeResults: V9CommonModeProjectionResult[] = [];
  const allDocCards: V9DocumentationCarrierCard[] = [];
  const allForeignGapIds = new Set<string>();
  const dexObservedMap = new Map<string, number | null>();
  const internalLenderBacking = new Map<string, number>();
  const internalVerifiedEmpty = new Map<string, "verified-empty" | "positive-route">();
  const internalExitRoutes = new Map<string, SafetyScoreV9InternalExitRouteSummary>();

  // Replay openEvidence in exact topological order with advancing docGapIds union.
  const docGapIds = new Map<string, V9DocumentationClassification>();
  const openEvidenceCounter = createV9OpenEvidenceCounter(
    input.openEvidenceCatalog,
    (gap) => docGapIds.get(gap.gapId)?.reason ?? null,
  );

  for (const summary of input.chunkSummaries) {
    for (const digest of summary.assetDigests) allAssetDigests.push(digest);
    for (const cm of summary.commonModeResults) allCommonModeResults.push(cm);
    for (const id of summary.foreignCauseGaps) allForeignGapIds.add(id);
    for (const [assetId, ts] of summary.dexObservedAtSec) dexObservedMap.set(assetId, ts);
    for (const [assetId, score] of summary.internalLenderBackingScores) internalLenderBacking.set(assetId, score);
    for (const [assetId, state] of summary.internalVerifiedEmptyExitState) internalVerifiedEmpty.set(assetId, state);
    for (const [assetId, routes] of summary.internalExitRoutes) internalExitRoutes.set(assetId, routes);
    for (const card of summary.documentationCards) {
      allDocCards.push({
        assetId: card.assetId,
        localDocumentationGapIds: new Set(card.localDocumentationGapIds),
        pillars: card.pillars,
      });
    }
    for (const entry of summary.openEvidenceInputs) {
      for (const [gapId, classification] of entry.localDocumentationGapEntries) {
        docGapIds.set(gapId, classification);
      }
      openEvidenceCounter.add({
        assetId: entry.assetId,
        trace: { unresolvedFacts: entry.unresolvedFacts },
      });
    }
  }

  allAssetDigests.sort((left, right) => compareText(left.compactTrace.assetId, right.compactTrace.assetId));
  const scoreResultDigest = computeV9CompactResultDigest(allAssetDigests.map((asset) => asset.compactTrace));
  const evaluatedSetDigest = computeV9EvaluatedSetDigest(
    {
      schemaVersion: 1,
      factSetDigest: input.factSetDigest,
      baseInputGenerationId: input.baseInputGenerationId,
      policyId: input.envelope.policy.policyId,
      policyDigest: input.envelope.semanticDigest,
      chainMaturityPolicy: resolveV9PolicyChainMaturityIdentity(input.envelope),
      evaluationBuildDigest: input.evaluationBuildDigest,
      asOfSec: input.asOfSec,
      sourceGenerations: input.sourceGenerations,
      dependencyPlan: input.dependencyPlan,
      evaluationOrder: input.dependencyPlan.topologicalOrder,
      scoreResultDigest,
    },
    allAssetDigests,
  );

  const candidateIdentity = SafetyScoreV9CandidateIdentityV1Schema.parse({
    schemaVersion: 1,
    policyId: input.envelope.policy.policyId,
    policyDigest: input.envelope.semanticDigest,
    evaluationBuildDigest: input.evaluationBuildDigest,
    compilerFactSchemaDigest: input.compilerFactSchemaDigest,
    producerCapabilityDigest: input.producerCapabilityDigest,
  });
  const candidateId = computeSafetyScoreV9CandidateId(candidateIdentity);
  const publicationGenerationId = computeSafetyScoreV9PublicationGenerationId({
    candidateId,
    baseInputGenerationId: input.baseInputGenerationId,
    factSetDigest: input.factSetDigest,
    evaluatedSetDigest,
    resultDigest: scoreResultDigest,
    publishedAtSec: input.publishedAtSec,
  });

  const openEvidence = openEvidenceCounter.finish();
  const carriers = buildV9DocumentationCarriers({
    envelope: input.envelope,
    gapIds: docGapIds,
    cards: allDocCards,
    openEvidence,
  });

  const foreignCauseGaps = [...allForeignGapIds].sort();
  const foreignRefs = new Map(foreignCauseGaps.map((id, index) => [id, index]));
  const compactCard = createV9PublicCardShardViewFactory();
  const finalizedById = new Map<string, SafetyScoreV9CurrentCard>();
  for (const shard of input.cardShards) {
    for (const draft of shard.drafts) {
      finalizedById.set(draft.id, compactCard(finalizeV9PublicCauseGapCard(draft, foreignRefs)));
    }
  }
  const ids = [...finalizedById.keys()].sort(compareText);
  const cards = ids.map((id) => finalizedById.get(id)!);

  const notRatedIds = cards.filter((card) => card.ratingStatus === "not-rated").map((card) => card.id);
  const pipelineGapIds = cards.filter((card) => card.ratingStatus === "pipeline-gap").map((card) => card.id);

  let documentationCauseGaps: string[] | undefined;
  if (carriers.causeGapIds.length > 0) {
    const resolvable = new Set<string>(foreignCauseGaps);
    for (const card of cards) {
      for (const gapId of card.localCauseGaps) resolvable.add(`${card.id}:gap:${gapId}`);
    }
    documentationCauseGaps = uniqueSorted(carriers.causeGapIds.filter((id) => resolvable.has(id)));
  }

  const commonModeGroups = projectSafetyScoreV9CommonModeGroups(
    input.dependencyPlan.commonModeGroups,
    allCommonModeResults,
    cards,
  );

  const admittedCards = new WeakSet<object>(cards);
  const responseSchema = SafetyScoreV9CurrentResponseSchema.safeExtend({
    cards: z.array(
      z.custom<SafetyScoreV9CurrentCard>((value) => value !== null && typeof value === "object" && admittedCards.has(value)),
    ),
  });
  const canonicalSourceGens = Object.fromEntries(
    Object.entries(input.sourceGenerations).sort(([left], [right]) => compareText(left, right)),
  );
  const candidate = responseSchema.parse({
    model: "v9-critical-path",
    schemaVersion: 8,
    openEvidence: carriers.openEvidence,
    lifecycle: "active",
    candidateId,
    policyVersion: input.policyVersion,
    publicationGenerationId,
    baseInputGenerationId: input.baseInputGenerationId,
    factSetDigest: input.factSetDigest,
    resultDigest: scoreResultDigest,
    policy: { id: input.envelope.policy.policyId, semanticDigest: input.envelope.semanticDigest },
    evaluationBuildDigest: input.evaluationBuildDigest,
    sourceGenerations: canonicalSourceGens,
    asOfSec: input.asOfSec,
    publishedAtSec: input.publishedAtSec,
    completeness: {
      expectedCount: cards.length,
      ratedCount: cards.length - notRatedIds.length - pipelineGapIds.length,
      notRatedCount: notRatedIds.length,
      notRatedIds,
      pipelineGapCount: pipelineGapIds.length,
      pipelineGapIds,
    },
    cards,
    foreignCauseGaps,
    ...(documentationCauseGaps === undefined ? {} : { documentationCauseGaps }),
    pillarFreshness: {
      dexMaxAgeSec: input.dexExitRouteMaxAgeSec,
      dexObservedAtSec: ids.map((id) => {
        if (!dexObservedMap.has(id)) throw new Error(`Missing DEX freshness clock for ${id}`);
        return dexObservedMap.get(id)!;
      }),
    },
    commonModeGroups,
  });

  const observedAtEntries = [...dexObservedMap.entries()]
    .filter((entry): entry is [string, number] => entry[1] !== null)
    .sort(([left], [right]) => compareText(left, right));
  const verifiedEmptyExitBaselineOptions: BuildAcceptedBaselineVerifiedEmptyOptions = {
    ...(input.verifiedEmptyExitByAssetId === undefined
      ? {}
      : { priorVerifiedEmptyExitByAssetId: input.verifiedEmptyExitByAssetId }),
    observedAtByAssetId: Object.fromEntries(observedAtEntries),
    verifiedEmptyCarryMaxAgeSec: input.envelope.policy.semantic.exit.verifiedEmptyCarryMaxAgeSec,
    ...(internalVerifiedEmpty.size === 0
      ? {}
      : {
          internalExitStateByAssetId: Object.fromEntries(
            [...internalVerifiedEmpty].sort(([left], [right]) => compareText(left, right)),
          ),
        }),
  };

  return {
    candidate,
    scoreResultDigest,
    evaluatedSetDigest,
    candidateId,
    publicationGenerationId,
    verifiedEmptyExitBaselineOptions,
    lenderCollateralBackingScoresByAssetId: Object.fromEntries(
      [...internalLenderBacking].sort(([left], [right]) => compareText(left, right)),
    ),
    internalExitRoutesByAssetId: Object.fromEntries(
      [...internalExitRoutes].sort(([left], [right]) => compareText(left, right)),
    ),
  };
}

export function buildV9DependencyPlanForCompiledFacts(
  factSet: CompiledV9FactSetV3,
): {
  dependencyPlan: Readonly<V9DependencyEvaluationPlan>;
  planningById: Map<string, V9PlanningFacts>;
  upstreamsByAssetId: Map<string, readonly string[]>;
  openEvidenceCatalog: V9OpenEvidenceAsset[];
} {
  const planningById = new Map<string, V9PlanningFacts>();
  const openEvidenceCatalog: V9OpenEvidenceAsset[] = [];
  for (const asset of factSet.assets) {
    planningById.set(asset.assetId, projectPlanningFacts(asset));
    openEvidenceCatalog.push({
      assetId: asset.assetId,
      gaps: asset.gaps,
      controls: asset.controls.map((control) => ({
        controlKey: control.controlKey,
        deploymentKey: control.deploymentKey,
        ...(control.authoredControlId === undefined ? {} : { authoredControlId: control.authoredControlId }),
      })),
    });
  }
  const planningAssets = [...planningById.values()];
  const dependencyPlan = buildV9DependencyEvaluationPlan({
    activeAssetIds: factSet.activeAssetIds,
    assets: planningAssets,
  });
  const upstreamsByAssetId = collectV9AssetUpstreamsMap(factSet.assets);
  return { dependencyPlan, planningById, upstreamsByAssetId, openEvidenceCatalog };
}
