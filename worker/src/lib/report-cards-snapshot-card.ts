import { ACTIVE_STABLECOINS, ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  deriveEffectiveDependencies,
  deriveEffectiveDependencySet,
  type DerivedDependencySet,
} from "@shared/lib/dependency-derivation";
import { buildDependencyGraphEdgesFromDependencies, type DependencyGraphEdge } from "@shared/lib/dependency-graph";
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
import { isRedemptionEligibleForLiquidity } from "@shared/lib/report-card-peg-liquidity";
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

export interface ComputeCardInput {
  meta: (typeof ACTIVE_STABLECOINS)[number];
  pegDataById: Map<string, PegSummaryCoin>;
  activeDepegPeakBpsById: Map<string, number>;
  dexLiqMap: Record<string, Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount">>;
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
}

export interface BuildLiveReportCardsResult {
  cards: ReportCard[];
  dependencyGraphEdges: DependencyGraphEdge[];
  dependenciesById: Map<string, DependencyWeight[]>;
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

function projectBridgeRouteRiskForReportCard(meta: StablecoinMeta): ReportCardBridgeRouteRisk | null {
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
  const redemption = redemptionBackstopMap[meta.id];
  const rating = bluechipMap[meta.id];
  const activeDepegSourceId = resolvedPeg.inheritedFromReference && meta.pegReferenceId ? meta.pegReferenceId : meta.id;
  const activeDepegBps = peg?.activeDepeg ? (activeDepegPeakBpsById.get(activeDepegSourceId) ?? null) : null;
  const redemptionUsedForLiquidity = isRedemptionEligibleForLiquidity(redemption, {
    activeDepegBps,
    dexLiquidityScore: liq?.liquidityScore ?? null,
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
    liquidity: scoreLiquidity(liq, redemption, { activeDepegBps }),
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
  const bridgeRouteRiskProfile = projectBridgeRouteRiskForReportCard(meta);
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
    liquidityScore: liq?.liquidityScore ?? null,
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

function buildEffectiveDependencySetsById(
  metas: readonly StablecoinMeta[],
  liveReserveMap: ReadonlyMap<string, ReserveSlice[]>,
): Map<string, DerivedDependencySet> {
  const dependencySetsById = new Map<string, DerivedDependencySet>();

  for (const meta of metas) {
    const liveReserveSlices = liveReserveMap.get(meta.id);
    dependencySetsById.set(
      meta.id,
      deriveEffectiveDependencySet(meta, liveReserveSlices != null ? { liveReserveSlices } : undefined),
    );
  }

  return dependencySetsById;
}

function collectDependenciesById(
  dependencySetsById: ReadonlyMap<string, DerivedDependencySet>,
): Map<string, DependencyWeight[]> {
  return new Map([...dependencySetsById.entries()].map(([id, set]) => [id, set.dependencies]));
}

export function buildLiveReportCards(input: BuildLiveReportCardsInput): BuildLiveReportCardsResult {
  const dependencySetsById = buildEffectiveDependencySetsById(
    ACTIVE_STABLECOINS as StablecoinMeta[],
    input.liveReserveMap,
  );
  const dependenciesById = collectDependenciesById(dependencySetsById);
  const sortedMetas = topologicalOrder([...ACTIVE_STABLECOINS], { dependenciesById });
  const overallScores = new Map<string, number>();
  const decentralizationScores = new Map<string, number>();
  const blendedDecentralizationScores = new Map<string, number>();
  const liveCards: ReportCard[] = [];

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
      ? collectDependenciesById(buildEffectiveDependencySetsById(metas, options.liveReserveMap))
      : null);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: StablecoinMeta[] = [];

  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      console.warn(`[report-cards] dependency cycle detected at "${id}"; breaking edge to avoid wrong ordering`);
      return;
    }
    visiting.add(id);
    const meta = metaMap.get(id);
    if (!meta) {
      visiting.delete(id);
      return;
    }
    const dependencies = dependenciesById?.get(meta.id) ?? deriveEffectiveDependencies(meta);
    for (const dep of dependencies) {
      if (metaMap.has(dep.id)) visit(dep.id);
    }
    visiting.delete(id);
    visited.add(id);
    result.push(meta);
  }

  for (const meta of metas) {
    visit(meta.id);
  }
  return result;
}
