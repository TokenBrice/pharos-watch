import { ACTIVE_STABLECOINS, ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  deriveEffectiveDependencies,
  deriveEffectiveDependencySet,
  type DerivedDependencySet,
} from "@shared/lib/dependency-derivation";
import {
  buildDependencyGraphEdgesFromDependencies,
  diagnoseDependencyGraph,
  type DependencyGraphDiagnostics,
  type DependencyGraphEdge,
} from "@shared/lib/dependency-graph";
import {
  scorePegStability,
  scoreLiquidity,
  scoreResilience,
  scoreDecentralizationBreakdown,
  scoreDependencyRisk,
  computeOverallGrade,
  applyVariantOverallCap,
  resolveResilienceFactors,
  resolveGovernanceQuality,
  resolveOracleRiskScore,
  resolveBridgeRouteRiskScore,
  ORACLE_RISK_SCORE,
  type BlacklistStatus,
} from "@shared/lib/report-cards";
import {
  isRedemptionEligibleForLiquidity,
  type DexDeploymentSupplyCoverage,
} from "@shared/lib/report-card-peg-liquidity";
import {
  applyReportCardDexEvidencePolicy,
  type ReportCardDexEvidenceInput,
} from "@shared/lib/report-card-liquidity-evidence";
import {
  resolveBridgeRouteMateriality,
  type BridgeChainCirculating,
  type BridgeRouteMaterialityResult,
} from "@shared/lib/bridge-route-materiality";
import {
  computeMintAuthorityScore,
  stablecoinToMintAuthorityScoringInput,
  type MintAuthorityParentResolver,
} from "@shared/lib/mint-authority-scoring";
import type {
  StablecoinMeta,
  GovernanceType,
  ReserveSlice,
  DependencyWeight,
  StablecoinLink,
} from "@shared/types/core";
import type { DexLiquidityData, BluechipRating, PegSummaryCoin } from "@shared/types/market";
import type {
  ReportCard,
  DimensionKey,
  ReportCardDimension,
  RawDimensionInputs,
  ReportCardBridgeRouteRisk,
  ReportCardOracleRisk,
} from "@shared/types/report-cards";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { LiveReserveSnapshotProvenance } from "./live-reserves-store";
import type { SameNotionalExitScoringMode } from "@shared/lib/redemption-backstop-scoring";

export interface ComputeCardInput {
  meta: (typeof ACTIVE_STABLECOINS)[number];
  pegDataById: Map<string, PegSummaryCoin>;
  activeDepegPeakBpsById: Map<string, number>;
  dexLiqMap: Record<
    string,
    Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount"> &
      Omit<ReportCardDexEvidenceInput, "liquidityScore"> &
      Partial<Pick<DexLiquidityData, "exitRouteObservations" | "exitRouteObservationCoverage">> & {
        deploymentSupplyCoverage?: DexDeploymentSupplyCoverage | null;
      }
  >;
  redemptionBackstopMap: Record<string, RedemptionBackstopEntry>;
  bluechipMap: Record<string, BluechipRating>;
  overallScores: Map<string, number>;
  /** Parent pre-Mint Authority decentralization scores (wrapper inheritance input). */
  decentralizationScores: Map<string, number>;
  /** Parent final (post-oracle/MAS-blend) decentralization scores (wrapper ceiling). */
  blendedDecentralizationScores: Map<string, number>;
  blacklistStatus: BlacklistStatus;
  liveReserveMap: Map<string, ReserveSlice[]>;
  dependencies: DependencyWeight[];
  dependencySet: DerivedDependencySet;
  dependencySnapshotProvenance?: LiveReserveSnapshotProvenance;
  bridgeRouteMateriality: BridgeRouteMaterialityResult;
  sameNotionalScoringMode?: SameNotionalExitScoringMode;
  exitObservationAsOfSec?: number;
  dexExitObservationMaxAgeSec?: number;
  liveRedemptionExitObservationMaxAgeSec?: number;
  circulatingSupplyUsd?: number | null;
  impairedOutputAssetIds?: readonly string[];
}

