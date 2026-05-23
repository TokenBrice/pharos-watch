import {
  collectDependencyGraphIds,
  filterDependencyGraphEdgesToLive,
} from "@shared/lib/dependency-graph";
import { isPricingSourceProtocolOverride } from "@shared/lib/pricing-source-registry";
import { getCirculatingRaw } from "@shared/lib/supply";
import {
  CLIENT_ACTIVE_STABLECOINS as ACTIVE_STABLECOINS,
  type StablecoinClientMeta,
} from "@shared/lib/stablecoins/client-registry";
import type {
  DexLiquidityMap,
  MintBurnFlowsResponse,
  PegSummaryResponse,
  RedemptionBackstopsResponse,
  ReportCardsResponse,
  StablecoinListResponse,
  StablecoinMeta,
  YieldRankingsResponse,
} from "@shared/types";
import type { ApiMeta } from "@/lib/api";
import { getResolvedBlacklistStatus } from "@/lib/blacklist-status";
import {
  buildCoverageFeatureSummary,
  buildCoverageRow,
  COVERAGE_FEATURES,
  type CoverageFeatureKey,
} from "@/lib/coverage";

const FEATURE_QUERY_AVAILABLE_KEYS = [
  "price",
  "safety",
  "dex",
  "redemption",
  "yield",
  "flows",
  "dependency",
] as const satisfies readonly CoverageFeatureKey[];

interface CoverageMatrixQueryResource<TData> {
  data?: TData;
  dataUpdatedAt: number;
  error: unknown | null;
  meta: ApiMeta | null;
}

export interface CoverageMatrixModelInput {
  stablecoins: CoverageMatrixQueryResource<StablecoinListResponse>;
  pegSummary: CoverageMatrixQueryResource<PegSummaryResponse>;
  dexLiquidity: CoverageMatrixQueryResource<DexLiquidityMap>;
  redemptionBackstops: CoverageMatrixQueryResource<RedemptionBackstopsResponse>;
  yieldRankings: CoverageMatrixQueryResource<YieldRankingsResponse>;
  mintBurnFlows: CoverageMatrixQueryResource<MintBurnFlowsResponse>;
  reportCards: CoverageMatrixQueryResource<ReportCardsResponse>;
  activeStablecoins?: readonly StablecoinClientMeta[];
}

function buildQueryAvailability(
  input: CoverageMatrixModelInput,
): Record<CoverageFeatureKey, boolean> {
  const hasPegData = input.pegSummary.data !== undefined;
  const hasDexData = input.dexLiquidity.data !== undefined;
  const hasRedemptionData = input.redemptionBackstops.data !== undefined;
  const hasYieldData = input.yieldRankings.data !== undefined;
  const hasFlowData = input.mintBurnFlows.data !== undefined;
  const hasReportCardData = input.reportCards.data !== undefined;

  return {
    price: hasPegData,
    safety: hasReportCardData,
    dex: hasDexData,
    reserves: hasReportCardData,
    redemption: hasRedemptionData,
    yield: hasYieldData,
    flows: hasFlowData,
    blacklist: true,
    dependency: hasReportCardData,
  };
}

