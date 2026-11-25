import { z } from "zod";
import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v9/evaluation-build-manifest-v1";
import {
  resolveChainMaturityAdmissionsAt,
  type ResolvedChainMaturityReview,
} from "@shared/data/safety-score-v9/chain-maturity-reviews-v1";
import { resolveChainId } from "@shared/types/chain-identity";
import type {
  V9Severity,
  V9StructuralSignal,
  V9ValidatedPolicyEnvelope,
} from "@shared/types/safety-score-v9";
import type {
  CompiledV9FactSetV3,
  V9AssetFactsBase,
  V9AssetFactsV3,
  V9EvidenceResponsibility,
  V9FactStatusV2,
  V9FailureDomainRef,
} from "@shared/types/safety-score-v9-facts";
import type {
  SafetyScoreV9CurrentCard,
  SafetyScoreV9EvidenceFreshness,
  V9ReserveCompositionAdmission,
} from "@shared/types/safety-score-v9-public";
import {
  SafetyScoreV9CurrentResponseSchema,
  type SafetyScoreV9CurrentResponse,
} from "@shared/types/safety-score-v9-publication-response";
import type { V9QualityPillar } from "@shared/types/safety-score-v9-quality-pillars";
import { clampShare } from "@shared/lib/math";
import { sha256HexFromUtf8Chunks } from "@shared/lib/sha256";
import { stableJsonStringifyChunksV1 } from "@shared/lib/stable-json";
import { DEX_ROUTE_SOURCE_CAPABILITIES } from "@shared/lib/p4-exit-route-capacity";
import { isTokenizedFundId } from "@shared/lib/stablecoins/listing-governance";
import { assertV9PublicCardProjections } from "@shared/lib/report-cards-v9-projections";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import { v9StructuralSignalSharePct } from "@shared/lib/safety-score-v9/backing-primitives";
import {
  buildV9DependencyEvaluationPlan,
  createV9DependencyResolutionContext,
  distinctV9RootLiabilityIds,
  resolveV9DependencyInput,
  type V9CommonModeMember,
  type V9DependencyEvaluationPlan,
  type V9UpstreamResult,
} from "@shared/lib/safety-score-v9/dependencies";
import type { V9DocumentationAssetFacts, V9DocumentationClassification } from "@shared/lib/safety-score-v9/documentation";
import {
  deploymentExposureKey,
  deploymentRiskEventKey,
  evaluateV9Asset,
  projectV9EffectiveBackingPillarScore,
  upstreamExitAccessScore,
  upstreamOracleNavProjection,
  type V9EvaluatedAsset,
} from "@shared/lib/safety-score-v9/evaluate-asset";
import {
  assessV9ControlDomainScope,
  commonModeSignalSeverity,
  deploymentControlDomainSeverity,
  isV9ControllerOwnedCommonModeMember,
  isV9ParentControlledCommonModeMember,
  resolveV9MintControlGroupSeverity,
  V9AssetEvaluationError,
  v9ControlAssetDomainId,
  type V9BridgeDomainExposure,
  type V9CommonModeContext,
  type V9ConservativeShareBounds,
  type V9SupplyChainExposure,
} from "@shared/lib/safety-score-v9/evaluate-set";
import {
  projectV9ExitEvaluationRoute,
  resolveV9DistinctExitCapacity,
  type V9ExitHolderEligibility,
  type V9ExitStressRequest,
} from "@shared/lib/safety-score-v9/exit";
import {
  isV9RepresentationGroupRoute,
  isV9UncanonicalizedChainPoolRoute,
} from "@shared/lib/safety-score-v9/facts";
import {
  createV9OpenEvidenceCounter,
  type V9OpenEvidenceAsset,
  type V9OpenQuestionFact,
} from "@shared/lib/safety-score-v9/open-questions";
import {
  assertV9ValidatedPolicyEnvelope,
  resolveV9PolicyChainMaturityIdentity,
  V9_CANDIDATE_POLICY_V1,
} from "@shared/lib/safety-score-v9/policy";
import { compareText, domainDigest, domainKey, uniqueSorted } from "@shared/lib/safety-score-v9/primitives";
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
import { projectV9DependencyScore } from "@shared/lib/safety-score-v9/score";
import { computeV9CompactResultDigest } from "@shared/lib/safety-score-v9/trace";
import {
  computeSafetyScoreV9CandidateId,
  computeSafetyScoreV9CompilerFactSchemaDigest,
  computeSafetyScoreV9ProducerCapabilityDigest,
  computeSafetyScoreV9PublicationGenerationId,
  SafetyScoreV9CandidateIdentityV1Schema,
  SafetyScoreV9CompilerFactSchemaIdentityV1Schema,
  SafetyScoreV9ProducerCapabilityIdentityV1Schema,
} from "./candidate-identity";
import { publicDependencyMetadata } from "./candidate";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "./consumer-freshness";
import type { SafetyScoreV9FactSetExtensionV2, V9AssetQuarantine } from "./fact-set";
import type { SafetyScoreV9CompilerInput } from "./native-input";
import type {
  BuildAcceptedBaselineVerifiedEmptyOptions,
  SafetyScoreV9DexExpiryWitness,
  SafetyScoreV9InternalExitRouteSummary,
  SafetyScoreV9VerifiedEmptyExitWitness,
} from "./publication-assessment";

/** Default ADR-26 chunk cap (<= 140 assets/chunk, <= 4 chunks at 560 assets). */
export const V9_EVAL_DEFAULT_MAX_CHUNK_ASSETS = 140;

const V9_EVALUATED_SET_DIGEST_DOMAIN = "safety-score-v9.evaluated-set.v2";
const SHARE_RECONCILIATION_TOLERANCE = 0.000001;
const DOCUMENTATION_PILLARS = ["backing", "exit", "control"] as const;

type V9PlanningFacts = Pick<
  V9AssetFactsV3,
  | "assetId"
  | "assetIssuerKey"
  | "dependencies"
  | "reserveExposures"
  | "exitRoutes"
  | "exitStatus"
  | "controls"
  | "peg"
  | "supply"
  | "economicControlReview"
>;

type V9BridgeRouteTier = V9AssetFactsBase["economicControlReview"]["bridge"]["routes"][number]["tier"];

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