export interface BuildLiveReportCardsInput {
  pegDataById: Map<string, PegSummaryCoin>;
  activeDepegPeakBpsById: Map<string, number>;
  dexLiqMap: ComputeCardInput["dexLiqMap"];
  redemptionBackstopMap: Record<string, RedemptionBackstopEntry>;
  bluechipMap: Record<string, BluechipRating>;
  resolvedBlacklistStatuses: Map<string, BlacklistStatus>;
  liveReserveMap: Map<string, ReserveSlice[]>;
  liveReserveProvenanceMap?: ReadonlyMap<string, LiveReserveSnapshotProvenance>;
  chainCirculatingById?: ReadonlyMap<string, BridgeChainCirculating>;
  sameNotionalScoringMode?: SameNotionalExitScoringMode;
  exitObservationAsOfSec?: number;
  dexExitObservationMaxAgeSec?: number;
  liveRedemptionExitObservationMaxAgeSec?: number;
}

export interface BuildLiveReportCardsResult {
  cards: ReportCard[];
  dependencyGraphEdges: DependencyGraphEdge[];
  dependenciesById: Map<string, DependencyWeight[]>;
}

export type DependencyGraphPolicyFailureReason =
  "static-graph-invalid" | "static-scc-unreviewed" | "live-graph-invalid" | "live-scc-unresolved";

export class DependencyGraphPolicyError extends Error {
  constructor(
    readonly reason: DependencyGraphPolicyFailureReason,
    readonly diagnostics: DependencyGraphDiagnostics,
  ) {
    const components = diagnostics.stronglyConnectedComponents.map((component) => component.join(" <-> ")).join(", ");
    super(
      `Dependency graph rejected (${reason})` +
        (components ? `: ${components}` : "") +
        (diagnostics.selfEdges.length > 0 ? `; selfEdges=${diagnostics.selfEdges.length}` : "") +
        (diagnostics.duplicateEdges.length > 0 ? `; duplicateEdges=${diagnostics.duplicateEdges.length}` : ""),
    );
    this.name = "DependencyGraphPolicyError";
  }
}

function resolvePegInput(
  meta: StablecoinMeta,
  pegDataById: Map<string, PegSummaryCoin>,
): {
  peg: PegSummaryCoin | undefined;
  inheritedFromReference: boolean;
  pegReferenceMeta: StablecoinMeta | null;
} {
  const directPeg = pegDataById.get(meta.id);
  if (meta.flags.navToken) {
    const pegReferenceMeta = meta.pegReferenceId ? (ACTIVE_META_BY_ID.get(meta.pegReferenceId) ?? null) : null;
    const pegReference = meta.pegReferenceId ? pegDataById.get(meta.pegReferenceId) : undefined;
    if (pegReference && pegReference.pegScore != null) {
      return {
        peg: pegReference,
        inheritedFromReference: true,
        pegReferenceMeta,
      };
    }

    return {
      peg: undefined,
      inheritedFromReference: false,
      pegReferenceMeta,
    };
  }

  if (directPeg?.pegScore != null || !meta.pegReferenceId) {
    return {
      peg: directPeg,
      inheritedFromReference: false,
      pegReferenceMeta: null,
    };
  }

  const pegReferenceMeta = ACTIVE_META_BY_ID.get(meta.pegReferenceId) ?? null;
  const pegReference = pegDataById.get(meta.pegReferenceId);
  if (!pegReference || pegReference.pegScore == null) {
    return {
      peg: directPeg,
      inheritedFromReference: false,
      pegReferenceMeta,
    };
  }

  return {
    peg: pegReference,
    inheritedFromReference: true,
    pegReferenceMeta,
  };
}

