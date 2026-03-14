import { getCache } from "./db-cache";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { deriveDependencies } from "@shared/lib/reserve-templates";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { derivePegAnalyticsSnapshot } from "./peg-analytics";
import { loadDexLiquidityMap } from "./dex-liquidity";
import { loadRedemptionBackstopMap } from "./redemption-backstops-store";
import {
  METHODOLOGY_VERSION,
  DIMENSION_WEIGHTS,
  PEG_MULTIPLIER_EXPONENT,
  GRADE_THRESHOLDS,
  scorePegStability,
  scoreLiquidity,
  scoreResilience,
  scoreDecentralization,
  scoreDependencyRisk,
  computeOverallGrade,
  resolveResilienceFactors,
  resolveGovernanceQuality,
  isBlacklistable,
} from "@shared/lib/report-cards";
import { loadStablecoinsCache } from "./stablecoins-cache";
import type {
  StablecoinData,
  StablecoinMeta,
  DexLiquidityData,
  BluechipRating,
  ReportCard,
  PegSummaryCoin,
  DimensionKey,
  GovernanceType,
  GovernanceQuality,
  RawDimensionInputs,
  ChainTier,
  DeploymentModel,
  CollateralQuality,
  CustodyModel,
  ReportCardGrade,
  RedemptionBackstopEntry,
} from "@shared/types";

export interface ReportCardsSnapshot {
  cards: ReportCard[];
  methodology: {
    version: string;
    weights: Record<DimensionKey, number>;
    pegMultiplierExponent: number;
    thresholds: { grade: ReportCardGrade; min: number }[];
  };
  dependencyGraph: {
    edges: { from: string; to: string }[];
  };
  updatedAt: number;
  liquidityStale: boolean;
}

export class ReportCardsSnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportCardsSnapshotUnavailableError";
  }
}

export async function buildReportCardsSnapshot(db: D1Database): Promise<ReportCardsSnapshot> {
  const [stablecoinsCached, bluechipCached, dexLiqMap, redemptionBackstopMap] = await Promise.all([
    loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false }),
    getCache(db, "bluechip-ratings"),
    loadDexLiquidityMap(db),
    loadRedemptionBackstopMap(db),
  ]);

  // M10: Check liquidity data staleness (separate query — loadDexLiquidityMap doesn't include updated_at)
  let liquidityStale = false;
  try {
    const staleness = await db.prepare("SELECT MAX(updated_at) as max_ts FROM dex_liquidity").first<{ max_ts: number | null }>();
    const maxTs = staleness?.max_ts;
    if (maxTs != null) {
      const ageSec = Math.floor(Date.now() / 1000) - maxTs;
      if (ageSec > 3600) {
        console.warn(`[report-cards] Liquidity data is stale (age: ${ageSec}s)`);
        liquidityStale = true;
      }
    }
  } catch {
    // Non-blocking — staleness check is observability only
  }

  if (stablecoinsCached.kind !== "ok") {
    throw new ReportCardsSnapshotUnavailableError("Cached stablecoins data is corrupt");
  }
  const peggedAssets: StablecoinData[] = stablecoinsCached.payload.peggedAssets;
  const fxFallbackRates = stablecoinsCached.payload.fxFallbackRates;

  let bluechipMap: Record<string, BluechipRating> = {};
  if (bluechipCached) {
    try {
      bluechipMap = JSON.parse(bluechipCached.value) as Record<string, BluechipRating>;
    } catch {
      bluechipMap = {};
    }
  }

  const pegAnalytics = await derivePegAnalyticsSnapshot(db, {
    peggedAssets,
    fxFallbackRates,
    methodologyAsOf: stablecoinsCached.updatedAt,
    includeNavTokens: false,
  });
  const pegDataById = pegAnalytics.pegDataById;

  const blacklistableIds: ReadonlySet<string> = new Set(
    TRACKED_STABLECOINS
      .filter((meta) => isBlacklistable(meta) === true)
      .map((meta) => meta.id),
  );

  const sortedMetas = topologicalOrder([...TRACKED_STABLECOINS]);
  const overallScores = new Map<string, number>();
  const liveCards: ReportCard[] = [];

  for (const meta of sortedMetas) {
    const card = computeCard(
      meta,
      pegDataById,
      dexLiqMap,
      redemptionBackstopMap,
      bluechipMap,
      overallScores,
      blacklistableIds,
    );
    liveCards.push(card);
    if (card.overallScore !== null) {
      overallScores.set(card.id, card.overallScore);
    }
  }

  const defunctCards: ReportCard[] = DEAD_STABLECOINS.map((dead) => {
    const id = dead.llamaId ?? `dead-${dead.symbol.toLowerCase()}`;
    const nrDim = { grade: "F" as const, score: 0, detail: "Defunct stablecoin" };
    return {
      id,
      name: dead.name,
      symbol: dead.symbol,
      overallGrade: "F" as const,
      overallScore: 0,
      baseScore: null,
      dimensions: {
        pegStability: nrDim,
        liquidity: nrDim,
        resilience: nrDim,
        decentralization: nrDim,
        dependencyRisk: nrDim,
      },
      ratedDimensions: 5,
      rawInputs: {
        pegScore: null,
        activeDepeg: false,
        depegEventCount: 0,
        lastEventAt: null,
        liquidityScore: null,
        effectiveExitScore: null,
        redemptionBackstopScore: null,
        redemptionRouteFamily: null,
        redemptionImmediateCapacityUsd: null,
        redemptionImmediateCapacityRatio: null,
        concentrationHhi: null,
        bluechipGrade: null,
        canBeBlacklisted: false,
        chainTier: "ethereum" as ChainTier,
        deploymentModel: "single-chain" as DeploymentModel,
        collateralQuality: "native" as CollateralQuality,
        custodyModel: "onchain" as CustodyModel,
        governanceTier: "centralized" as GovernanceType,
        governanceQuality: "single-entity" as GovernanceQuality,
        dependencies: [],
        navToken: false,
        collateralFromLive: false,
      },
      isDefunct: true,
    };
  });

  const allCards = [...liveCards, ...defunctCards];
  allCards.sort((a, b) => {
    if (a.overallScore === null && b.overallScore === null) return 0;
    if (a.overallScore === null) return 1;
    if (b.overallScore === null) return -1;
    return b.overallScore - a.overallScore;
  });

  const edges: { from: string; to: string }[] = [];
  for (const meta of TRACKED_STABLECOINS) {
    for (const dep of deriveDependencies(meta)) {
      edges.push({ from: dep.id, to: meta.id });
    }
  }

  return {
    cards: allCards,
    methodology: {
      version: METHODOLOGY_VERSION,
      weights: DIMENSION_WEIGHTS,
      pegMultiplierExponent: PEG_MULTIPLIER_EXPONENT,
      thresholds: GRADE_THRESHOLDS,
    },
    dependencyGraph: { edges },
    updatedAt: stablecoinsCached.updatedAt,
    liquidityStale,
  };
}

