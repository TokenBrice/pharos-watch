"use client";

import { useMemo } from "react";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { useReportCards } from "@/hooks/use-report-cards";
import { StablecoinTable } from "@/components/stablecoin-table";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { CRON_15MIN } from "@/hooks/use-api-query";
import { TRACKED_META_BY_ID } from "@/lib/stablecoins";
import { derivePegRates } from "@/lib/peg-rates";
import { pegCurrencyToFilterTag } from "@/lib/types";
import type { PegCurrency, PegSummaryCoin } from "@/lib/types";

export function PegLandingClient({ pegCurrency }: { pegCurrency: PegCurrency }) {
  const { data, isLoading, dataUpdatedAt } = useStablecoins();
  const { data: logos } = useLogos();
  const { data: pegSummaryData } = usePegSummary();
  const { data: dexLiquidity } = useDexLiquidity();
  const { data: reportCardsData } = useReportCards();

  const filterTag = pegCurrencyToFilterTag(pegCurrency);
  const activeFilters = useMemo(() => [filterTag], [filterTag]);

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
    return Object.fromEntries(reportCardsData.cards.map((c) => [c.id, c]));
  }, [reportCardsData]);

  const { rates: pegRates } = useMemo(
    () => derivePegRates(data?.peggedAssets ?? [], TRACKED_META_BY_ID, data?.fxFallbackRates),
    [data],
  );

  return (
    <>
      <StaleDataBanner
        queries={[{ label: "Prices", dataUpdatedAt, staleTime: CRON_15MIN }]}
      />
      <StablecoinTable
        data={data?.peggedAssets}
        isLoading={isLoading}
        activeFilters={activeFilters}
        logos={logos}
        pegRates={pegRates}
        pegScores={pegScores}
        dexLiquidity={dexLiquidity ?? undefined}
        reportCards={reportCardMap}
      />
    </>
  );
}
