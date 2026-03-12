"use client";

import { useMemo } from "react";
import { useDexLiquidity, usePegSummary, useReportCards } from "@/hooks/api-hooks";
import { useLogos } from "@/hooks/use-logos";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StablecoinTable } from "@/components/stablecoin-table";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { derivePegRates } from "@shared/lib/peg-rates";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { FilterTag, PegSummaryCoin } from "@shared/types";

interface StablecoinFilteredTableProps {
  activeFilters: readonly FilterTag[];
  renderNotice?: (context: { pegRateSources: Record<string, "median" | "fallback"> }) => React.ReactNode;
}

export function StablecoinFilteredTable({ activeFilters, renderNotice }: StablecoinFilteredTableProps) {
  const { data, isLoading, dataUpdatedAt, error, refetch } = useStablecoins();
  const { data: logos } = useLogos();
  const { data: pegSummaryData } = usePegSummary();
  const { data: dexLiquidity } = useDexLiquidity();
  const { data: reportCardsData } = useReportCards();

  const pegScores = useMemo(() => {
    const map = new Map<string, PegSummaryCoin>();
    if (!pegSummaryData?.coins) return map;
    for (const coin of pegSummaryData.coins) {
      map.set(coin.id, coin);
    }
    return map;
  }, [pegSummaryData]);

  const reportCardMap = useMemo(() => {
    if (!reportCardsData?.cards) return undefined;
    return Object.fromEntries(reportCardsData.cards.map((card) => [card.id, card]));
  }, [reportCardsData]);

  const { rates: pegRates, sources: pegRateSources } = useMemo(
    () => derivePegRates(data?.peggedAssets ?? [], TRACKED_META_BY_ID, data?.fxFallbackRates),
    [data],
  );

  return (
    <>
      <QueryErrorNotice
        error={error}
        hasData={!!data?.peggedAssets?.length}
        onRetry={() => {
          void refetch();
        }}
      />
      <StaleDataBanner
        queries={[{ preset: "stablecoins", dataUpdatedAt, error, hasData: !!data?.peggedAssets?.length }]}
      />
      {renderNotice?.({ pegRateSources })}
      <StablecoinTable
        data={data?.peggedAssets}
        isLoading={isLoading}
        activeFilters={[...activeFilters]}
        logos={logos}
        pegRates={pegRates}
        pegScores={pegScores}
        dexLiquidity={dexLiquidity ?? undefined}
        reportCards={reportCardMap}
      />
    </>
  );
}
