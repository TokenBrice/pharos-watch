"use client";

import { useMemo } from "react";
import { getCirculatingRaw } from "@shared/lib/supply";
import { TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { deriveDependencies } from "@shared/lib/reserve-templates";
import {
  useBluechipRatings,
  useDexLiquidity,
  usePegSummary,
  useReportCards,
  useYieldRankings,
} from "@/hooks/api-hooks";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { useStablecoins } from "@/hooks/use-stablecoins";
import {
  buildCoverageFeatureSummary,
  buildCoverageRow,
  COVERAGE_FEATURES,
} from "@/lib/coverage";

export function useCoverageMatrixModel() {
  const stablecoinsQuery = useStablecoins();
  const pegQuery = usePegSummary();
  const dexQuery = useDexLiquidity();
  const yieldQuery = useYieldRankings();
  const flowQuery = useMintBurnFlows();
  const bluechipQuery = useBluechipRatings();
  const reportCardsQuery = useReportCards();

  const rows = useMemo(() => {
    const assetById = new Map(
      (stablecoinsQuery.data?.peggedAssets ?? []).map((asset) => [asset.id, asset]),
    );
    const pegIds = new Set((pegQuery.data?.coins ?? []).map((coin) => coin.id));
    const pegCoinById = new Map(
      (pegQuery.data?.coins ?? []).map((coin) => [coin.id, coin]),
    );
    const yieldIds = new Set((yieldQuery.data?.rankings ?? []).map((row) => row.id));
    const flowById = new Map(
      (flowQuery.data?.coins ?? []).map((row) => [row.stablecoinId, row]),
    );
    const reportCardById = new Map(
      (reportCardsQuery.data?.cards ?? []).map((card) => [card.id, card]),
    );
    const dependencyIds = new Set<string>();
    const liveIds = new Set(
      (reportCardsQuery.data?.cards ?? [])
        .filter((card) => !card.isDefunct)
        .map((card) => card.id),
    );

    for (const id of liveIds) {
      const meta = TRACKED_META_BY_ID.get(id);
      if (!meta) continue;

      for (const dependency of deriveDependencies(meta)) {
        if (!liveIds.has(dependency.id)) continue;
        dependencyIds.add(id);
        dependencyIds.add(dependency.id);
      }
    }

    return TRACKED_STABLECOINS.map((coin) => {
      const pegCoin = pegCoinById.get(coin.id);
      return buildCoverageRow({
        coin,
        marketCapUsd: assetById.has(coin.id)
          ? getCirculatingRaw(assetById.get(coin.id)!)
          : 0,
        hasPegCoverage: pegIds.has(coin.id),
        consensusSources: pegCoin?.consensusSources,
        priceConfidence: pegCoin?.priceConfidence ?? undefined,
        safetyScore: reportCardById.get(coin.id)?.overallScore ?? null,
        dexCoverageClass: dexQuery.data?.[coin.id]?.coverageClass ?? null,
        hasYieldCoverage: yieldIds.has(coin.id),
        flowCoverageStatus: flowById.get(coin.id)?.coverage?.status ?? null,
        bluechipGrade: bluechipQuery.data?.[coin.id]?.grade ?? null,
        hasDependencyCoverage: dependencyIds.has(coin.id),
      });
    });
  }, [
    stablecoinsQuery.data,
    pegQuery.data,
    yieldQuery.data,
    flowQuery.data,
    reportCardsQuery.data,
    dexQuery.data,
    bluechipQuery.data,
  ]);

  const totalMcapUsd = useMemo(
    () => rows.reduce((sum, row) => sum + row.marketCapUsd, 0),
    [rows],
  );

  const featureSummaries = useMemo(
    () =>
      COVERAGE_FEATURES.map((feature) =>
        buildCoverageFeatureSummary(feature, rows, totalMcapUsd),
      ),
    [rows, totalMcapUsd],
  );

  const { pricingSources, authoritativeSources } = useMemo(() => {
    const AUTHORITATIVE_KEYS = new Set(["protocol-redeem"]);
    const consensusMap = new Map<string, number>();
    const authMap = new Map<string, number>();

    for (const coin of pegQuery.data?.coins ?? []) {
      for (const src of coin.consensusSources ?? []) {
        const target = AUTHORITATIVE_KEYS.has(src) ? authMap : consensusMap;
        target.set(src, (target.get(src) ?? 0) + 1);
      }
    }

    const toSorted = (map: Map<string, number>) =>
      [...map.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

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
        (left, right) =>
          ((right.mcapSharePct ?? 0) - right.coveragePct) -
          ((left.mcapSharePct ?? 0) - left.coveragePct),
      )[0] ?? null,
    [featureSummaries],
  );

  return {
    rows,
    featureSummaries,
    pricingSources,
    authoritativeSources,
    widestFeature,
    narrowestFeature,
    mostConcentratedFeature,
    staleQueries: [
      {
        preset: "stablecoins" as const,
        dataUpdatedAt: stablecoinsQuery.dataUpdatedAt,
        error: stablecoinsQuery.error,
        hasData: !!stablecoinsQuery.data?.peggedAssets?.length,
      },
      {
        preset: "pegSummary" as const,
        dataUpdatedAt: pegQuery.dataUpdatedAt,
        error: pegQuery.error,
        hasData: !!pegQuery.data?.coins?.length,
        meta: pegQuery.meta,
      },
      {
        preset: "dexLiquidity" as const,
        dataUpdatedAt: dexQuery.dataUpdatedAt,
        error: dexQuery.error,
        hasData: !!dexQuery.data,
        meta: dexQuery.meta,
      },
      {
        preset: "yieldRankings" as const,
        dataUpdatedAt: yieldQuery.dataUpdatedAt,
        error: yieldQuery.error,
        hasData: !!yieldQuery.data?.rankings?.length,
        meta: yieldQuery.meta,
      },
      {
        preset: "mintBurnFlows" as const,
        dataUpdatedAt: flowQuery.dataUpdatedAt,
        error: flowQuery.error,
        hasData: !!flowQuery.data?.coins?.length,
        meta: flowQuery.meta,
      },
      {
        preset: "reportCards" as const,
        dataUpdatedAt: reportCardsQuery.dataUpdatedAt,
        error: reportCardsQuery.error,
        hasData: !!reportCardsQuery.data?.cards?.length,
      },
      {
        preset: "bluechip" as const,
        dataUpdatedAt: bluechipQuery.dataUpdatedAt,
        error: bluechipQuery.error,
        hasData: bluechipQuery.data != null,
      },
    ],
  };
}