function buildPricingSourceCounts(pegSummaryData: PegSummaryResponse | undefined) {
  const consensusMap = new Map<string, number>();
  const authMap = new Map<string, number>();

  for (const coin of pegSummaryData?.coins ?? []) {
    for (const src of coin.consensusSources ?? []) {
      const target = isPricingSourceProtocolOverride(src) ? authMap : consensusMap;
      target.set(src, (target.get(src) ?? 0) + 1);
    }
  }

  const toSorted = (map: Map<string, number>) =>
    [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  return {
    pricingSources: toSorted(consensusMap),
    authoritativeSources: toSorted(authMap),
  };
}

export function buildCoverageMatrixModel(input: CoverageMatrixModelInput) {
  const activeStablecoins = input.activeStablecoins ?? ACTIVE_STABLECOINS;
  const queryAvailability = buildQueryAvailability(input);
  const assetById = new Map((input.stablecoins.data?.peggedAssets ?? []).map((asset) => [asset.id, asset]));
  const pegIds = new Set((input.pegSummary.data?.coins ?? []).map((coin) => coin.id));
  const pegCoinById = new Map((input.pegSummary.data?.coins ?? []).map((coin) => [coin.id, coin]));
  const yieldIds = new Set((input.yieldRankings.data?.rankings ?? []).map((row) => row.id));
  const flowById = new Map((input.mintBurnFlows.data?.coins ?? []).map((row) => [row.stablecoinId, row]));
  const reportCardById = new Map((input.reportCards.data?.cards ?? []).map((card) => [card.id, card]));
  const liveIds = new Set(
    (input.reportCards.data?.cards ?? []).filter((card) => !card.isDefunct).map((card) => card.id),
  );
  const dependencyIds = collectDependencyGraphIds(
    filterDependencyGraphEdgesToLive(
      input.reportCards.data?.dependencyGraph?.edges ?? [],
      liveIds,
    ),
  );

  const rows = activeStablecoins.map((coin) => {
    const pegCoin = pegCoinById.get(coin.id);
    const asset = assetById.get(coin.id);
    const reportCard = reportCardById.get(coin.id);
    const mcap = asset ? getCirculatingRaw(asset) : 0;
    return buildCoverageRow({
      coin: coin as StablecoinMeta,
      marketCapUsd: mcap,
      hasPegCoverage: pegIds.has(coin.id),
      consensusSources: pegCoin?.consensusSources,
      priceConfidence: pegCoin?.priceConfidence ?? undefined,
      safetyScore: reportCard?.overallScore ?? null,
      dexCoverageClass: input.dexLiquidity.data?.[coin.id]?.coverageClass ?? null,
      redemptionEntry: input.redemptionBackstops.data?.coins?.[coin.id] ?? null,
      hasYieldCoverage: yieldIds.has(coin.id),
      flowCoverageStatus: flowById.get(coin.id)?.coverage?.status ?? null,
      hasDependencyCoverage: dependencyIds.has(coin.id),
      blacklistStatus: getResolvedBlacklistStatus(coin.id, reportCard),
      liveReserveFresh: queryAvailability.reserves ? (reportCard?.rawInputs.collateralFromLive ?? false) : null,
      dataAvailability: queryAvailability,
    });
  });

  const totalMcapUsd = rows.reduce((sum, row) => sum + row.marketCapUsd, 0);
  const featureSummaries = COVERAGE_FEATURES.map((feature) => buildCoverageFeatureSummary(feature, rows, totalMcapUsd));

  let atTargetCount = 0;
  let exactTwoCount = 0;
  let belowTargetCount = 0;
  let atTargetMcapUsd = 0;
  let exactTwoMcapUsd = 0;

  for (const row of rows) {
    const sourceCount = row.statuses.price.sourceCount ?? 0;
    if (sourceCount >= 3) {
      atTargetCount++;
      atTargetMcapUsd += row.marketCapUsd;
    } else {
      belowTargetCount++;
      if (sourceCount === 2) {
        exactTwoCount++;
        exactTwoMcapUsd += row.marketCapUsd;
      }
    }
  }

  const totalCount = rows.length;
  const sourceDepthProgress = {
    totalCount,
    atTargetCount,
    exactTwoCount,
    belowTargetCount,
    atTargetPct: totalCount > 0 ? (atTargetCount / totalCount) * 100 : 0,
    atTargetMcapPct: totalMcapUsd > 0 ? (atTargetMcapUsd / totalMcapUsd) * 100 : null,
    exactTwoMcapPct: totalMcapUsd > 0 ? (exactTwoMcapUsd / totalMcapUsd) * 100 : null,
  };

  const { pricingSources, authoritativeSources } = buildPricingSourceCounts(input.pegSummary.data);
  const widestFeature = [...featureSummaries].sort((left, right) => {
    if (right.coveragePct !== left.coveragePct) {
      return right.coveragePct - left.coveragePct;
    }
    return (right.mcapSharePct ?? 0) - (left.mcapSharePct ?? 0);
  })[0] ?? null;
  const narrowestFeature = [...featureSummaries].sort((left, right) => {
    if (left.coveragePct !== right.coveragePct) {
      return left.coveragePct - right.coveragePct;
    }
    return (left.mcapSharePct ?? 0) - (right.mcapSharePct ?? 0);
  })[0] ?? null;
  const mostConcentratedFeature = [...featureSummaries].sort(
    (left, right) => (right.mcapSharePct ?? 0) - right.coveragePct - ((left.mcapSharePct ?? 0) - left.coveragePct),
  )[0] ?? null;

  const isStablecoinDataUnavailable = input.stablecoins.data === undefined && !!input.stablecoins.error;
  const isInitialDataLoading = [
    input.stablecoins,
    input.pegSummary,
    input.dexLiquidity,
    input.redemptionBackstops,
    input.yieldRankings,
    input.mintBurnFlows,
    input.reportCards,
  ].some((query) => query.data === undefined && !query.error);
  const unavailableFeatures = FEATURE_QUERY_AVAILABLE_KEYS.filter((key) => !queryAvailability[key]);

  const dataUpdatedAt = Math.max(
    input.stablecoins.dataUpdatedAt ?? 0,
    input.pegSummary.dataUpdatedAt ?? 0,
    input.dexLiquidity.dataUpdatedAt ?? 0,
    input.redemptionBackstops.dataUpdatedAt ?? 0,
    input.yieldRankings.dataUpdatedAt ?? 0,
    input.mintBurnFlows.dataUpdatedAt ?? 0,
    input.reportCards.dataUpdatedAt ?? 0,
  );

  return {
    rows,
    featureSummaries,
    sourceDepthProgress,
    pricingSources,
    authoritativeSources,
    widestFeature,
    narrowestFeature,
    mostConcentratedFeature,
    isInitialDataLoading,
    isStablecoinDataUnavailable,
    unavailableFeatures,
    dataUpdatedAt: dataUpdatedAt > 0 ? dataUpdatedAt : undefined,
    staleQueries: [
      {
        preset: "stablecoins" as const,
        dataUpdatedAt: input.stablecoins.dataUpdatedAt,
        error: input.stablecoins.error,
        hasData: input.stablecoins.data !== undefined,
        meta: input.stablecoins.meta,
      },
      {
        preset: "pegSummary" as const,
        dataUpdatedAt: input.pegSummary.dataUpdatedAt,
        error: input.pegSummary.error,
        hasData: input.pegSummary.data !== undefined,
        meta: input.pegSummary.meta,
      },
      {
        preset: "dexLiquidity" as const,
        dataUpdatedAt: input.dexLiquidity.dataUpdatedAt,
        error: input.dexLiquidity.error,
        hasData: input.dexLiquidity.data !== undefined,
        meta: input.dexLiquidity.meta,
      },
      {
        preset: "redemptionBackstops" as const,
        dataUpdatedAt: input.redemptionBackstops.dataUpdatedAt,
        error: input.redemptionBackstops.error,
        hasData: input.redemptionBackstops.data !== undefined,
        meta: input.redemptionBackstops.meta,
      },
      {
        preset: "yieldRankings" as const,
        dataUpdatedAt: input.yieldRankings.dataUpdatedAt,
        error: input.yieldRankings.error,
        hasData: input.yieldRankings.data !== undefined,
        meta: input.yieldRankings.meta,
      },
      {
        preset: "mintBurnFlows" as const,
        dataUpdatedAt: input.mintBurnFlows.dataUpdatedAt,
        error: input.mintBurnFlows.error,
        hasData: input.mintBurnFlows.data !== undefined,
        meta: input.mintBurnFlows.meta,
      },
      {
        preset: "reportCards" as const,
        dataUpdatedAt: input.reportCards.dataUpdatedAt,
        error: input.reportCards.error,
        hasData: input.reportCards.data !== undefined,
        meta: input.reportCards.meta,
      },
    ],
  };
}

export type CoverageMatrixModel = ReturnType<typeof buildCoverageMatrixModel>;