function resolveWrappedAssetDependency(
  meta: StablecoinMeta,
  dependencies: readonly DependencyWeight[],
): DependencyWeight | null {
  if (meta.variantOf) {
    return (
      dependencies.find((dependency) => dependency.id === meta.variantOf) ?? {
        id: meta.variantOf,
        weight: 1,
        type: "wrapper",
      }
    );
  }

  const wrapperDependencies = dependencies.filter((dependency) => (dependency.type ?? "collateral") === "wrapper");
  if (wrapperDependencies.length !== 1 || wrapperDependencies[0].weight < 0.8) return null;
  return wrapperDependencies[0];
}

// Safety Score v8: per-coin Mint Authority Score for the penalty-only
// decentralization blend. Resolved against the full tracked registry so
// wrapped/variant coins inherit through their parents.
const mintAuthorityParentResolver: MintAuthorityParentResolver = (id) =>
  stablecoinToMintAuthorityScoringInput(ACTIVE_META_BY_ID.get(id));

function resolveMintAuthorityBlendScore(meta: StablecoinMeta): number | null {
  return computeMintAuthorityScore(stablecoinToMintAuthorityScoringInput(meta), mintAuthorityParentResolver).score;
}

function mergeOracleRiskSources(...groups: Array<readonly StablecoinLink[] | undefined>): StablecoinLink[] | undefined {
  const links: StablecoinLink[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const link of group ?? []) {
      if (seen.has(link.url)) continue;
      seen.add(link.url);
      links.push(link);
    }
  }

  return links.length > 0 ? links : undefined;
}

function projectOracleRiskForReportCard(
  meta: StablecoinMeta,
  wrappedAssetDependency: DependencyWeight | null,
): ReportCardOracleRisk | null {
  const direct = resolveOracleRiskScore(meta);
  if (direct) {
    return {
      tier: direct.tier,
      score: direct.score,
      label: direct.label,
      summary: direct.selectedBranch?.summary ?? meta.oracleRisk?.summary ?? "",
      reviewedAt: meta.oracleRisk?.reviewedAt,
      reviewer: meta.oracleRisk?.reviewer,
      confidence: meta.oracleRisk?.confidence,
      sources: mergeOracleRiskSources(meta.oracleRisk?.sources, direct.selectedBranch?.sources),
      inheritedFrom: null,
      selectedBranch: direct.selectedBranch
        ? {
            ...direct.selectedBranch,
            score: direct.score,
          }
        : null,
      branches: meta.oracleRisk?.branches?.map((branch) => ({
        ...branch,
        score: ORACLE_RISK_SCORE[branch.tier],
      })),
    };
  }

  const inheritedId = meta.variantOf ?? wrappedAssetDependency?.id ?? null;
  const parent = inheritedId ? (ACTIVE_META_BY_ID.get(inheritedId) ?? null) : null;
  const inherited = parent ? resolveOracleRiskScore(parent) : null;
  if (!parent || !inherited) return null;

  return {
    tier: inherited.tier,
    score: inherited.score,
    label: inherited.label,
    summary: inherited.selectedBranch?.summary ?? parent.oracleRisk?.summary ?? "",
    reviewedAt: parent.oracleRisk?.reviewedAt,
    reviewer: parent.oracleRisk?.reviewer,
    confidence: parent.oracleRisk?.confidence,
    sources: mergeOracleRiskSources(parent.oracleRisk?.sources, inherited.selectedBranch?.sources),
    inheritedFrom: {
      id: parent.id,
      name: parent.name,
      symbol: parent.symbol,
    },
    selectedBranch: inherited.selectedBranch
      ? {
          ...inherited.selectedBranch,
          score: inherited.score,
        }
      : null,
    branches: parent.oracleRisk?.branches?.map((branch) => ({
      ...branch,
      score: ORACLE_RISK_SCORE[branch.tier],
    })),
  };
}

