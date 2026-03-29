"use client";

import { useMemo } from "react";
import { useDexLiquidity, usePegSummary, useReportCards } from "@/hooks/api-hooks";
import { useLogos } from "@/hooks/use-logos";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StablecoinTable } from "@/components/stablecoin-table";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { buildPegSummaryCoinMap, buildReportCardMap } from "@/lib/stablecoin-lookups";
import { derivePegRates } from "@shared/lib/peg-rates";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { FilterTag } from "@shared/types";

interface StablecoinFilteredTableProps {
  activeFilters: readonly FilterTag[];
  renderNotice?: (context: { pegRateSources: Record<string, "median" | "fallback"> }) => React.ReactNode;
}

export function StablecoinFilteredTable({ activeFilters, renderNotice }: StablecoinFilteredTableProps) {
  const { data, isLoading, dataUpdatedAt, error, refetch, meta } = useStablecoins();
  const { data: logos } = useLogos();
  const { data: pegSummaryData } = usePegSummary();
  const { data: dexLiquidity } = useDexLiquidity();
  const { data: reportCardsData } = useReportCards();

  const pegScores = useMemo(() => buildPegSummaryCoinMap(pegSummaryData?.coins), [pegSummaryData?.coins]);

  const reportCardMap = useMemo(() => buildReportCardMap(reportCardsData?.cards), [reportCardsData?.cards]);

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
        queries={[{ preset: "stablecoins", dataUpdatedAt, error, hasData: !!data?.peggedAssets?.length, meta }]}
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