export interface V9ChunkAssetDigestPayload {
  compactTrace: V9EvaluatedAsset["compactTrace"];
  dependencyInputs: V9EvaluatedAsset["dependencyInputs"];
  access: V9EvaluatedAsset["access"];
  wrapperParentLimit: V9EvaluatedAsset["trace"]["wrapperParentLimit"];
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
  assetDigests: V9ChunkAssetDigestPayload[];
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

function isKnownRequiredStatus(status: V9FactStatusV2): boolean {
  return status.applicability.state === "required" && status.observationState === "known";
}

function sharesReconcile(left: number, right: number): boolean {
  return Math.abs(left - right) <= SHARE_RECONCILIATION_TOLERANCE;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
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
        if (upstreamChunk !== undefined && upstreamChunk < chunkIndex) {
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

export function computeV9MarketRanks(
  assets: readonly V9PlanningFacts[],
  activeAssetIds: readonly string[],
): Map<string, number> {
  const active = new Set(activeAssetIds);
  const ranked = assets
    .filter(
      (asset) =>
        active.has(asset.assetId) &&
        asset.supply.status.observationState === "known" &&
        asset.supply.circulatingUsd !== null,
    )
    .map((asset) => ({
      assetId: asset.assetId,
      circulatingUsd: asset.supply.circulatingUsd!,
    }))
    .sort((left, right) => right.circulatingUsd - left.circulatingUsd || compareText(left.assetId, right.assetId));
  const result = new Map<string, number>();
  let previousSupply: number | null = null;
  let rank = 0;
  ranked.forEach((asset, index) => {
    if (previousSupply === null || asset.circulatingUsd !== previousSupply) {
      rank = index + 1;
      previousSupply = asset.circulatingUsd;
    }
    result.set(asset.assetId, rank);
  });
  return result;
}

export function extractV9SourceGenerations(factSet: CompiledV9FactSetV3): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(factSet.sourceFingerprints)
      .sort(([left], [right]) => compareText(left, right))
      .map(([source, identity]) => [source, identity.generationId]),
  );
}

export function computeV9QuarantineAffectedAssetIds(
  factSet: CompiledV9FactSetV3,
  quarantines: readonly V9AssetQuarantine[],
): string[] {
  const affected = new Set(quarantines.map((quarantine) => quarantine.assetId));
  let added = true;
  while (added) {
    added = false;
    for (const asset of factSet.assets) {
      if (affected.has(asset.assetId) || !asset.dependencies.edges.some((edge) => affected.has(edge.upstreamAssetId))) {
        continue;
      }
      affected.add(asset.assetId);
      added = true;
    }
  }
  return [...affected].sort(compareText);
}

function publicExitHolderEligibility(
  holderAccess: CompiledV9FactSetV3["assets"][number]["exitRoutes"][number]["holderAccess"],
): V9ExitHolderEligibility {
  switch (holderAccess) {
    case "permissionless":
    case "retail-open":
      return "any-holder";
    case "institutional-eligible":
      return "verified-customer";
    case "verified-customer-neutral":
      return "verified-customer-neutral";
    case "allowlisted":
      return "whitelisted-primary";
    case "issuer-only":
      return "issuer-discretionary";
    case "unknown":
      return "unknown";
  }
}

export function projectV9PublicDisplayMetadata(
  asset: CompiledV9FactSetV3["assets"][number],
): V9PublicDisplayMetadata {
  const labels: Record<string, string> = {
    mint: "Native mint authority",
    "mint:binding": "Native mint authority",
    "mint:upgrade": "Upgrade authority",
    "mint:savings-rate": "Savings-rate authority",
    oracle: "Oracle design",
    "bridge:native": "Native deployment",
    "bridge:unverified": "Unverified bridge controls",
    "reserve:concentration": "Reserve concentration",
    "reserve:unclassified-residual": "Unclassified reserve exposure",
  };
  for (const exposure of asset.reserveExposures) {
    labels[`reserve:${exposure.exposureKey}`] = exposure.name;
  }
  const routeBaseLabel = (route: CompiledV9FactSetV3["assets"][number]["exitRoutes"][number]): string => {
    if (route.lane === "dex") {
      const encodedChain = /(?:^|:)([a-z0-9-]+)%3a/i.exec(route.routeId)?.[1];
      if (encodedChain === undefined) return route.routeFamily === "dex-orderbook" ? "DEX order book" : "DEX AMM";
      const chain = encodedChain.replace(/-/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
      return `${chain} ${route.routeFamily === "dex-orderbook" ? "order book" : "AMM"}`;
    }
    const semanticKinds = [
      ["collateral-redeem", "Collateral redemption"],
      ["psm-swap", "PSM swap"],
      ["basket-redeem", "Basket redemption"],
      ["stablecoin-redeem", "Stablecoin redemption"],
      ["offchain-issuer", "Issuer redemption"],
      ["mint-redeem", "Mint and redemption"],
    ] as const;
    return (
      semanticKinds.find(([token]) => route.routeId.includes(token))?.[1] ??
      (route.routeFamily === "protocol-redemption" ? "Protocol redemption" : "Issuer redemption")
    );
  };
  const routeLabels = asset.exitRoutes
    .map((route) => ({ route, base: routeBaseLabel(route) }))
    .sort((left, right) => compareText(left.route.routeKey, right.route.routeKey));
  const labelTotals = new Map<string, number>();
  for (const { base } of routeLabels) labelTotals.set(base, (labelTotals.get(base) ?? 0) + 1);
  const labelIndexes = new Map<string, number>();
  for (const { route, base } of routeLabels) {
    const index = (labelIndexes.get(base) ?? 0) + 1;
    labelIndexes.set(base, index);
    labels[route.routeKey] = (labelTotals.get(base) ?? 0) > 1 ? `${base} ${index}` : base;
  }
  const evidenceById = new Map(asset.evidence.map((evidence) => [evidence.evidenceId, evidence]));
  const exitRouteDetails = Object.fromEntries(
    asset.exitRoutes.map((route) => {
      const chain = route.failureDomains.find((domain) => domain.kind === "chain")?.key ?? null;
      const protocol =
        route.failureDomains.find((domain) => domain.kind === "dex-protocol" || domain.kind === "redemption-rail")
          ?.key ?? null;
      const scopedPool = route.routeId
        .split(":")
        .map((part) => {
          try {
            return decodeURIComponent(part);
          } catch {
            return part;
          }
        })
        .find((part) => chain !== null && part.startsWith(`${chain.toLowerCase()}:`));
      const routeEvidence = route.status.evidenceRefIds
        .map((evidenceId) => evidenceById.get(evidenceId))
        .find(
          (item) =>
            item?.sourceId === "report-cards-dex-route-observation" ||
            item?.sourceId === "report-cards-redemption-route-observation" ||
            item?.sourceId === "safety-score-v9-retained-route-overlay",
        );
      const evidence =
        routeEvidence ??
        route.status.evidenceRefIds
          .map((evidenceId) => evidenceById.get(evidenceId))
          .find((item) => item !== undefined);
      return [
        route.routeKey,
        {
          chain,
          protocol,
          poolId: scopedPool?.slice(scopedPool.indexOf(":") + 1) ?? null,
          evidenceKind: route.evidenceKind,
          observedAtSec: evidence?.observedAtSec ?? null,
        },
      ];
    }),
  );
  return {
    labels,
    exitHolderEligibility: Object.fromEntries(
      asset.exitRoutes.map((route) => [route.routeKey, publicExitHolderEligibility(route.holderAccess)]),
    ),
    exitRouteDetails,
  };
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

export function computeV9CompilerFactSchemaDigestForExtension(
  fixedInput: SafetyScoreV9CompilerInput,
  extension: SafetyScoreV9FactSetExtensionV2,
  compiledFacts: CompiledV9FactSetV3,
): string {
  return computeSafetyScoreV9CompilerFactSchemaDigest(
    SafetyScoreV9CompilerFactSchemaIdentityV1Schema.parse({
      schemaVersion: 1,
      fixedInputSchemaVersion: fixedInput.schemaVersion,
      factExtensionSchemaVersion: extension.schemaVersion,
      compiledFactSchemaVersion: compiledFacts.schemaVersion,
      compiledFactSchemaCapabilities: [
        "canonical-chain-supply-distribution.v1",
        "canonical-lock-mint-supply-attribution.v1",
        "exit-route-modeled-confidence.v1",
        "fact-gap-cause-proofs.v1",
        "governed-issuance.v1",
        "journaled-cdp-shock-coverage.v1",
        "morpho-lender-collateral-book.v1",
        "reviewed-deployment-unit-supply-attribution.v1",
        "reviewed-transfer-deployments.v1",
        "wrapper-local-facts.v1",
      ],
      compilerAdapter: "exact-fixed-input-to-v9-facts.v3",
      evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
    }),
  );
}

export function computeV9ProducerCapabilityDigestForExtension(
  fixedInput: SafetyScoreV9CompilerInput,
  extension: SafetyScoreV9FactSetExtensionV2,
): string {
  return computeSafetyScoreV9ProducerCapabilityDigest(
    SafetyScoreV9ProducerCapabilityIdentityV1Schema.parse({
      schemaVersion: 1,
      inputContractVersions: {
        fixedInput: fixedInput.schemaVersion,
        factExtension: extension.schemaVersion,
      },
      sourceAdapters: {
        registry: "fixed-input.registry.v1",
        dexExitRoutes: "fixed-input.dex-exit-observations.v2",
        redemptionExitRoutes: "fixed-input.redemption-exit-observations.v2",
        liveReserves: "fixed-input.live-reserves.v1",
        chainSupply: "fixed-input.usd-circulating-supply.v4",
        peg: "fixed-input.peg-summary.v1",
        researchOverlays: "v9-fact-extension.review-overlays.v4",
        shockCoverage: "journal-registry.cdp-shock-coverage.v1",
        lenderBook: "fixed-input.morpho-lender-book.v1",
        lenderCollateralBacking: "fixed-input.previous-accepted-backing.v1",
      },
      scoreBearingMethodologyVersions: {
        dexExitRoutes: sortedUnique(fixedInput.inputMethodologyVersions.dexLiquidity),
        redemptionExitRoutes: sortedUnique(fixedInput.inputMethodologyVersions.redemptionBackstop),
        peg: sortedUnique(fixedInput.inputMethodologyVersions.pegScore),
      },
      dexRouteCapabilityMatrixVersions: [
        `declared-source-capabilities:v1:${domainDigest(
          "safety-score-v9.dex-route-source-capabilities.v1",
          DEX_ROUTE_SOURCE_CAPABILITIES,
        )}`,
      ],
      freshnessPolicySec: {
        dexExitRoutes: extension.routeFreshness.dexMaxAgeSec,
        redemptionExitRoutes: extension.routeFreshness.redemptionMaxAgeSec,
        documentedTermsExitRoutes: extension.routeFreshness.documentedTermsMaxAgeSec,
        accessReviews: V9_ACCESS_EVIDENCE_MAX_AGE_SEC,
        liveReserves: extension.sources.liveReserves.maxAgeSec,
        lenderBook: V9_CANDIDATE_POLICY_V1.policy.semantic.backing.lenderCollateralBook.observationMaxAgeSec,
        lenderCollateralBacking: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
        chainSupply: extension.sources.chainSupply.maxAgeSec,
        peg: extension.sources.peg.maxAgeSec,
        researchOverlays: extension.sources.researchOverlays.maxAgeSec,
      },
    }),
  );
}

export function resolveV9ReleasePolicyVersion(policy: V9ValidatedPolicyEnvelope): string {
  if (policy.policy.lifecycle !== "active" || policy.policy.releaseVersion === null) {
    throw new Error("Safety Score v9 publication requires an active release policy");
  }
  if (policy.policy.policyId !== "safety-score-v9") {
    throw new Error(`Safety Score v9 policy ID is not publication-compatible: ${policy.policy.policyId}`);
  }
  return policy.policy.releaseVersion;
}

function exitPillarFreshnessFromDexInput(
  clockSec: number,
  updatedAt: number | null,
  dexMaxAgeSec: number,
): SafetyScoreV9EvidenceFreshness {
  if (updatedAt === null || updatedAt > clockSec) return "unknown";
  return clockSec - updatedAt <= dexMaxAgeSec ? "current" : "stale";
}

function boundedPooledChainShare(supply: V9AssetFactsBase["supply"]): number {
  return supply.selectedBridgeRoutes.reduce(
    (sum, route) =>
      sum +
      (isV9UncanonicalizedChainPoolRoute(route.deploymentRouteKey) ||
      isV9RepresentationGroupRoute(route.deploymentRouteKey)
        ? route.supplyShare
        : 0),
    0,
  );
}

function summarizeSupplyChainExposure(supply: V9AssetFactsBase["supply"]): V9SupplyChainExposure {
  const poolShare = boundedPooledChainShare(supply);
  if (!isKnownRequiredStatus(supply.status)) {
    return {
      shareBySlug: new Map<string, number>(),
      unattributedShare: 1,
      unmatchedChainLabelPoolShare: poolShare,
      complete: false,
    };
  }
  if (supply.chainDistribution === null || supply.chainDistribution === undefined) {
    return {
      shareBySlug: new Map<string, number>(),
      unattributedShare: 1,
      unmatchedChainLabelPoolShare: poolShare,
      complete: false,
    };
  }
  const shareBySlug = new Map<string, number>();
  for (const row of supply.chainDistribution.chains) {
    const chainId = resolveChainId(row.chainId) ?? row.chainId.toLowerCase();
    if (shareBySlug.has(chainId)) {
      return {
        shareBySlug: new Map<string, number>(),
        unattributedShare: 1,
        unmatchedChainLabelPoolShare: poolShare,
        complete: false,
      };
    }
    shareBySlug.set(chainId, row.supplyShare);
  }
  return {
    shareBySlug,
    unattributedShare: supply.chainDistribution.unattributedSupplyShare,
    unmatchedChainLabelPoolShare: poolShare,
    complete: true,
  };
}

function referenceExitRequest(envelope: V9ValidatedPolicyEnvelope): V9ExitStressRequest {
  const request = envelope.policy.semantic.exit.stressRequest;
  return {
    requestedNotionalUsd: request.referenceNotionalUsd,
    maxCostBps: request.maxCostBps,
    comparisonWindowSec: request.settlementHorizonSec,
    rawSupplyRequestUsd: request.referenceNotionalUsd,
  };
}

function summarizeDexDomainExposure(
  asset: V9PlanningFacts,
  envelope: V9ValidatedPolicyEnvelope,
): ReadonlyMap<string, V9ConservativeShareBounds> {
  const request = referenceExitRequest(envelope);
  const dexRoutes = asset.exitRoutes.filter((route) => route.lane === "dex");
  const domains = uniqueSorted(
    dexRoutes
      .filter((route) => route.coverageClass !== "diagnostic")
      .flatMap((route) => route.failureDomains.filter((domain) => domain.kind === "dex-protocol").map(domainKey)),
  );
  return new Map(
    domains.map((key) => {
      const relevantRoutes = dexRoutes.filter(
        (route) =>
          route.coverageClass !== "diagnostic" && route.failureDomains.some((domain) => domainKey(domain) === key),
      );
      const projectedRoutes = relevantRoutes.map(projectV9ExitEvaluationRoute);
      const resolved = resolveV9DistinctExitCapacity(projectedRoutes, request, envelope);
      const lower = clampShare(
        Math.min(request.requestedNotionalUsd, resolved.valuedExecutableUsd) / request.requestedNotionalUsd,
      );
      const completeAndCurrent =
        asset.exitStatus.observationState === "known" &&
        relevantRoutes.length > 0 &&
        relevantRoutes.every((route) => {
          if (
            route.status.observationState !== "known" ||
            !route.scoreEligible ||
            route.coverageClass !== "exact-complete"
          ) {
            return false;
          }
          return resolved.includedRouteKeys.includes(route.routeKey);
        });
      return [key, { lower, upper: completeAndCurrent ? lower : 1 }] as const;
    }),
  );
}

function bridgeSupplyIsConsistent(supply: V9AssetFactsBase["supply"]): boolean {
  const circulatingUsd = supply.circulatingUsd;
  if (!isKnownRequiredStatus(supply.status) || circulatingUsd === null) return false;
  const { selectedRouteSupplyShare, unknownRouteSupplyShare, unreviewedRouteSupplyShare } = supply;
  if (selectedRouteSupplyShare === null || unknownRouteSupplyShare === null || unreviewedRouteSupplyShare === null) {
    return false;
  }
  const expectedTotalShare = circulatingUsd > 0 ? 1 : 0;
  if (
    !sharesReconcile(
      selectedRouteSupplyShare + unknownRouteSupplyShare + unreviewedRouteSupplyShare,
      expectedTotalShare,
    )
  ) {
    return false;
  }
  const reviewedRowShare = supply.selectedBridgeRoutes
    .filter((route) => route.reviewState === "selected-reviewed")
    .reduce((sum, route) => sum + route.supplyShare, 0);
  const unresolvedRowShare = supply.selectedBridgeRoutes
    .filter((route) => route.reviewState === "selected-unresolved")
    .reduce((sum, route) => sum + route.supplyShare, 0);
  const unmatchedRowShare = supply.selectedBridgeRoutes
    .filter((route) => route.reviewState === "unmatched")
    .reduce((sum, route) => sum + route.supplyShare, 0);
  const carriesExplicitUnmatchedRows = supply.selectedBridgeRoutes.some((route) => route.reviewState === "unmatched");
  if (
    !sharesReconcile(reviewedRowShare, selectedRouteSupplyShare) ||
    !sharesReconcile(unresolvedRowShare, unreviewedRouteSupplyShare) ||
    (carriesExplicitUnmatchedRows && !sharesReconcile(unmatchedRowShare, unknownRouteSupplyShare))
  ) {
    return false;
  }
  return supply.selectedBridgeRoutes.every((route) => {
    if (circulatingUsd === 0) {
      return route.supplyUsd <= 0.01 && route.supplyShare <= SHARE_RECONCILIATION_TOLERANCE;
    }
    return sharesReconcile(route.supplyUsd / circulatingUsd, route.supplyShare);
  });
}

function summarizeBridgeDomainExposure(
  asset: V9PlanningFacts,
  representationGroupMaterialShareThreshold: number,
): ReadonlyMap<string, V9BridgeDomainExposure> {
  const controlsByKey = new Map(asset.controls.map((control) => [control.controlKey, control]));
  const selectedByDeployment = new Map(
    asset.supply.selectedBridgeRoutes.map((route) => [route.deploymentRouteKey, route]),
  );
  const lowerByDomain = new Map<string, number>();
  const tiersByDomain = new Map<string, Set<V9BridgeRouteTier>>();
  const validJoinedDeployments = new Set<string>();
  const joinedDomainDeployments = new Set<string>();
  const unresolvedDomains = new Set<string>();
  const supplyBridgeDomainKeys: ReadonlySet<string> = new Set(
    asset.supply.failureDomains.filter((domain) => domain.kind === "bridge-route").map(domainKey),
  );
  const domainKeys = new Set(supplyBridgeDomainKeys);
  const bridgeReviewKnown = isKnownRequiredStatus(asset.economicControlReview.bridge.status);
  const supplyConsistent = bridgeSupplyIsConsistent(asset.supply);
  let unresolvedJoin = !bridgeReviewKnown || !supplyConsistent;

  for (const review of asset.economicControlReview.bridge.routes) {
    const control = controlsByKey.get(review.controlKey);
    if (!control) {
      unresolvedJoin = true;
      continue;
    }
    const bridgeDomains = control.failureDomains.filter((domain) => domain.kind === "bridge-route");
    if (bridgeDomains.length === 0) {
      unresolvedJoin = true;
      continue;
    }
    const selected = selectedByDeployment.get(control.deploymentKey);
    const boundedRepresentationGroupMechanism =
      isV9RepresentationGroupRoute(control.deploymentKey) &&
      control.status.applicability.state === "required" &&
      control.status.observationState === "bounded-unknown" &&
      control.authority !== null &&
      control.capSemantics.kind !== "unknown" &&
      control.claimImpairment !== "unknown" &&
      control.economicLossScope === "deployment" &&
      control.materialSupplyShare !== null &&
      control.materialSupplyShare < representationGroupMaterialShareThreshold;
    const validControl =
      (isKnownRequiredStatus(control.status) || boundedRepresentationGroupMechanism) &&
      control.controlKind === "bridge" &&
      control.capabilities.includes("bridge-mint");
    const knownZeroExposure =
      bridgeReviewKnown &&
      supplyConsistent &&
      validControl &&
      selected === undefined &&
      control.materialSupplyShare === 0;
    const materialShareConsistent =
      selected !== undefined &&
      control.materialSupplyShare !== null &&
      sharesReconcile(control.materialSupplyShare, selected.supplyShare);
    const validJoin =
      bridgeReviewKnown &&
      supplyConsistent &&
      validControl &&
      selected?.reviewState === "selected-reviewed" &&
      materialShareConsistent;
    if (validJoin) validJoinedDeployments.add(control.deploymentKey);
    for (const domain of bridgeDomains) {
      const key = domainKey(domain);
      domainKeys.add(key);
      if (knownZeroExposure) continue;
      if (!validJoin) {
        unresolvedDomains.add(key);
        continue;
      }
      const tiers = tiersByDomain.get(key) ?? new Set<V9BridgeRouteTier>();
      tiers.add(review.tier);
      tiersByDomain.set(key, tiers);
      const joinedDomainDeployment = `${key}\u0000${control.deploymentKey}`;
      if (!joinedDomainDeployments.has(joinedDomainDeployment)) {
        lowerByDomain.set(key, (lowerByDomain.get(key) ?? 0) + selected.supplyShare);
        joinedDomainDeployments.add(joinedDomainDeployment);
      }
    }
  }

  for (const route of asset.supply.selectedBridgeRoutes) {
    if (
      route.reviewState !== "selected-reviewed" ||
      route.reviewedRouteKind === "native" ||
      validJoinedDeployments.has(route.deploymentRouteKey)
    ) {
      continue;
    }
    const attributableDomain = `bridge-route:${route.deploymentRouteKey}`;
    if (supplyBridgeDomainKeys.has(attributableDomain)) {
      unresolvedDomains.add(attributableDomain);
    } else {
      unresolvedJoin = true;
    }
  }
  const unresolvedShare = supplyConsistent
    ? clampShare(asset.supply.unreviewedRouteSupplyShare! + asset.supply.unknownRouteSupplyShare!)
    : 1;

  return new Map(
    [...domainKeys].sort(compareText).map((key) => {
      const lower = clampShare(lowerByDomain.get(key) ?? 0);
      const upper = unresolvedJoin || unresolvedDomains.has(key) ? 1 : clampShare(lower + unresolvedShare);
      return [
        key,
        {
          shareBounds: { lower, upper },
          reviewedTiers: [...(tiersByDomain.get(key) ?? [])].sort(compareText),
          reviewedTiersComplete: !unresolvedJoin && !unresolvedDomains.has(key),
        },
      ] as const;
    }),
  );
}

function buildCommonModeContext(
  asset: V9PlanningFacts | undefined,
  envelope: V9ValidatedPolicyEnvelope,
): V9CommonModeContext {
  if (!asset) {
    return {
      supplyExposure: {
        shareBySlug: new Map<string, number>(),
        unattributedShare: 1,
        unmatchedChainLabelPoolShare: 0,
        complete: false,
      },
      dexExposureByDomain: new Map<string, V9ConservativeShareBounds>(),
      bridgeExposureByDomain: new Map<string, V9BridgeDomainExposure>(),
    };
  }
  return {
    supplyExposure: summarizeSupplyChainExposure(asset.supply),
    dexExposureByDomain: summarizeDexDomainExposure(asset, envelope),
    bridgeExposureByDomain: summarizeBridgeDomainExposure(
      asset,
      Math.min(
        envelope.policy.semantic.materiality.deploymentMaterialSharePct / 100,
        envelope.policy.semantic.materiality.commonModeShareThreshold,
      ),
    ),
  };
}

function commonModeMemberStatus(
  member: V9CommonModeMember,
  assetsById: ReadonlyMap<string, V9PlanningFacts>,
): V9FactStatusV2 | null {
  const asset = assetsById.get(member.assetId);
  if (!asset) return null;
  if (member.owner === "backing") {
    return asset.reserveExposures.find((candidate) => candidate.exposureKey === member.pathKey)?.status ?? null;
  }
  if (member.owner === "exit") {
    return asset.exitRoutes.find((candidate) => candidate.routeKey === member.pathKey)?.status ?? null;
  }
  if (member.owner === "control") {
    return asset.controls.find((candidate) => candidate.controlKey === member.pathKey)?.status ?? null;
  }
  if (member.owner === "dependency") {
    return asset.dependencies.edges.some((edge) => edge.edgeKey === member.pathKey) ? asset.dependencies.status : null;
  }
  if (member.owner === "peg") return asset.peg.status;
  return asset.supply.status;
}

function isKnownCommonModeMember(
  member: V9CommonModeMember,
  assetsById: ReadonlyMap<string, V9PlanningFacts>,
): boolean {
  const status = commonModeMemberStatus(member, assetsById);
  return status !== null && isKnownRequiredStatus(status);
}

function isBoundedUnknownCommonModeMember(
  member: V9CommonModeMember,
  assetsById: ReadonlyMap<string, V9PlanningFacts>,
): boolean {
  const status = commonModeMemberStatus(member, assetsById);
  return status !== null && status.applicability.state === "required" && status.observationState === "bounded-unknown";
}

function venueFamilyKey(key: string): string {
  return key.toLowerCase().replace(/-v\d+$/u, "");
}

function commonModeShareForDomain(
  failureDomain: V9FailureDomainRef,
  context: V9CommonModeContext,
  materiality: V9ValidatedPolicyEnvelope["policy"]["semantic"]["materiality"],
  chainReviews: ReadonlyMap<string, ResolvedChainMaturityReview>,
): { share: number | null; mature: boolean; chainMaturityUnresolved?: boolean } | null {
  switch (failureDomain.kind) {
    case "chain": {
      const chainId = resolveChainId(failureDomain.key) ?? failureDomain.key.toLowerCase();
      const poolShare = context.supplyExposure.unmatchedChainLabelPoolShare;
      const unattributedAddon =
        poolShare < materiality.commonModeShareThreshold
          ? clampShare(context.supplyExposure.unattributedShare - poolShare)
          : context.supplyExposure.unattributedShare;
      const share = context.supplyExposure.complete
        ? clampShare((context.supplyExposure.shareBySlug.get(chainId) ?? 0) + unattributedAddon)
        : null;
      const review = chainReviews.get(chainId);
      const reviewAvailable =
        review !== undefined &&
        review.evaluationClockSec >= Date.parse(`${review.reviewedAt}T00:00:00.000Z`) / 1000 + 86400;
      const authoredFailure = reviewAvailable && review.state === "failed";
      const mature = reviewAvailable && review.state === "admitted";
      return { share, mature, chainMaturityUnresolved: !authoredFailure && !mature };
    }
    case "dex-protocol":
      return {
        share: context.dexExposureByDomain.get(domainKey(failureDomain))?.upper ?? null,
        mature: materiality.matureVenues.includes(venueFamilyKey(failureDomain.key)),
      };
    case "bridge-route": {
      const exposure = context.bridgeExposureByDomain.get(domainKey(failureDomain));
      return {
        share: exposure !== undefined && exposure.reviewedTiersComplete ? exposure.shareBounds.upper : null,
        mature: false,
      };
    }
    default:
      return null;
  }
}

function formatCommonModeSharePct(share: number): string {
  const rounded = Math.round(share * 1000) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function commonModeEconomicScope(
  kind: V9FailureDomainRef["kind"],
): NonNullable<V9StructuralSignal["economicLossScope"]> {
  if (kind === "dex-protocol") return "access-only";
  if (kind === "chain" || kind === "bridge-route") return "deployment";
  if (kind === "reserve-issuer" || kind === "reserve-custodian") return "reserve-claim";
  return "global-claim";
}

function commonModeReasonQualifier(
  kind: V9FailureDomainRef["kind"],
  severity: V9Severity,
  materiality: V9ValidatedPolicyEnvelope["policy"]["semantic"]["materiality"],
  shareUnavailable: boolean,
): string {
  const lowPct = formatCommonModeSharePct(materiality.commonModeShareThreshold);
  const highPct = formatCommonModeSharePct(materiality.commonModeHighShareThreshold);
  if (kind === "chain") {
    if (severity === "low") {
      return `reviewed mature chain or conservative exposure upper bound below ${lowPct}, diagnostic only`;
    }
    if (severity === "moderate") {
      return `conservative non-mature exposure upper bound from ${lowPct} to below ${highPct}`;
    }
    return shareUnavailable
      ? "chain inventory unavailable, treated at the high-severity floor"
      : `conservative exposure upper bound at or above ${highPct}`;
  }
  if (kind === "dex-protocol") {
    if (severity === "low") return `reviewed mature venue or proven exposure below ${lowPct}, diagnostic only`;
    if (severity === "moderate") return `reviewed non-mature exposure from ${lowPct} to below ${highPct}`;
    return shareUnavailable ? "unknown venue concentration" : `exposure at or above ${highPct}`;
  }
  if (kind === "bridge-route") {
    if (severity === "low") return `proven exposure below ${lowPct}, diagnostic only`;
    if (severity === "moderate") return `reviewed exposure from ${lowPct} to below ${highPct}`;
    return shareUnavailable ? "unknown/unattributed bridge exposure" : `exposure at or above ${highPct}`;
  }
  if (kind === "reserve-issuer") {
    return "single-obligor exposure priced in backing, diagnostic only";
  }
  if (kind === "mint-control" || kind === "upgrade-control") {
    if (severity === "low") return `proven deployment exposure below ${lowPct}, diagnostic only`;
    if (severity === "moderate") return `proven deployment exposure from ${lowPct} to below ${highPct}`;
    return shareUnavailable ? "control reach or deployment exposure unresolved" : `deployment exposure at or above ${highPct}`;
  }
  return severity === "high" ? "shared critical control identity" : "diagnostic";
}

/**
 * Exact cohort common-mode signal computation matching `evaluate-set.ts`,
 * computed once at Seed time so each chunk evaluates identically without
 * loading other chunks' full facts.
 */
export function computeV9CommonModeSignalsForPlan(
  plan: Readonly<V9DependencyEvaluationPlan>,
  envelope: V9ValidatedPolicyEnvelope,
  assetsById: ReadonlyMap<string, V9PlanningFacts>,
): Map<string, readonly V9StructuralSignal[]> {
  const materiality = envelope.policy.semantic.materiality;
  const chainReviews = new Map(
    resolveChainMaturityAdmissionsAt(resolveV9PolicyChainMaturityIdentity(envelope).evaluationClockSec).reviews.map(
      (review) => [review.chainSlug, review],
    ),
  );
  const contextByAsset = new Map<string, V9CommonModeContext>();
  const contextFor = (assetId: string): V9CommonModeContext => {
    const cached = contextByAsset.get(assetId);
    if (cached) return cached;
    const context = buildCommonModeContext(assetsById.get(assetId), envelope);
    contextByAsset.set(assetId, context);
    return context;
  };
  const roleScopedDependencyPaths = new Set(
    [...plan.exitPaths, ...plan.controlPaths, ...plan.oracleNavPaths].map(
      (path) => `${path.assetId}\u0000${path.edgeKey}`,
    ),
  );
  const signals = new Map<string, V9StructuralSignal[]>();
  for (const group of plan.commonModeGroups) {
    const unpricedMembers = group.members.filter(
      (member) =>
        member.owner !== "dependency" || !roleScopedDependencyPaths.has(`${member.assetId}\u0000${member.pathKey}`),
    );
    const effectiveMembers =
      group.failureDomain.kind === "dex-protocol"
        ? unpricedMembers.filter((member) => {
            if (member.owner !== "exit") return false;
            const route = assetsById
              .get(member.assetId)
              ?.exitRoutes.find((candidate) => candidate.routeKey === member.pathKey);
            return (
              route?.lane === "dex" &&
              isKnownRequiredStatus(route.status) &&
              route.scoreEligible &&
              route.coverageClass !== "diagnostic" &&
              route.failureDomains.some((domain) => domainKey(domain) === domainKey(group.failureDomain))
            );
          })
        : unpricedMembers;
    const assetIds = uniqueSorted(effectiveMembers.map((member) => member.assetId));
    const controlCensus =
      group.failureDomain.kind === "mint-control" || group.failureDomain.kind === "upgrade-control";
    const censusAssetIds = controlCensus ? distinctV9RootLiabilityIds(assetIds, plan.serialPaths) : assetIds;
    if (
      censusAssetIds.length < materiality.commonControlMinAssets ||
      effectiveMembers.length < materiality.commonControlMinPaths
    ) {
      continue;
    }
    const key = domainKey(group.failureDomain);
    const mintControlAssessment = (() => {
      if (group.failureDomain.kind !== "mint-control" && group.failureDomain.kind !== "upgrade-control") return null;
      const members = assetIds.map((assetId) => {
        const assetMembers = effectiveMembers.filter((member) => member.assetId === assetId);
        return {
          assetId,
          pathKey: assetMembers[0]?.pathKey ?? key,
          assetIssuerKey: assetsById.get(assetId)?.assetIssuerKey ?? null,
        };
      });
      let controllerAssetId: string | null = null;
      let controllerAttributionComplete = effectiveMembers.length > 0;
      for (const member of effectiveMembers) {
        const attributedControllerAssetId =
          member.owner === "control"
            ? (assetsById.get(member.assetId)?.controls.find((control) => control.controlKey === member.pathKey)
                ?.controllerAssetId ?? null)
            : null;
        if (
          attributedControllerAssetId === null ||
          (controllerAssetId !== null && controllerAssetId !== attributedControllerAssetId)
        ) {
          controllerAttributionComplete = false;
          break;
        }
        controllerAssetId = attributedControllerAssetId;
      }
      if (!controllerAttributionComplete) controllerAssetId = null;
      const controllerIssuerKey =
        controllerAssetId === null
          ? (members[0]?.assetIssuerKey ?? null)
          : (assetsById.get(controllerAssetId)?.assetIssuerKey ?? null);
      return {
        controllerAssetId,
        severity: resolveV9MintControlGroupSeverity({ controllerIssuerKey, members }),
        identitiesKnown: controllerIssuerKey !== null && members.every((member) => member.assetIssuerKey !== null),
      };
    })();
    const mintControlSeverity = mintControlAssessment?.severity ?? null;
    const boundedUnknownMemberCount = effectiveMembers.filter((member) =>
      isBoundedUnknownCommonModeMember(member, assetsById),
    ).length;
    const groupHasBoundedUnknownMember = boundedUnknownMemberCount > 0;
    const controlAssetDomainId = v9ControlAssetDomainId(group.failureDomain);
    for (const assetId of assetIds) {
      const ownMembers = effectiveMembers.filter((member) => member.assetId === assetId);
      const ownMemberFactsKnown = ownMembers.every((member) => isKnownCommonModeMember(member, assetsById));
      const ownMemberFactsReviewed = ownMembers.every(
        (member) => isKnownCommonModeMember(member, assetsById) || isBoundedUnknownCommonModeMember(member, assetsById),
      );
      const parentControlled = isV9ParentControlledCommonModeMember(assetId, controlAssetDomainId, plan.serialPaths);
      const controllerOwned = isV9ControllerOwnedCommonModeMember(
        assetId,
        mintControlAssessment?.controllerAssetId ?? null,
        plan.serialPaths,
      );
      const context = contextFor(assetId);
      const controlDomainScope = assessV9ControlDomainScope(
        group.failureDomain,
        ownMembers,
        assetsById.get(assetId),
        context.supplyExposure,
      );
      const localControlShare =
        controlDomainScope.economicLossScope === "deployment" ? controlDomainScope.materialShare : null;
      const sameIssuerControl = mintControlSeverity === "low";
      const severity =
        parentControlled || controllerOwned || sameIssuerControl
          ? "low"
          : localControlShare !== null
            ? deploymentControlDomainSeverity(controlDomainScope, materiality)
            : (mintControlSeverity ?? commonModeSignalSeverity(group.failureDomain, context, materiality, chainReviews));
      const shareInfo =
        parentControlled || controllerOwned || sameIssuerControl
          ? null
          : localControlShare !== null
            ? { share: localControlShare, mature: false }
            : commonModeShareForDomain(group.failureDomain, context, materiality, chainReviews);
      const shareUnavailable = severity === "high" && shareInfo !== null && shareInfo.share === null;
      const qualifier =
        parentControlled || controllerOwned
          ? assetId === mintControlAssessment?.controllerAssetId
            ? "own controller, downstream reuse creates no reverse dependency, diagnostic only"
            : "own required parent's controller, priced by the parent cap, diagnostic only"
          : sameIssuerControl
            ? "same-issuer controller, diagnostic only"
            : shareInfo?.chainMaturityUnresolved
              ? "chain maturity unresolved (pending, unreviewed or unavailable supporting citations); no authored failure, no chain charge applied"
              : localControlShare !== null
                ? commonModeReasonQualifier(group.failureDomain.kind, severity, materiality, false)
                : commonModeReasonQualifier(group.failureDomain.kind, severity, materiality, shareUnavailable);
      const ownShare =
        shareInfo !== null && (severity !== "low" || shareInfo.chainMaturityUnresolved) ? shareInfo.share : null;
      const responsibility: V9EvidenceResponsibility = shareInfo?.chainMaturityUnresolved
        ? "unresearched"
        : shareInfo !== null
          ? shareInfo.share === null
            ? "integration-missing"
            : "measured-adverse"
          : ownMemberFactsReviewed && (mintControlAssessment === null || mintControlAssessment.identitiesKnown)
            ? "measured-adverse"
            : "integration-missing";
      let reason: string;
      if (ownShare !== null) {
        reason = `This asset's own reviewed share is ${formatCommonModeSharePct(ownShare)} at ${key}, ${qualifier}.`;
      } else {
        const groupClause = controlCensus
          ? `${effectiveMembers.length} reviewed paths across ${censusAssetIds.length} independent root liabilities share ${key}`
          : `${effectiveMembers.length} reviewed paths across ${censusAssetIds.length} assets share ${key}`;
        const memberQualityClause = groupHasBoundedUnknownMember
          ? `; ${boundedUnknownMemberCount} shared member${boundedUnknownMemberCount === 1 ? " remains" : "s remain"} unresolved`
          : "";
        reason = `${groupClause}${memberQualityClause}, ${qualifier}.`;
      }
      const defaultEconomicLossScope = commonModeEconomicScope(group.failureDomain.kind);
      const economicLossScope =
        controlDomainScope.economicLossScope === "deployment" ? "deployment" : defaultEconomicLossScope;
      const localDeploymentKeys = controlDomainScope.deploymentKeys;
      const signal: V9StructuralSignal = {
        ...materiality.commonModeSignal,
        severity,
        reason,
        ...(shareInfo?.share === null || shareInfo === null
          ? {}
          : {
              materialSharePct: v9StructuralSignalSharePct(
                assetId,
                "structuralSignals[*].materialSharePct",
                shareInfo.share,
              ),
            }),
        economicLossScope,
        ...(economicLossScope === "deployment"
          ? {
              exposureKey:
                localDeploymentKeys.length === 0
                  ? `common-mode-slice:${assetId}:${key}`
                  : deploymentExposureKey(localDeploymentKeys),
              riskEventKey: deploymentRiskEventKey("common-mode", [key]),
            }
          : {}),
        recoveryPath:
          group.failureDomain.kind === "dex-protocol"
            ? "market-substitution"
            : economicLossScope === "deployment"
              ? "deployment-migration"
              : group.failureDomain.kind === "reserve-issuer" || group.failureDomain.kind === "reserve-custodian"
                ? "unknown"
                : "issuer-remediation",
        expectedRecoverySec: null,
        lossAbsorptionPct: 0,
        responsibility,
        evidenceConfidence: responsibility === "measured-adverse" && ownMemberFactsKnown ? "high" : "low",
        failureDomainKeys: [key],
        evidence: [],
      };
      signals.set(assetId, [...(signals.get(assetId) ?? []), signal]);
    }
  }
  return new Map(
    [...signals].map(([assetId, assetSignals]) => [
      assetId,
      [...assetSignals].sort((left, right) =>
        compareText(left.failureDomainKeys[0] ?? "", right.failureDomainKeys[0] ?? ""),
      ),
    ]),
  );
}

function upstreamPillarCause(result: V9EvaluatedAsset, pillar: V9QualityPillar) {
  const input = result.scoreInput.pillars[pillar];
  if (input.aggregationDisposition === "excluded-a-b") return input.excludedCauses?.[0] ?? "U";
  return (
    input.limitedEvidenceCauses.find((cause) => cause === "C" || cause === "U") ??
    (input.reasons.some((reason) => reason.cause === "D") ||
    (input.adverseAttribution?.length ?? 0) > 0 ||
    input.structuralSignals.some(
      (signal) => signal.responsibility === "measured-adverse" && signal.pricedInPillar === pillar,
    )
      ? "D"
      : null)
  );
}

function buildUpstreamResult(evaluatedAsset: V9EvaluatedAsset): V9UpstreamResult {
  const semanticNrCauses = evaluatedAsset.trace.nrReasons.flatMap((reason) =>
    reason.cause === "C" || reason.cause === "U" || reason.cause === "D" ? [reason.cause] : [],
  );
  const finalCause =
    evaluatedAsset.trace.ratingStatus === "pipeline-gap"
      ? (evaluatedAsset.trace.partialEvidence?.causes[0] ?? "U")
      : (evaluatedAsset.trace.limitedEvidenceCauses[0] ??
        semanticNrCauses[0] ??
        (evaluatedAsset.trace.adverseAttribution.length > 0 ? "D" : null));
  const oracleNavProjection = upstreamOracleNavProjection(evaluatedAsset);
  return {
    assetId: evaluatedAsset.assetId,
    score: projectV9DependencyScore(evaluatedAsset.trace),
    ratingStatus: evaluatedAsset.trace.ratingStatus,
    partialEvidence: evaluatedAsset.trace.partialEvidence,
    causeGapIds:
      evaluatedAsset.trace.ratingStatus === "pipeline-gap"
        ? evaluatedAsset.trace.causeGapIds
        : evaluatedAsset.trace.causeGapIds.filter((id) => !evaluatedAsset.trace.partialEvidence?.causeGapIds.includes(id)),
    limitedEvidenceCauses:
      evaluatedAsset.trace.limitedEvidenceCauses.length > 0
        ? evaluatedAsset.trace.limitedEvidenceCauses
        : [...new Set(semanticNrCauses)].sort(compareText),
    cause: finalCause,
    dimensionCauses: {
      final: finalCause,
      backing: upstreamPillarCause(evaluatedAsset, "backing"),
      exit: upstreamPillarCause(evaluatedAsset, "exit"),
      access: upstreamPillarCause(evaluatedAsset, "exit"),
      control: upstreamPillarCause(evaluatedAsset, "control"),
      "oracle-nav": oracleNavProjection.cause,
    },
    backingScore: projectV9EffectiveBackingPillarScore(evaluatedAsset),
    exitScore: evaluatedAsset.scoreInput.pillars.exit.score,
    accessScore: upstreamExitAccessScore(evaluatedAsset.exit),
    controlScore: evaluatedAsset.scoreInput.pillars.control.score,
    oracleNavScore: oracleNavProjection.score,
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
    }
  | {
      status: "quarantine-required";
      failures: Array<[string, string]>;
    };

/**
 * Evaluate exactly one dependency-ordered chunk of V9 assets using strictly
 * pinned state and prior-chunk upstream snapshots, reproducing monolithic
 * `evaluateValidatedV9FactSetForPublication` + `projectSafetyScoreV9Card`.
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
  const assetDigests: V9ChunkAssetDigestPayload[] = [];
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
      upstreamResult = buildUpstreamResult(evaluatedAsset);
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

    // Record internal tokenized-fund state identically to candidate.ts.
    if (evaluatedAsset.trace.ratingStatus !== "pipeline-gap" && isTokenizedFundId(evaluatedAsset.assetId)) {
      const backing = evaluatedAsset.scoreInput.pillars.backing;
      if (
        evaluatedAsset.trace.ratingStatus === "rated" &&
        backing.aggregationDisposition !== "excluded-a-b" &&
        backing.score !== null &&
        Number.isFinite(backing.score) &&
        backing.score >= 0 &&
        backing.score <= 100
      ) {
        internalLenderBackingScores.push([evaluatedAsset.assetId, backing.score]);
      }
      const exitPillar = evaluatedAsset.scoreInput.pillars.exit;
      const exitDisposition = exitPillar.aggregationDisposition ?? "included";
      const isVerifiedEmpty =
        evaluatedAsset.trace.ratingStatus === "rated" &&
        exitPillar.score === 0 &&
        exitDisposition === "included" &&
        evaluatedAsset.exit.primaryRouteKey === null &&
        exitPillar.reasons.some((reason) => reason.code === "no-viable-exit-path" && reason.cause === "D");
      if (isVerifiedEmpty) {
        internalVerifiedEmptyExitState.push([evaluatedAsset.assetId, "verified-empty"]);
      } else {
        const hasPositiveExitRoute =
          evaluatedAsset.exit.primaryRouteKey !== null ||
          evaluatedAsset.exit.routes.some(
            (route) => route.included || (route.capacityPoint !== null && route.capacityPoint.executableUsd > 0),
          ) ||
          (exitPillar.score !== null &&
            exitPillar.score > 0 &&
            !exitPillar.reasons.some(
              (reason) =>
                reason.code === "missing-same-notional-route" ||
                reason.code === "missing-runtime-route-evidence",
            ));
        if (hasPositiveExitRoute) {
          internalVerifiedEmptyExitState.push([evaluatedAsset.assetId, "positive-route"]);
        }
      }
      internalExitRoutes.push([
        evaluatedAsset.assetId,
        {
          primaryRouteKey: evaluatedAsset.exit.primaryRouteKey,
          diversificationRouteKey: evaluatedAsset.exit.diversificationRouteKey,
          diversificationBonus: evaluatedAsset.exit.diversificationBonus,
        },
      ]);
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

    assetDigests.push({
      compactTrace: evaluatedAsset.compactTrace,
      dependencyInputs: evaluatedAsset.dependencyInputs,
      access: evaluatedAsset.access,
      wrapperParentLimit: evaluatedAsset.trace.wrapperParentLimit,
    });
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
  const allAssetDigests: V9ChunkAssetDigestPayload[] = [];
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
  const chainMaturityPolicy = resolveV9PolicyChainMaturityIdentity(input.envelope);
  const evaluatedSetDigest = sha256HexFromUtf8Chunks(
    stableJsonStringifyChunksV1({
      domain: V9_EVALUATED_SET_DIGEST_DOMAIN,
      result: {
        schemaVersion: 1,
        factSetDigest: input.factSetDigest,
        baseInputGenerationId: input.baseInputGenerationId,
        policyId: input.envelope.policy.policyId,
        policyDigest: input.envelope.semanticDigest,
        chainMaturityPolicy,
        evaluationBuildDigest: input.evaluationBuildDigest,
        asOfSec: input.asOfSec,
        sourceGenerations: input.sourceGenerations,
        dependencyPlanDigest: input.dependencyPlan.planDigest,
        evaluationOrder: input.dependencyPlan.topologicalOrder,
        scoreResultDigest,
        assets: allAssetDigests,
      },
    }),
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
    planningById.set(asset.assetId, {
      assetId: asset.assetId,
      assetIssuerKey: asset.assetIssuerKey,
      dependencies: asset.dependencies,
      reserveExposures: asset.reserveExposures,
      exitRoutes: asset.exitRoutes,
      exitStatus: asset.exitStatus,
      controls: asset.controls,
      peg: asset.peg,
      supply: asset.supply,
      economicControlReview: asset.economicControlReview,
    });
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

export function formatV9MeasuredExitExpiryMessage(
  witnesses: readonly SafetyScoreV9DexExpiryWitness[],
  clockSec: number,
): string {
  return `dex-stale: exitRouteObservations.observationHistory.observationWindowEndedAt expired; ${witnesses
    .map(
      (witness) =>
        `route ${witness.routeId} generation ${witness.dexGenerationId} window ended ${witness.observationWindowEndedAt}, ` +
        `clock ${clockSec}, budget ${witness.freshnessMaxSec}s`,
    )
    .join("; ")}`;
}