function projectBridgeRouteRiskForReportCard(
  meta: StablecoinMeta,
  materiality: BridgeRouteMaterialityResult,
): ReportCardBridgeRouteRisk | null {
  const resolved = resolveBridgeRouteRiskScore(meta);
  if (!resolved || !meta.bridgeRouteRisk) return null;

  return {
    tier: resolved.tier,
    score: resolved.score,
    label: resolved.label,
    summary: meta.bridgeRouteRisk.summary,
    reviewedAt: meta.bridgeRouteRisk.reviewedAt,
    reviewer: meta.bridgeRouteRisk.reviewer,
    confidence: meta.bridgeRouteRisk.confidence,
    protocols: meta.bridgeRouteRisk.protocols,
    sources: meta.bridgeRouteRisk.sources,
    materiality: {
      status: materiality.status,
      effectiveTier: materiality.effectiveTier,
      selectedRouteId: materiality.selectedRouteId,
      matchedSupplyRatio: materiality.matchedSupplyRatio,
      unknownSupplyRatio: materiality.unknownSupplyRatio,
      unknownChains: materiality.unknownChains,
      reason: materiality.reason,
    },
  };
}

function computeReportCard(input: ComputeCardInput): { card: ReportCard; preMintAuthorityScore: number } {
  const {
    meta,
    pegDataById,
    activeDepegPeakBpsById,
    dexLiqMap,
    redemptionBackstopMap,
    bluechipMap,
    overallScores,
    decentralizationScores,
    blacklistStatus,
    liveReserveMap,
    dependencies,
    dependencySet,
    dependencySnapshotProvenance,
    bridgeRouteMateriality,
  } = input;
  const resolvedPeg = resolvePegInput(meta, pegDataById);
  const peg = resolvedPeg.peg;
  // Use the last-known DEX snapshot even if the upstream freshness window has
  // elapsed. Staleness is surfaced via `inputFreshness.dexLiquidity.stale` and
  // the top-level `liquidityStale` flag; we no longer cascade to NR when the
  // cron lags, which otherwise pushes documented offchain-issuer routes (USDC,
  // USDP, USDT, ...) through the "primary-market route requires DEX liquidity
  // floor" exclusion on routine delays.
  const liq = dexLiqMap[meta.id];
  const dexEvidencePolicy = applyReportCardDexEvidencePolicy(liq ?? { liquidityScore: null });
  const redemption = redemptionBackstopMap[meta.id];
  const rating = bluechipMap[meta.id];
  const activeDepegSourceId = resolvedPeg.inheritedFromReference && meta.pegReferenceId ? meta.pegReferenceId : meta.id;
  const activeDepegBps = peg?.activeDepeg ? (activeDepegPeakBpsById.get(activeDepegSourceId) ?? null) : null;
  const redemptionUsedForLiquidity = isRedemptionEligibleForLiquidity(redemption, {
    activeDepegBps,
    dexLiquidityScore: dexEvidencePolicy.effectiveScore,
  });

  const resilienceFactors = resolveResilienceFactors(meta);
  const liveSlices = liveReserveMap.get(meta.id);
  const mintAuthorityScore = resolveMintAuthorityBlendScore(meta);
  const wrappedAssetDependency = resolveWrappedAssetDependency(meta, dependencies);
  // Inheritance reads the parent's pre-Mint Authority score so each coin's
  // mint-authority drag applies exactly once; oracle risk is already part of
  // that parent score because it belongs to the underlying CDP control surface.
  // The parent's final blended score is only a ceiling (a wrapper never
  // out-scores its blended parent).
  const wrappedAssetDecentralizationScore =
    wrappedAssetDependency != null ? (decentralizationScores.get(wrappedAssetDependency.id) ?? null) : null;
  const wrappedAssetBlendedDecentralizationScore =
    wrappedAssetDependency != null
      ? (input.blendedDecentralizationScores.get(wrappedAssetDependency.id) ?? null)
      : null;

  // One pass produces both the blended decentralization dimension and the
  // pre-Mint-Authority score that wrappers inherit (see `decentralizationScores`
  // in buildLiveReportCards); no second scoreDecentralization call is needed.
  const decentralization = scoreDecentralizationBreakdown(meta.flags.governance as GovernanceType, meta, {
    wrappedAssetDecentralizationScore,
    wrappedAssetId: wrappedAssetDependency?.id ?? null,
    variantKind: wrappedAssetDependency?.id === meta.variantOf ? (meta.variantKind ?? null) : null,
    mintAuthorityScore,
    wrappedAssetBlendedDecentralizationScore,
  });

  const dimensions: Record<DimensionKey, ReportCardDimension> = {
    pegStability: scorePegStability(peg, meta, {
      inheritedFromReference: resolvedPeg.inheritedFromReference,
      pegReferenceMeta: resolvedPeg.pegReferenceMeta,
    }),
    liquidity: scoreLiquidity(liq, redemption, {
      activeDepegBps,
      circulatingSupplyUsd: input.circulatingSupplyUsd,
      sameNotionalScoringMode: input.sameNotionalScoringMode,
      exitObservationAsOfSec: input.exitObservationAsOfSec,
      dexExitObservationMaxAgeSec: input.dexExitObservationMaxAgeSec,
      liveRedemptionExitObservationMaxAgeSec: input.liveRedemptionExitObservationMaxAgeSec,
      impairedOutputAssetIds: input.impairedOutputAssetIds,
    }),
    resilience: scoreResilience(meta, blacklistStatus, liveSlices),
    decentralization: decentralization.dimension,
    dependencyRisk: scoreDependencyRisk(
      {
        governance: meta.flags.governance as GovernanceType,
        dependencies,
        variantParentId: meta.variantOf ?? null,
        variantKind: meta.variantKind ?? null,
      },
      overallScores,
    ),
  };

  const navToken = !!meta.flags.navToken;
  const oracleRisk = resolveOracleRiskScore(meta);
  const bridgeRouteRisk = resolveBridgeRouteRiskScore(meta);
  const oracleRiskProfile = projectOracleRiskForReportCard(meta, wrappedAssetDependency);
  const bridgeRouteRiskProfile = projectBridgeRouteRiskForReportCard(meta, bridgeRouteMateriality);
  const overall = applyVariantOverallCap(
    computeOverallGrade(dimensions, { navToken, activeDepegBps }),
    meta.variantOf != null ? (overallScores.get(meta.variantOf) ?? null) : null,
  );

  const rawInputs: RawDimensionInputs = {
    pegScore: peg?.pegScore ?? null,
    activeDepeg: peg?.activeDepeg ?? false,
    activeDepegBps,
    depegEventCount: peg?.eventCount ?? 0,
    lastEventAt: peg?.lastEventAt ?? null,
    liquidityScore: dexEvidencePolicy.effectiveScore,
    liquidityObservedScore: dexEvidencePolicy.observedScore,
    liquidityCoverageClass: liq?.coverageClass ?? null,
    liquidityCoverageConfidence: liq?.coverageConfidence ?? null,
    liquidityEvidenceClass: liq?.liquidityEvidenceClass ?? null,
    liquidityExitEvidenceKind: dexEvidencePolicy.evidenceKind,
    liquidityEvidenceCeiling: dexEvidencePolicy.scoreCeiling,
    liquidityHasMeasuredEvidence: liq?.hasMeasuredLiquidityEvidence ?? null,
    liquidityEffectiveTvlUsd: liq?.effectiveTvlUsd ?? null,
    liquidityBalanceMeasuredTvlUsd: liq?.balanceMeasuredTvlUsd ?? null,
    liquidityOrganicMeasuredTvlUsd: liq?.organicMeasuredTvlUsd ?? null,
    liquidityDeploymentCoverage: liq?.deploymentCoverage
      ? {
          observedPools: liq.deploymentCoverage.observedPools,
          verifiedNoPools: liq.deploymentCoverage.verifiedNoPools,
          providerInaccessible: liq.deploymentCoverage.providerInaccessible,
        }
      : null,
    effectiveExitScore: dimensions.liquidity.score,
    redemptionBackstopScore: redemption?.score ?? null,
    redemptionRouteFamily: redemption?.routeFamily ?? null,
    redemptionModelConfidence: redemption?.modelConfidence ?? null,
    redemptionUsedForLiquidity,
    redemptionImmediateCapacityUsd: redemption?.immediateCapacityUsd ?? null,
    redemptionImmediateCapacityRatio: redemption?.immediateCapacityRatio ?? null,
    concentrationHhi: liq?.concentrationHhi ?? null,
    bluechipGrade: rating?.grade ?? null,
    canBeBlacklisted: blacklistStatus,
    chainTier: resilienceFactors.chainTier,
    deploymentModel: resilienceFactors.deploymentModel,
    collateralQuality: resilienceFactors.collateralQuality,
    custodyModel: resilienceFactors.custodyModel,
    governanceTier: meta.flags.governance as GovernanceType,
    governanceQuality: resolveGovernanceQuality(meta.flags.governance as GovernanceType, meta),
    mintAuthorityScore,
    oracleRiskTier: oracleRisk?.tier ?? null,
    oracleRiskScore: oracleRisk?.score ?? null,
    bridgeRouteRiskTier: bridgeRouteRisk?.tier ?? null,
    bridgeRouteRiskScore: bridgeRouteRisk?.score ?? null,
    bridgeRouteEffectiveTier: bridgeRouteMateriality.effectiveTier,
    bridgeRouteMaterialityStatus: bridgeRouteMateriality.status,
    bridgeRouteMatchedSupplyRatio:
      bridgeRouteMateriality.totalSupplyUsd > 0 ? bridgeRouteMateriality.matchedSupplyRatio : null,
    bridgeRouteUnknownSupplyRatio:
      bridgeRouteMateriality.totalSupplyUsd > 0 ? bridgeRouteMateriality.unknownSupplyRatio : null,
    bridgeRouteSelectedRouteId: bridgeRouteMateriality.selectedRouteId,
    bridgeRouteUnknownChains: bridgeRouteMateriality.unknownChains,
    dependencies,
    variantParentId: meta.variantOf ?? null,
    variantKind: meta.variantKind ?? null,
    navToken,
    collateralFromLive: !!liveSlices,
    dependencyFromLive: dependencySet.dependencyFromLive,
    dependencySource: dependencySet.source,
    dependencyBaseSource: dependencySet.baseSource,
    mappedLiveReserveWeight: dependencySet.mappedLiveReserveWeight,
    dependencyFallbackReason: dependencySet.fallbackReason,
    dependencySnapshotSource: dependencySnapshotProvenance?.source ?? null,
    dependencySnapshotUpdatedAt: dependencySnapshotProvenance?.fetchedAt ?? null,
  };

  return {
    card: {
      id: meta.id,
      name: meta.name,
      symbol: meta.symbol,
      overallGrade: overall.grade,
      overallScore: overall.score,
      baseScore: overall.baseScore,
      overallCapped: overall.overallCapped,
      uncappedOverallScore: overall.uncappedOverallScore,
      dimensions,
      ratedDimensions: overall.ratedDimensions,
      rawInputs,
      oracleRisk: oracleRiskProfile,
      bridgeRouteRisk: bridgeRouteRiskProfile,
      isDefunct: false,
    },
    preMintAuthorityScore: decentralization.preMintAuthorityScore,
  };
}