function computeCard(
  meta: (typeof TRACKED_STABLECOINS)[number],
  pegDataById: Map<string, PegSummaryCoin>,
  dexLiqMap: Record<string, Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount">>,
  redemptionBackstopMap: Record<string, RedemptionBackstopEntry>,
  bluechipMap: Record<string, BluechipRating>,
  overallScores: Map<string, number>,
  blacklistableIds: ReadonlySet<string>,
): ReportCard {
  const peg = pegDataById.get(meta.id);
  const liq = dexLiqMap[meta.id];
  const redemption = redemptionBackstopMap[meta.id];
  const rating = bluechipMap[meta.id];

  const canBeBlacklisted = isBlacklistable(meta, blacklistableIds);
  const resilienceFactors = resolveResilienceFactors(meta);

  const dimensions: Record<DimensionKey, ReturnType<typeof scorePegStability>> = {
    pegStability: scorePegStability(peg, meta),
    liquidity: scoreLiquidity(liq, redemption),
    resilience: scoreResilience(meta, canBeBlacklisted),
    decentralization: scoreDecentralization(meta.flags.governance as GovernanceType, meta),
    dependencyRisk: scoreDependencyRisk(meta, overallScores),
  };

  const navToken = !!meta.flags.navToken;
  const overall = computeOverallGrade(dimensions, { navToken });

  const rawInputs: RawDimensionInputs = {
    pegScore: peg?.pegScore ?? null,
    activeDepeg: peg?.activeDepeg ?? false,
    depegEventCount: peg?.eventCount ?? 0,
    lastEventAt: peg?.lastEventAt ?? null,
    liquidityScore: liq?.liquidityScore ?? null,
    effectiveExitScore: dimensions.liquidity.score,
    redemptionBackstopScore: redemption?.score ?? null,
    redemptionRouteFamily: redemption?.routeFamily ?? null,
    redemptionImmediateCapacityUsd: redemption?.immediateCapacityUsd ?? null,
    redemptionImmediateCapacityRatio: redemption?.immediateCapacityRatio ?? null,
    concentrationHhi: liq?.concentrationHhi ?? null,
    bluechipGrade: rating?.grade ?? null,
    canBeBlacklisted,
    chainTier: resilienceFactors.chainTier,
    deploymentModel: resilienceFactors.deploymentModel,
    collateralQuality: resilienceFactors.collateralQuality,
    custodyModel: resilienceFactors.custodyModel,
    governanceTier: meta.flags.governance as GovernanceType,
    governanceQuality: resolveGovernanceQuality(meta.flags.governance as GovernanceType, meta),
    dependencies: deriveDependencies(meta),
    navToken,
    collateralFromLive: false,
  };

  return {
    id: meta.id,
    name: meta.name,
    symbol: meta.symbol,
    overallGrade: overall.grade,
    overallScore: overall.score,
    baseScore: overall.baseScore,
    dimensions,
    ratedDimensions: overall.ratedDimensions,
    rawInputs,
    ...(() => {
      const deps = deriveDependencies(meta);
      return deps.length > 0 ? { dependencies: deps } : {};
    })(),
    isDefunct: false,
  };
}

function topologicalOrder(metas: StablecoinMeta[]): StablecoinMeta[] {
  const metaMap = new Map(metas.map((meta) => [meta.id, meta]));
  const visited = new Set<string>();
  const result: StablecoinMeta[] = [];

  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const meta = metaMap.get(id);
    if (!meta) return;
    for (const dep of deriveDependencies(meta)) {
      if (metaMap.has(dep.id)) visit(dep.id);
    }
    result.push(meta);
  }

  for (const meta of metas) {
    visit(meta.id);
  }
  return result;
}
