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
  const { data: pegSummaryData } = usePegSummary();
  const { data: dexLiquidity } = useDexLiquidity();
  const { data: reportCardsData } = useReportCardsV9();

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
        error={error}
        hasData={!!data?.peggedAssets?.length}
        onRetry={() => {
          void refetch();
        }}
        queries={[{ preset: "stablecoins", dataUpdatedAt, error, hasData: !!data?.peggedAssets?.length, meta }]}
      />
      <SafetyScoreV9StatusNotice response={reportCardsData} />
      {renderNotice?.({ pegRateSources: tableInputs.pegRateSources })}
      <StablecoinTable
        data={data?.peggedAssets}
        isLoading={isLoading}
        activeFilters={activeFilters}
        logos={logos}
        pegRates={tableInputs.pegRates}
        pegScores={tableInputs.pegScores}
        dexLiquidity={dexLiquidity ?? undefined}
        reportCards={tableInputs.reportCards}
      />
    </>
  );
}