export function resolveDependencySetsForScoring(
  metas: readonly StablecoinMeta[],
  liveReserveMap: ReadonlyMap<string, ReserveSlice[]>,
): Map<string, DerivedDependencySet> {
  const staticSetsById = new Map<string, DerivedDependencySet>();
  const dependencySetsById = new Map<string, DerivedDependencySet>();

  for (const meta of metas) {
    staticSetsById.set(meta.id, deriveEffectiveDependencySet(meta));
    const liveReserveSlices = liveReserveMap.get(meta.id);
    dependencySetsById.set(
      meta.id,
      deriveEffectiveDependencySet(meta, liveReserveSlices != null ? { liveReserveSlices } : undefined),
    );
  }

  const staticDiagnostics = diagnoseDependenciesById(metas, collectDependenciesById(staticSetsById));
  if (staticDiagnostics.selfEdges.length > 0 || staticDiagnostics.duplicateEdges.length > 0) {
    throw new DependencyGraphPolicyError("static-graph-invalid", staticDiagnostics);
  }
  if (staticDiagnostics.stronglyConnectedComponents.length > 0) {
    throw new DependencyGraphPolicyError("static-scc-unreviewed", staticDiagnostics);
  }

  const liveDiagnostics = diagnoseDependenciesById(metas, collectDependenciesById(dependencySetsById));
  if (liveDiagnostics.selfEdges.length > 0 || liveDiagnostics.duplicateEdges.length > 0) {
    throw new DependencyGraphPolicyError("live-graph-invalid", liveDiagnostics);
  }
  if (liveDiagnostics.stronglyConnectedComponents.length === 0) {
    return dependencySetsById;
  }

  const liveCycleIds = new Set(liveDiagnostics.stronglyConnectedComponents.flat());
  for (const id of liveCycleIds) {
    const liveSet = dependencySetsById.get(id);
    const fallbackSet = staticSetsById.get(id);
    if (!liveSet?.dependencyFromLive || !fallbackSet || fallbackSet.dependencies.length === 0) continue;
    dependencySetsById.set(id, {
      ...fallbackSet,
      mappedLiveReserveWeight: liveSet.mappedLiveReserveWeight,
      fallbackReason: "live-cycle-to-curated",
    });
  }

  const fallbackDiagnostics = diagnoseDependenciesById(metas, collectDependenciesById(dependencySetsById));
  if (
    fallbackDiagnostics.selfEdges.length > 0 ||
    fallbackDiagnostics.duplicateEdges.length > 0 ||
    fallbackDiagnostics.stronglyConnectedComponents.length > 0
  ) {
    throw new DependencyGraphPolicyError("live-scc-unresolved", fallbackDiagnostics);
  }

  return dependencySetsById;
}

