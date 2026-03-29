import { getCache } from "./db-cache";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { buildDependencyGraphEdges } from "@shared/lib/dependency-graph";
import { deriveDependencies } from "@shared/lib/reserve-templates";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { derivePegAnalyticsSnapshot } from "./peg-analytics";
import {
  loadDexLiquiditySnapshot,
  type DexLiquidityLoadResult,
} from "./dex-liquidity";
import {
  loadRedemptionBackstopMap,
  RedemptionBackstopSnapshotUnavailableError,
} from "./redemption-backstops-store";
import { loadFreshIndependentLiveReserveMap } from "./live-reserves-store";
import {
  summarizeCollateralDriftFromLiveReserveMap,
  type CollateralDriftEntry,
} from "./collateral-drift";
import { parseBluechipRatingsCache } from "./bluechip-cache";
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
import { loadStablecoinsCache, type StablecoinsCacheLoadOk } from "./stablecoins-cache";
import type {
  StablecoinMeta,
  GovernanceType,
  GovernanceQuality,
  ChainTier,
  DeploymentModel,
  CollateralQuality,
  CustodyModel,
  ReserveSlice,
} from "@shared/types/core";
import type {
  StablecoinData,
  DexLiquidityData,
  BluechipRating,
  PegSummaryCoin,
} from "@shared/types/market";
import type {
  ReportCard,
  DimensionKey,
  RawDimensionInputs,
  ReportCardGrade,
} from "@shared/types/report-cards";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";

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
  /** Coins where live vs curated collateral score diverges by >15 points */
  collateralDriftCoins?: CollateralDriftEntry[];
  /** Coins that fell back from live to curated scoring */
  liveToFallbackCoins?: string[];
}

export class ReportCardsSnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportCardsSnapshotUnavailableError";
  }
}

interface ReportCardsSnapshotInputs {
  stablecoinsCached: StablecoinsCacheLoadOk;
  bluechipCached: Awaited<ReturnType<typeof getCache>> | null;
  dexLiquiditySnapshot: DexLiquidityLoadResult;
  redemptionBackstopMap: Record<string, RedemptionBackstopEntry>;
  liveReserveMap: Map<string, ReserveSlice[]>;
  liquidityStale: boolean;
}

const EMPTY_DEX_LIQUIDITY_SNAPSHOT: DexLiquidityLoadResult = {
  map: {},
  latestUpdatedAt: null,
};

async function loadReportCardsSnapshotInputs(db: D1Database): Promise<ReportCardsSnapshotInputs> {
  const [
    stablecoinsCachedResult,
    bluechipCachedResult,
    dexLiquiditySnapshotResult,
    redemptionBackstopMapResult,
    liveReserveMapResult,
  ] = await Promise.allSettled([
    loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false }),
    getCache(db, "bluechip-ratings"),
    loadDexLiquiditySnapshot(db),
    loadRedemptionBackstopMap(db),
    loadFreshIndependentLiveReserveMap(db),
  ]);

  if (stablecoinsCachedResult.status === "rejected") {
    throw stablecoinsCachedResult.reason;
  }
  const stablecoinsCached = stablecoinsCachedResult.value;
  if (stablecoinsCached.kind !== "ok") {
    throw new ReportCardsSnapshotUnavailableError("Cached stablecoins data is corrupt");
  }

  if (redemptionBackstopMapResult.status === "rejected") {
    if (redemptionBackstopMapResult.reason instanceof RedemptionBackstopSnapshotUnavailableError) {
      throw new ReportCardsSnapshotUnavailableError(
        "Redemption backstop snapshot unavailable",
      );
    }
    throw redemptionBackstopMapResult.reason;
  }

  const bluechipCached = bluechipCachedResult.status === "fulfilled"
    ? bluechipCachedResult.value
    : (() => {
        console.warn("[report-cards] Bluechip ratings unavailable; continuing without bluechip overlay:", bluechipCachedResult.reason);
        return null;
      })();

  let dexLiquiditySnapshot = EMPTY_DEX_LIQUIDITY_SNAPSHOT;
  let liquidityStale = false;
  if (dexLiquiditySnapshotResult.status === "fulfilled") {
    dexLiquiditySnapshot = dexLiquiditySnapshotResult.value;
    if (dexLiquiditySnapshot.latestUpdatedAt != null) {
      const ageSec = Math.floor(Date.now() / 1000) - dexLiquiditySnapshot.latestUpdatedAt;
      if (ageSec > 3600) {
        console.warn(`[report-cards] Liquidity data is stale (age: ${ageSec}s)`);
        liquidityStale = true;
      }
    }
  } else {
    console.warn("[report-cards] DEX liquidity snapshot unavailable; suppressing liquidity inputs:", dexLiquiditySnapshotResult.reason);
    liquidityStale = true;
  }

  const liveReserveMap = liveReserveMapResult.status === "fulfilled"
    ? liveReserveMapResult.value
    : (() => {
        console.warn("[report-cards] Live reserve snapshot unavailable; falling back to curated reserves:", liveReserveMapResult.reason);
        return new Map<string, ReserveSlice[]>();
      })();

  return {
    stablecoinsCached,
    bluechipCached,
    dexLiquiditySnapshot,
    redemptionBackstopMap: redemptionBackstopMapResult.value,
    liveReserveMap,
    liquidityStale,
  };
}

