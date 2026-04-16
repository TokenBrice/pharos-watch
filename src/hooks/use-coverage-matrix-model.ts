"use client";

import { useMemo } from "react";
import {
  buildDependencyGraphEdges,
  collectDependencyGraphIds,
  filterDependencyGraphEdgesToLive,
} from "@shared/lib/dependency-graph";
import { isPricingSourceProtocolOverride } from "@shared/lib/pricing-source-registry";
import { getCirculatingRaw } from "@shared/lib/supply";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import {
  useDexLiquidity,
  usePegSummary,
  useRedemptionBackstops,
  useReportCards,
  useYieldRankings,
} from "@/hooks/api-hooks";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { useStablecoins } from "@/hooks/use-stablecoins";
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

export function useCoverageMatrixModel() {
  const stablecoinsQuery = useStablecoins();
  const pegQuery = usePegSummary();
  const dexQuery = useDexLiquidity();
  const redemptionQuery = useRedemptionBackstops();
  const yieldQuery = useYieldRankings();
  const flowQuery = useMintBurnFlows();
  const reportCardsQuery = useReportCards();

  const queryAvailability = useMemo(() => {
    const hasPegData = pegQuery.data !== undefined;
    const hasDexData = dexQuery.data !== undefined;
    const hasRedemptionData = redemptionQuery.data !== undefined;
    const hasYieldData = yieldQuery.data !== undefined;
    const hasFlowData = flowQuery.data !== undefined;
    const hasReportCardData = reportCardsQuery.data !== undefined;

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
    } satisfies Record<CoverageFeatureKey, boolean>;
  }, [dexQuery.data, flowQuery.data, pegQuery.data, redemptionQuery.data, reportCardsQuery.data, yieldQuery.data]);

  const rows = useMemo(() => {
    const assetById = new Map((stablecoinsQuery.data?.peggedAssets ?? []).map((asset) => [asset.id, asset]));
    const pegIds = new Set((pegQuery.data?.coins ?? []).map((coin) => coin.id));
    const pegCoinById = new Map((pegQuery.data?.coins ?? []).map((coin) => [coin.id, coin]));
    const yieldIds = new Set((yieldQuery.data?.rankings ?? []).map((row) => row.id));
    const flowById = new Map((flowQuery.data?.coins ?? []).map((row) => [row.stablecoinId, row]));
    const reportCardById = new Map((reportCardsQuery.data?.cards ?? []).map((card) => [card.id, card]));
    const liveIds = new Set(
      (reportCardsQuery.data?.cards ?? []).filter((card) => !card.isDefunct).map((card) => card.id),
    );
    const dependencyIds = collectDependencyGraphIds(
      filterDependencyGraphEdgesToLive(
        reportCardsQuery.data?.dependencyGraph?.edges ?? buildDependencyGraphEdges(ACTIVE_STABLECOINS),
        liveIds,
      ),
    );

    return ACTIVE_STABLECOINS.map((coin) => {
      const pegCoin = pegCoinById.get(coin.id);
      const asset = assetById.get(coin.id);
      const reportCard = reportCardById.get(coin.id);
      const mcap = asset ? getCirculatingRaw(asset) : 0;
      return buildCoverageRow({
        coin,
        marketCapUsd: mcap,
        hasPegCoverage: pegIds.has(coin.id),
        consensusSources: pegCoin?.consensusSources,
        priceConfidence: pegCoin?.priceConfidence ?? undefined,
        safetyScore: reportCard?.overallScore ?? null,
        dexCoverageClass: dexQuery.data?.[coin.id]?.coverageClass ?? null,
        redemptionEntry: redemptionQuery.data?.coins?.[coin.id] ?? null,
        hasYieldCoverage: yieldIds.has(coin.id),
        flowCoverageStatus: flowById.get(coin.id)?.coverage?.status ?? null,
        hasDependencyCoverage: dependencyIds.has(coin.id),
        blacklistStatus: getResolvedBlacklistStatus(coin.id, reportCard),
        liveReserveFresh: queryAvailability.reserves ? (reportCard?.rawInputs.collateralFromLive ?? false) : null,
        dataAvailability: queryAvailability,
      });
    });
  }, [
    stablecoinsQuery.data,
    pegQuery.data,
    yieldQuery.data,
    flowQuery.data,
    reportCardsQuery.data,
    dexQuery.data,
    redemptionQuery.data,
    queryAvailability,
  ]);

  const totalMcapUsd = useMemo(() => rows.reduce((sum, row) => sum + row.marketCapUsd, 0), [rows]);

  const featureSummaries = useMemo(
    () => COVERAGE_FEATURES.map((feature) => buildCoverageFeatureSummary(feature, rows, totalMcapUsd)),
    [rows, totalMcapUsd],
  );

  const { pricingSources, authoritativeSources } = useMemo(() => {
    const consensusMap = new Map<string, number>();
    const authMap = new Map<string, number>();

    for (const coin of pegQuery.data?.coins ?? []) {
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
  }, [pegQuery.data]);

  const widestFeature = useMemo(
    () =>
      [...featureSummaries].sort((left, right) => {
        if (right.coveragePct !== left.coveragePct) {
          return right.coveragePct - left.coveragePct;
        }
        return (right.mcapSharePct ?? 0) - (left.mcapSharePct ?? 0);
      })[0] ?? null,
    [featureSummaries],
  );

  const narrowestFeature = useMemo(
    () =>
      [...featureSummaries].sort((left, right) => {
        if (left.coveragePct !== right.coveragePct) {
          return left.coveragePct - right.coveragePct;
        }
        return (left.mcapSharePct ?? 0) - (right.mcapSharePct ?? 0);
      })[0] ?? null,
    [featureSummaries],
  );

  const mostConcentratedFeature = useMemo(
    () =>
      [...featureSummaries].sort(
        (left, right) => (right.mcapSharePct ?? 0) - right.coveragePct - ((left.mcapSharePct ?? 0) - left.coveragePct),
      )[0] ?? null,
    [featureSummaries],
  );

  const isStablecoinDataUnavailable = stablecoinsQuery.data === undefined && !!stablecoinsQuery.error;
  const isInitialDataLoading = [
    stablecoinsQuery,
    pegQuery,
    dexQuery,
    redemptionQuery,
    yieldQuery,
    flowQuery,
    reportCardsQuery,
  ].some((query) => query.data === undefined && !query.error);
  const unavailableFeatures = FEATURE_QUERY_AVAILABLE_KEYS.filter((key) => !queryAvailability[key]);

  return {
    rows,
    featureSummaries,
    pricingSources,
    authoritativeSources,
    widestFeature,
    narrowestFeature,
    mostConcentratedFeature,
    isInitialDataLoading,
    isStablecoinDataUnavailable,
    unavailableFeatures,
    staleQueries: [
      {
        preset: "stablecoins" as const,
        dataUpdatedAt: stablecoinsQuery.dataUpdatedAt,
        error: stablecoinsQuery.error,
        hasData: stablecoinsQuery.data !== undefined,
        meta: stablecoinsQuery.meta,
      },
      {
        preset: "pegSummary" as const,
        dataUpdatedAt: pegQuery.dataUpdatedAt,
        error: pegQuery.error,
        hasData: pegQuery.data !== undefined,
        meta: pegQuery.meta,
      },
      {
        preset: "dexLiquidity" as const,
        dataUpdatedAt: dexQuery.dataUpdatedAt,
        error: dexQuery.error,
        hasData: dexQuery.data !== undefined,
        meta: dexQuery.meta,
      },
      {
        preset: "redemptionBackstops" as const,
        dataUpdatedAt: redemptionQuery.dataUpdatedAt,
        error: redemptionQuery.error,
        hasData: redemptionQuery.data !== undefined,
        meta: redemptionQuery.meta,
      },
      {
        preset: "yieldRankings" as const,
        dataUpdatedAt: yieldQuery.dataUpdatedAt,
        error: yieldQuery.error,
        hasData: yieldQuery.data !== undefined,
        meta: yieldQuery.meta,
      },
      {
        preset: "mintBurnFlows" as const,
        dataUpdatedAt: flowQuery.dataUpdatedAt,
        error: flowQuery.error,
        hasData: flowQuery.data !== undefined,
        meta: flowQuery.meta,
      },
      {
        preset: "reportCards" as const,
        dataUpdatedAt: reportCardsQuery.dataUpdatedAt,
        error: reportCardsQuery.error,
        hasData: reportCardsQuery.data !== undefined,
        meta: reportCardsQuery.meta,
      },
    ],
  };
}