function collectDependenciesById(
  dependencySetsById: ReadonlyMap<string, DerivedDependencySet>,
): Map<string, DependencyWeight[]> {
  return new Map([...dependencySetsById.entries()].map(([id, set]) => [id, set.dependencies]));
}

function diagnoseDependenciesById(
  metas: readonly Pick<StablecoinMeta, "id">[],
  dependenciesById: ReadonlyMap<string, readonly DependencyWeight[]>,
): DependencyGraphDiagnostics {
  return diagnoseDependencyGraph(
    metas.flatMap((meta) =>
      (dependenciesById.get(meta.id) ?? []).map((dependency) => ({
        from: dependency.id,
        to: meta.id,
        weight: dependency.weight,
        type: dependency.type ?? "collateral",
      })),
    ),
  );
}

export function buildLiveReportCards(input: BuildLiveReportCardsInput): BuildLiveReportCardsResult {
  const dependencySetsById = resolveDependencySetsForScoring(
    ACTIVE_STABLECOINS as StablecoinMeta[],
    input.liveReserveMap,
  );
  const dependenciesById = collectDependenciesById(dependencySetsById);
  const sortedMetas = topologicalOrder([...ACTIVE_STABLECOINS], { dependenciesById });
  const overallScores = new Map<string, number>();
  const decentralizationScores = new Map<string, number>();
  const blendedDecentralizationScores = new Map<string, number>();
  const liveCards: ReportCard[] = [];
  const impairedOutputAssetIds = [...input.pegDataById.entries()]
    .filter(([, peg]) => peg.activeDepeg)
    .map(([id]) => id)
    .sort();

  for (const meta of sortedMetas) {
    const { card, preMintAuthorityScore } = computeReportCard({
      meta,
      pegDataById: input.pegDataById,
      activeDepegPeakBpsById: input.activeDepegPeakBpsById,
      dexLiqMap: input.dexLiqMap,
      redemptionBackstopMap: input.redemptionBackstopMap,
      bluechipMap: input.bluechipMap,
      overallScores,
      decentralizationScores,
      blendedDecentralizationScores,
      blacklistStatus: input.resolvedBlacklistStatuses.get(meta.id) ?? false,
      liveReserveMap: input.liveReserveMap,
      dependencies: dependenciesById.get(meta.id) ?? [],
      dependencySet: dependencySetsById.get(meta.id)!,
      dependencySnapshotProvenance: input.liveReserveProvenanceMap?.get(meta.id),
      bridgeRouteMateriality: resolveBridgeRouteMateriality(meta, input.chainCirculatingById?.get(meta.id)),
      sameNotionalScoringMode: input.sameNotionalScoringMode,
      exitObservationAsOfSec: input.exitObservationAsOfSec,
      dexExitObservationMaxAgeSec: input.dexExitObservationMaxAgeSec,
      liveRedemptionExitObservationMaxAgeSec: input.liveRedemptionExitObservationMaxAgeSec,
      circulatingSupplyUsd: Object.values(input.chainCirculatingById?.get(meta.id) ?? {}).reduce((sum, point) => {
        const current = point?.current;
        return sum + (typeof current === "number" && Number.isFinite(current) && current >= 0 ? current : 0);
      }, 0),
      impairedOutputAssetIds,
    });
    liveCards.push(card);
    if (card.overallScore !== null) {
      overallScores.set(card.id, card.overallScore);
    }
    if (card.dimensions.decentralization.score !== null) {
      blendedDecentralizationScores.set(card.id, card.dimensions.decentralization.score);
    }
    // Children inherit the pre-Mint Authority score (mint-authority drag applies
    // once per coin). The oracle/bridge blends remain in this score because they
    // belong to the parent's own control surface; only the MAS blend and the
    // wrapper ceiling are excluded.
    decentralizationScores.set(meta.id, preMintAuthorityScore);
  }

  return {
    cards: liveCards,
    dependencyGraphEdges: buildDependencyGraphEdgesFromDependencies(
      ACTIVE_STABLECOINS as StablecoinMeta[],
      dependenciesById,
    ),
    dependenciesById,
  };
}