export async function buildReportCardsSnapshot(db: D1Database): Promise<ReportCardsSnapshot> {
  const {
    stablecoinsCached,
    bluechipCached,
    dexLiquiditySnapshot,
    redemptionBackstopMap,
    liveReserveMap,
    liquidityStale,
  } = await loadReportCardsSnapshotInputs(db);

  const dexLiqMap = dexLiquiditySnapshot.map;
  const peggedAssets: StablecoinData[] = stablecoinsCached.payload.peggedAssets;
  const fxFallbackRates = stablecoinsCached.payload.fxFallbackRates;

  const bluechipMap: Record<string, BluechipRating> = parseBluechipRatingsCache(
    bluechipCached?.value,
    "report-cards-snapshot",
  );

  const pegAnalytics = await derivePegAnalyticsSnapshot(db, {
    peggedAssets,
    fxFallbackRates,
    methodologyAsOf: stablecoinsCached.updatedAt,
    includeNavTokens: false,
  });
  const pegDataById = pegAnalytics.pegDataById;

  const blacklistableIds: ReadonlySet<string> = new Set(
    ACTIVE_STABLECOINS
      .filter((meta) => isBlacklistable(meta) === true)
      .map((meta) => meta.id),
  );

  const sortedMetas = topologicalOrder([...ACTIVE_STABLECOINS]);
  const overallScores = new Map<string, number>();
  const liveCards: ReportCard[] = [];

  for (const meta of sortedMetas) {
    const card = computeCard({
      meta,
      pegDataById,
      dexLiqMap,
      redemptionBackstopMap,
      bluechipMap,
      overallScores,
      blacklistableIds,
      liveReserveMap,
      liquidityStale,
    });
    liveCards.push(card);
    if (card.overallScore !== null) {
      overallScores.set(card.id, card.overallScore);
    }
  }

  const {
    driftCoins: collateralDriftCoins,
    fallbackCoins: liveToFallbackCoins,
  } = summarizeCollateralDriftFromLiveReserveMap(liveReserveMap);

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
        redemptionModelConfidence: null,
        redemptionUsedForLiquidity: false,
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

  const edges = buildDependencyGraphEdges(ACTIVE_STABLECOINS);

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
    ...(collateralDriftCoins.length > 0 ? { collateralDriftCoins } : {}),
    ...(liveToFallbackCoins.length > 0 ? { liveToFallbackCoins } : {}),
  };
}

interface ComputeCardInput {
  meta: (typeof ACTIVE_STABLECOINS)[number];
  pegDataById: Map<string, PegSummaryCoin>;
  dexLiqMap: Record<string, Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount">>;
  redemptionBackstopMap: Record<string, RedemptionBackstopEntry>;
  bluechipMap: Record<string, BluechipRating>;
  overallScores: Map<string, number>;
  blacklistableIds: ReadonlySet<string>;
  liveReserveMap: Map<string, ReserveSlice[]>;
  liquidityStale: boolean;
}

function computeCard(input: ComputeCardInput): ReportCard {
  const {
    meta,
    pegDataById,
    dexLiqMap,
    redemptionBackstopMap,
    bluechipMap,
    overallScores,
    blacklistableIds,
    liveReserveMap,
    liquidityStale,
  } = input;
  const peg = pegDataById.get(meta.id);
  const liq = liquidityStale ? undefined : dexLiqMap[meta.id];
  const redemption = redemptionBackstopMap[meta.id];
  const rating = bluechipMap[meta.id];
  const redemptionUsedForLiquidity =
    redemption?.resolutionState === "resolved" && redemption?.modelConfidence !== "low";

  const canBeBlacklisted = isBlacklistable(meta, blacklistableIds);
  const resilienceFactors = resolveResilienceFactors(meta);
  const liveSlices = liveReserveMap.get(meta.id);
  const deps = deriveDependencies(meta);

  const dimensions: Record<DimensionKey, ReturnType<typeof scorePegStability>> = {
    pegStability: scorePegStability(peg, meta),
    liquidity: scoreLiquidity(liq, redemption),
    resilience: scoreResilience(meta, canBeBlacklisted, liveSlices),
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
    redemptionModelConfidence: redemption?.modelConfidence ?? null,
    redemptionUsedForLiquidity,
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
    dependencies: deps,
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
    dimensions,
    ratedDimensions: overall.ratedDimensions,
    rawInputs,
    ...(deps.length > 0 ? { dependencies: deps } : {}),
    isDefunct: false,
  };
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
