"use client";

import { useMemo } from "react";
import { useDexLiquidity, usePegSummary, useReportCardsV9 } from "@/hooks/api-hooks";
import { logosById } from "@/lib/logos";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { StablecoinTable } from "@/components/stablecoin-table";
import { SafetyScoreV9StatusNotice } from "@/components/safety-score-v9-status-notice";
import { buildStablecoinTableInputs } from "@/lib/stablecoin-table-inputs";
import type { FilterTag } from "@shared/types";
import type { PegRateSource } from "@shared/lib/peg-rates";

interface StablecoinFilteredTableProps {
  activeFilters: readonly FilterTag[];
  renderNotice?: (context: { pegRateSources: Record<string, PegRateSource> }) => React.ReactNode;
}

export function StablecoinFilteredTable({ activeFilters, renderNotice }: StablecoinFilteredTableProps) {
  const { data, isLoading, dataUpdatedAt, error, refetch, meta } = useStablecoins();
  const logos = logosById;
  const pegSummaryQuery = usePegSummary();
  const liquidityQuery = useDexLiquidity();
  const reportCardsQuery = useReportCardsV9();
  const pegSummaryData = pegSummaryQuery.data;
  const dexLiquidity = liquidityQuery.data;
  const reportCardsData = reportCardsQuery.data;
  const failedQueries = [pegSummaryQuery, liquidityQuery, reportCardsQuery].filter((query) => query.error);

  const tableInputs = useMemo(
    () =>
      buildStablecoinTableInputs({
        stablecoins: data?.peggedAssets,
        fxFallbackRates: data?.fxFallbackRates,
        pegSummaryCoins: pegSummaryData?.coins,
        reportCardsV9: reportCardsData,
      }),
    [data?.fxFallbackRates, data?.peggedAssets, pegSummaryData?.coins, reportCardsData],
  );

  return (
    <>
      <QueryFreshnessNotices
        error={error ?? failedQueries[0]?.error}
        hasData={!!data?.peggedAssets?.length}
        onRetry={() => {
          if (error) void refetch();
          for (const query of failedQueries) void query.refetch();
        }}
        queries={[
          { preset: "stablecoins", dataUpdatedAt, error, hasData: !!data?.peggedAssets?.length, meta },
          { preset: "pegSummary", dataUpdatedAt: pegSummaryQuery.dataUpdatedAt, error: pegSummaryQuery.error, hasData: !!pegSummaryData?.coins?.length, meta: pegSummaryQuery.meta },
          { preset: "dexLiquidity", dataUpdatedAt: liquidityQuery.dataUpdatedAt, error: liquidityQuery.error, hasData: !!dexLiquidity, meta: liquidityQuery.meta },
          { preset: "reportCards", dataUpdatedAt: reportCardsQuery.dataUpdatedAt, error: reportCardsQuery.error, hasData: !!reportCardsData?.cards?.length, meta: reportCardsQuery.meta },
        ]}
      />
      <SafetyScoreV9StatusNotice response={reportCardsData} />
      {renderNotice?.({ pegRateSources: tableInputs.pegRateSources })}
      <StablecoinTable
        data={data?.peggedAssets}
        isLoading={isLoading}
        activeFilters={activeFilters}
        logos={logos}
        pegScores={tableInputs.pegScores}
        dexLiquidity={dexLiquidity ?? undefined}
        reportCards={tableInputs.reportCards}
        sourceGenerations={{
          stablecoins: meta?.updatedAt,
          pegSummary: pegSummaryQuery.meta?.updatedAt,
          dexLiquidity: liquidityQuery.meta?.updatedAt,
          reportCards: reportCardsQuery.meta?.updatedAt,
        }}
      />
    </>
  );
}
