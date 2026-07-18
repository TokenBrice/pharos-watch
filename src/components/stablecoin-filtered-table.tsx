"use client";

import { useMemo } from "react";
import { useDexLiquidity, usePegSummary, useReportCards } from "@/hooks/api-hooks";
import { useLogos } from "@/hooks/use-logos";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { StablecoinTable } from "@/components/stablecoin-table";
import { buildStablecoinTableInputs } from "@/lib/stablecoin-table-inputs";
import type { FilterTag } from "@shared/types";
import type { PegRateSource } from "@shared/lib/peg-rates";

interface StablecoinFilteredTableProps {
  activeFilters: readonly FilterTag[];
  renderNotice?: (context: { pegRateSources: Record<string, PegRateSource> }) => React.ReactNode;
}

export function StablecoinFilteredTable({ activeFilters, renderNotice }: StablecoinFilteredTableProps) {
  const { data, isLoading, dataUpdatedAt, error, refetch, meta } = useStablecoins();
  const { data: logos } = useLogos();
  const { data: pegSummaryData } = usePegSummary();
  const { data: dexLiquidity } = useDexLiquidity();
  const { data: reportCardsData } = useReportCards();

  const tableInputs = useMemo(
    () =>
      buildStablecoinTableInputs({
        stablecoins: data?.peggedAssets,
        fxFallbackRates: data?.fxFallbackRates,
        pegSummaryCoins: pegSummaryData?.coins,
        reportCards: reportCardsData?.cards,
      }),
    [data?.fxFallbackRates, data?.peggedAssets, pegSummaryData?.coins, reportCardsData?.cards],
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