export function topologicalOrder(
  metas: StablecoinMeta[],
  options?: {
    liveReserveMap?: ReadonlyMap<string, ReserveSlice[]>;
    dependenciesById?: ReadonlyMap<string, readonly DependencyWeight[]>;
  },
): StablecoinMeta[] {
  const metaMap = new Map(metas.map((meta) => [meta.id, meta]));
  const dependenciesById =
    options?.dependenciesById ??
    (options?.liveReserveMap != null
      ? collectDependenciesById(resolveDependencySetsForScoring(metas, options.liveReserveMap))
      : null);
  const resolvedDependenciesById =
    dependenciesById ?? new Map(metas.map((meta) => [meta.id, deriveEffectiveDependencies(meta)]));
  const diagnostics = diagnoseDependenciesById(metas, resolvedDependenciesById);
  const usesRuntimeDependencies = options?.dependenciesById != null || options?.liveReserveMap != null;
  if (diagnostics.selfEdges.length > 0 || diagnostics.duplicateEdges.length > 0) {
    throw new DependencyGraphPolicyError(
      usesRuntimeDependencies ? "live-graph-invalid" : "static-graph-invalid",
      diagnostics,
    );
  }
  if (diagnostics.stronglyConnectedComponents.length > 0) {
    throw new DependencyGraphPolicyError(
      usesRuntimeDependencies ? "live-scc-unresolved" : "static-scc-unreviewed",
      diagnostics,
    );
  }
  const visited = new Set<string>();
  const result: StablecoinMeta[] = [];

  function visit(id: string) {
    if (visited.has(id)) return;
    const meta = metaMap.get(id);
    if (!meta) return;
    const dependencies = resolvedDependenciesById.get(meta.id) ?? [];
    for (const dep of dependencies) {
      if (metaMap.has(dep.id)) visit(dep.id);
    }
    visited.add(id);
    result.push(meta);
  }

  for (const meta of metas) {
    visit(meta.id);
  }
  return result;
}
