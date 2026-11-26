import { z } from "zod";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type {
  V9StructuralSignal,
  V9ValidatedPolicyEnvelope,
} from "@shared/types/safety-score-v9";
import type {
  V9AssetFactsV3,
  V9FactSetCoreV3,
} from "@shared/types/safety-score-v9-facts";
import type {
  SafetyScoreV9CurrentCard,
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
  type V9UpstreamEvaluatedAsset,
} from "@shared/lib/safety-score-v9/evaluate-asset";
import {
  buildV9UpstreamResult,
  commonModeSignalsByAsset,
  marketRankByAsset,
  sourceGenerations,
  computeV9EvaluatedSetDigest,
  evaluatedAssetDigestPayload,
  projectPlanningFacts,
  V9AssetEvaluationError,
  type V9AssetDigestPayload,
  type V9PlanningFacts,
} from "@shared/lib/safety-score-v9/evaluate-set";
import {
  createV9OpenEvidenceCounter,
  projectV9OpenEvidenceGap,
  type V9OpenEvidenceGap,
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
  computeSafetyScoreV9CompilerFactSchemaDigest,
  computeSafetyScoreV9ProducerCapabilityDigest,
  computeSafetyScoreV9PublicationGenerationId,
  SafetyScoreV9CandidateIdentityV1Schema,
} from "./candidate-identity";
import {
  exitPillarFreshnessFromDexInput,
  extractV9InternalTokenizedFundState,
  compilerFactSchemaIdentity,
  prepareV9PublicationExtensionOptions,
  producerCapabilityIdentity,
  projectV9PublicationAssetFacts,
  quarantineAffectedAssetIds,
} from "./candidate";
import { compileSafetyScoreV9AssetSlice, planSafetyScoreV9FactSet } from "./fact-set";
import { createSafetyScoreV9BaselineExtensionSource, type BuildSafetyScoreV9BaselineExtensionOptions } from "./extension";
import type { SafetyScoreV9CompilerInput } from "./native-input";
import type {
  BuildAcceptedBaselineVerifiedEmptyOptions,
  SafetyScoreV9InternalExitRouteSummary,
  SafetyScoreV9VerifiedEmptyExitWitness,
} from "./publication-assessment";

export const V9_EVAL_DEFAULT_MAX_CHUNK_ASSETS = 70;

const DOCUMENTATION_PILLARS = ["backing", "exit", "control"] as const;

type V9ChunkAsset = ReturnType<typeof projectV9PublicationAssetFacts> & {
  facts: V9AssetFactsV3;
  marketRank: number | null;
  dependencySignals: readonly V9StructuralSignal[];
};

export interface V9ChunkUpstreamSnapshot {
  assetId: string;
  upstreamResult: V9UpstreamResult;
  unavailabilityRoots: readonly string[];
  evaluatedShim: V9UpstreamEvaluatedAsset;
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
  documentationCards: V9SerializedDocumentationCard[];
  openEvidenceInputs: V9ChunkOpenEvidenceAssetInput[];
  openEvidenceAssets: V9OpenEvidenceAsset<V9OpenEvidenceGap>[];
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
    if (unit.length > maxChunkAssets) throw new Error(`V9 dependency component exceeds chunk cap: ${unit.length} > ${maxChunkAssets}`);
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
  assets: readonly Pick<V9PlanningFacts, "assetId" | "dependencies" | "reserveExposures">[],
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
  assets: Iterable<V9ChunkAsset>;
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
  const evaluatedById = new Map<string, V9UpstreamEvaluatedAsset>();
  const upstreamResultsById = new Map<string, V9UpstreamResult>();
  const unavailabilityRootsById = new Map<string, readonly string[]>();

  for (const snapshot of input.priorUpstreams) {
    evaluatedById.set(snapshot.assetId, snapshot.evaluatedShim);
    upstreamResultsById.set(snapshot.assetId, snapshot.upstreamResult);
    unavailabilityRootsById.set(snapshot.assetId, snapshot.unavailabilityRoots);
  }

