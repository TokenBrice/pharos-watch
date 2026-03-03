"use client";

import { useMemo } from "react";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { useReportCards } from "@/hooks/use-report-cards";
import { StablecoinTable } from "@/components/stablecoin-table";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { TRACKED_META_BY_ID } from "@/lib/stablecoins";
import { derivePegRates } from "@/lib/peg-rates";
import { pegCurrencyToFilterTag } from "@/lib/types";
import type { PegCurrency, PegSummaryCoin } from "@/lib/types";

export function PegLandingClient({ pegCurrency }: { pegCurrency: PegCurrency }) {
  const { data, isLoading, dataUpdatedAt, error, refetch } = useStablecoins();
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
      {pegRateSources[`pegged${pegCurrency}`] === "fallback" && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Peg reference uses ECB FX rate (not market-derived) — fewer than 3 coins tracked for {pegCurrency}.
        </p>
      )}
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
