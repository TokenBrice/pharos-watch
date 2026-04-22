import { ACTIVE_STABLECOINS, ACTIVE_META_BY_ID } from "@shared/lib/stablecoins";
import { deriveVariantAwareDependencies } from "@shared/lib/stablecoins";
import {
  scorePegStability,
  scoreLiquidity,
  scoreResilience,
  scoreDecentralization,
  scoreDependencyRisk,
  computeOverallGrade,
  applyVariantOverallCap,
  resolveResilienceFactors,
  resolveGovernanceQuality,
  type BlacklistStatus,
} from "@shared/lib/report-cards";
import { isRedemptionEligibleForLiquidity } from "@shared/lib/report-card-peg-liquidity";
import type {
  StablecoinMeta,
  GovernanceType,
  ReserveSlice,
} from "@shared/types/core";
import type {
  DexLiquidityData,
  BluechipRating,
  PegSummaryCoin,
} from "@shared/types/market";
import type {
  ReportCard,
  DimensionKey,
  RawDimensionInputs,
} from "@shared/types/report-cards";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";

export interface ComputeCardInput {
  meta: (typeof ACTIVE_STABLECOINS)[number];
  pegDataById: Map<string, PegSummaryCoin>;
  activeDepegPeakBpsById: Map<string, number>;
  dexLiqMap: Record<string, Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount">>;
  redemptionBackstopMap: Record<string, RedemptionBackstopEntry>;
  bluechipMap: Record<string, BluechipRating>;
  overallScores: Map<string, number>;
  blacklistStatus: BlacklistStatus;
  liveReserveMap: Map<string, ReserveSlice[]>;
}

export interface BuildLiveReportCardsInput {
  pegDataById: Map<string, PegSummaryCoin>;
  activeDepegPeakBpsById: Map<string, number>;
  dexLiqMap: ComputeCardInput["dexLiqMap"];
  redemptionBackstopMap: Record<string, RedemptionBackstopEntry>;
  bluechipMap: Record<string, BluechipRating>;
  resolvedBlacklistStatuses: Map<string, BlacklistStatus>;
  liveReserveMap: Map<string, ReserveSlice[]>;
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
  if (directPeg?.pegScore != null || !meta.flags.navToken || !meta.pegReferenceId) {
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

function computeReportCard(input: ComputeCardInput): ReportCard {
  const {
    meta,
    pegDataById,
    activeDepegPeakBpsById,
    dexLiqMap,
    redemptionBackstopMap,
    bluechipMap,
    overallScores,
    blacklistStatus,
    liveReserveMap,
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
  const activeDepegSourceId =
    resolvedPeg.inheritedFromReference && meta.pegReferenceId
      ? meta.pegReferenceId
      : meta.id;
  const activeDepegBps = peg?.activeDepeg
    ? activeDepegPeakBpsById.get(activeDepegSourceId) ?? null
    : null;
  const redemptionUsedForLiquidity = isRedemptionEligibleForLiquidity(redemption, {
    activeDepegBps,
    dexLiquidityScore: liq?.liquidityScore ?? null,
  });

  const resilienceFactors = resolveResilienceFactors(meta);
  const liveSlices = liveReserveMap.get(meta.id);
  const deps = deriveVariantAwareDependencies(meta);

  const dimensions: Record<DimensionKey, ReturnType<typeof scorePegStability>> = {
    pegStability: scorePegStability(peg, meta, {
      inheritedFromReference: resolvedPeg.inheritedFromReference,
      pegReferenceMeta: resolvedPeg.pegReferenceMeta,
    }),
    liquidity: scoreLiquidity(liq, redemption, { activeDepegBps }),
    resilience: scoreResilience(meta, blacklistStatus, liveSlices),
    decentralization: scoreDecentralization(meta.flags.governance as GovernanceType, meta),
    dependencyRisk: scoreDependencyRisk({
      governance: meta.flags.governance as GovernanceType,
      dependencies: deps,
      variantParentId: meta.variantOf ?? null,
      variantKind: meta.variantKind ?? null,
    }, overallScores),
  };

  const navToken = !!meta.flags.navToken;
  const overall = applyVariantOverallCap(
    computeOverallGrade(dimensions, { navToken, activeDepegBps }),
    meta.variantOf != null
      ? (overallScores.get(meta.variantOf) ?? null)
      : null,
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
    dependencies: deps,
    variantParentId: meta.variantOf ?? null,
    variantKind: meta.variantKind ?? null,
    navToken,
    collateralFromLive: !!liveSlices,
  };

  return {
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
    isDefunct: false,
  };
}

export function buildLiveReportCards(input: BuildLiveReportCardsInput): ReportCard[] {
  const sortedMetas = topologicalOrder([...ACTIVE_STABLECOINS]);
  const overallScores = new Map<string, number>();
  const liveCards: ReportCard[] = [];

  for (const meta of sortedMetas) {
    const card = computeReportCard({
      meta,
      pegDataById: input.pegDataById,
      activeDepegPeakBpsById: input.activeDepegPeakBpsById,
      dexLiqMap: input.dexLiqMap,
      redemptionBackstopMap: input.redemptionBackstopMap,
      bluechipMap: input.bluechipMap,
      overallScores,
      blacklistStatus: input.resolvedBlacklistStatuses.get(meta.id) ?? false,
      liveReserveMap: input.liveReserveMap,
    });
    liveCards.push(card);
    if (card.overallScore !== null) {
      overallScores.set(card.id, card.overallScore);
    }
  }

  return liveCards;
}

export function topologicalOrder(metas: StablecoinMeta[]): StablecoinMeta[] {
  const metaMap = new Map(metas.map((meta) => [meta.id, meta]));
  const visited = new Set<string>();
  const result: StablecoinMeta[] = [];

  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const meta = metaMap.get(id);
    if (!meta) return;
    for (const dep of deriveVariantAwareDependencies(meta)) {
      if (metaMap.has(dep.id)) visit(dep.id);
    }
    result.push(meta);
  }

  for (const meta of metas) {
    visit(meta.id);
  }
  return result;
}