  const docGapIds = new Map<string, V9DocumentationClassification>(input.priorDocumentationGapEntries);
  const documentationCards: V9SerializedDocumentationCard[] = [];
  const openEvidenceInputs: V9ChunkOpenEvidenceAssetInput[] = [];
  const openEvidenceAssets: V9OpenEvidenceAsset<V9OpenEvidenceGap>[] = [];
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

  for (const item of input.assets) {
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

      upstreamResultsById.set(asset.assetId, upstreamResult);
      unavailabilityRootsById.set(asset.assetId, unavailabilityRoots);
    } catch (error) {
      const wrapped = error instanceof V9AssetEvaluationError ? error : new V9AssetEvaluationError(asset.assetId, error);
      return { status: "quarantine-required", failures: [[wrapped.assetId, wrapped.message]] };
    }

    const snapshot = projectChunkUpstreamSnapshot(evaluatedAsset, upstreamResult, unavailabilityRoots);
    evaluatedById.set(asset.assetId, snapshot.evaluatedShim);
    if (input.exportedUpstreamIds.has(asset.assetId)) exportedUpstreams.push(snapshot);

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
    openEvidenceAssets.push({
      assetId: asset.assetId,
      gaps: asset.gaps.map(projectV9OpenEvidenceGap),
      controls: asset.controls.flatMap(({ controlKey, deploymentKey, authoredControlId }) =>
        authoredControlId === undefined ? [] : [{ controlKey, deploymentKey, authoredControlId }]),
    });
    openEvidenceInputs.push({
      assetId: evaluatedAsset.assetId,
      localDocumentationGapEntries: assetLocalDocEntries,
      unresolvedFacts: evaluatedAsset.trace.unresolvedFacts.map(
        ({ code, critical, responsibility, cause, sourceGapId, causeGapIds }) =>
          ({ code, critical, responsibility, cause, sourceGapId, causeGapIds }),
      ),
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
        dependencyProvenance: item.dependencyMetadata.dependencyProvenance,
        dependencyTypes: item.dependencyMetadata.dependencyTypes,
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
      documentationCards,
      openEvidenceInputs,
      openEvidenceAssets,
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
export async function assembleV9ChunkedCandidate(input: {
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
  chunkSummaries: V9EvalChunkSummaryPayload[];
  cardShards: AsyncIterable<V9EvalCardShardPayload | null>;
  verifiedEmptyExitByAssetId?: Readonly<Record<string, SafetyScoreV9VerifiedEmptyExitWitness>>;
}): Promise<{
  candidate: SafetyScoreV9CurrentResponse;
  scoreResultDigest: string;
  evaluatedSetDigest: string;
  candidateId: string;
  publicationGenerationId: string;
  verifiedEmptyExitBaselineOptions: BuildAcceptedBaselineVerifiedEmptyOptions;
  lenderCollateralBackingScoresByAssetId: Record<string, number>;
  internalExitRoutesByAssetId: Record<string, SafetyScoreV9InternalExitRouteSummary>;
} | null> {
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
  const referencedGapIds = new Set<string>();
  for (const chunk of input.chunkSummaries) {
    for (const asset of chunk.openEvidenceInputs) {
      for (const fact of asset.unresolvedFacts) {
        if (fact.cause === "D") continue;
        if (fact.sourceGapId != null) referencedGapIds.add(fact.sourceGapId);
        else if (fact.causeGapIds?.length === 1) referencedGapIds.add(fact.causeGapIds[0]!);
      }
    }
  }
  let openEvidenceCounter: ReturnType<typeof createV9OpenEvidenceCounter> | null = createV9OpenEvidenceCounter(
    input.chunkSummaries.flatMap((chunk) => chunk.openEvidenceAssets.splice(0).map((asset) => ({
      ...asset, gaps: asset.gaps.filter((gap) => referencedGapIds.has(gap.gapId)),
    }))),
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

  input.chunkSummaries.length = 0;
  referencedGapIds.clear();
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

  allAssetDigests.length = 0;

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
  openEvidenceCounter = null;
  const carriers = buildV9DocumentationCarriers({
    envelope: input.envelope,
    gapIds: docGapIds,
    cards: allDocCards,
    openEvidence,
  });

  allDocCards.length = 0;
  docGapIds.clear();

  const foreignCauseGaps = [...allForeignGapIds].sort();
  const foreignRefs = new Map(foreignCauseGaps.map((id, index) => [id, index]));
  const compactCard = createV9PublicCardShardViewFactory();
  const finalizedById = new Map<string, SafetyScoreV9CurrentCard>();
  for await (const shard of input.cardShards) {
    if (shard === null) return null;
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

interface V9ChunkCompilerInput {
  fixedInput: Readonly<SafetyScoreV9CompilerInput>;
  extensionOptions: BuildSafetyScoreV9BaselineExtensionOptions;
  evaluationFailures: ReadonlyMap<string, string>;
  verifiedEmptyExitByAssetId?: Readonly<Record<string, SafetyScoreV9VerifiedEmptyExitWitness>>;
}

export function planV9ChunkedEvaluation(input: V9ChunkCompilerInput & {
  policy: V9ValidatedPolicyEnvelope;
  maxChunkAssets: number;
}) {
  const source = createSafetyScoreV9BaselineExtensionSource(input.fixedInput, input.extensionOptions);
  const planningById = new Map<string, V9PlanningFacts>();
  const { factSet, quarantines, bridgeJoinDiagnostics } = planSafetyScoreV9FactSet(
    input.fixedInput, source, input.evaluationFailures, input.verifiedEmptyExitByAssetId,
    (asset) => { planningById.set(asset.assetId, projectPlanningFacts(asset, input.policy)); },
  );
  const assets = [...planningById.values()];
  const dependencyPlan = buildV9DependencyEvaluationPlan({ activeAssetIds: factSet.activeAssetIds, assets });
  const partition = partitionV9DependencyChunks(dependencyPlan, collectV9AssetUpstreamsMap(assets), input.maxChunkAssets);
  const { v9FactSetDigest, ...factSetHeader } = factSet;
  return {
    factSetHeader,
    factSetDigest: v9FactSetDigest,
    sourceGenerations: sourceGenerations(factSet),
    compilerFactSchemaDigest: computeSafetyScoreV9CompilerFactSchemaDigest(
      compilerFactSchemaIdentity(input.fixedInput, source.extension, factSet),
    ),
    producerCapabilityDigest: computeSafetyScoreV9ProducerCapabilityDigest(
      producerCapabilityIdentity(input.fixedInput, source.extension),
    ),
    dexExitRouteMaxAgeSec: source.extension.routeFreshness.dexMaxAgeSec,
    dependencyPlan,
    partition,
    marketRanks: Object.fromEntries(marketRankByAsset(assets, factSet.activeAssetIds)),
    commonModeSignals: Object.fromEntries(commonModeSignalsByAsset(dependencyPlan, input.policy, planningById)),
    quarantines,
    quarantineAffectedAssetIds: quarantineAffectedAssetIds({ assets }, quarantines),
    bridgeJoinDiagnostics,
  };
}

export function* compileV9ChunkAssets(input: V9ChunkCompilerInput & {
  factSetHeader: Omit<V9FactSetCoreV3, "assets">;
  assetIds: readonly string[];
  marketRanks: Readonly<Record<string, number>>;
  commonModeSignals: Readonly<Record<string, readonly V9StructuralSignal[]>>;
}): Iterable<V9ChunkAsset> {
  const { extensionOptions, reserveRejections } = prepareV9PublicationExtensionOptions(
    input.fixedInput.clockSec, input.extensionOptions,
  );
  const source = createSafetyScoreV9BaselineExtensionSource(input.fixedInput, extensionOptions);
  for (const { facts } of compileSafetyScoreV9AssetSlice(
    input.fixedInput, source, input.factSetHeader, input.assetIds, input.evaluationFailures, input.verifiedEmptyExitByAssetId,
  )) {
    const id = facts.assetId;
    yield {
      facts,
      ...projectV9PublicationAssetFacts(facts, input.factSetHeader, input.fixedInput, ACTIVE_META_BY_ID.get(id), reserveRejections),
      marketRank: input.marketRanks[id] ?? null,
      dependencySignals: input.commonModeSignals[id] ?? [],
    };
  }
}
