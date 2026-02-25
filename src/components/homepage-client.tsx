"use client";

import { useMemo } from "react";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useBluechipRatings } from "@/hooks/use-bluechip-ratings";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { useReportCards } from "@/hooks/use-report-cards";
import { useHomepageFilters } from "@/hooks/use-homepage-filters";
import { StablecoinTable } from "@/components/stablecoin-table";
import { CategoryStats } from "@/components/category-stats";
import { MarketHighlights } from "@/components/market-highlights";
import { TotalMcapChart } from "@/components/total-mcap-chart";
import { PegDiversityChart } from "@/components/peg-diversity-chart";
import { BlacklistSummary } from "@/components/blacklist-summary";
import { CemeterySummary } from "@/components/cemetery-summary";
import { PegTrackerSummary } from "@/components/peg-tracker-summary";
import { LiquiditySummary } from "@/components/liquidity-summary";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { FilterBar } from "@/components/filter-bar";
import { CRON_15MIN } from "@/hooks/use-api-query";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@/lib/stablecoins";
import { PEG_CURRENCY_COUNT } from "@/lib/classification";
import { derivePegRates } from "@/lib/peg-rates";
import type { PegSummaryCoin } from "@/lib/types";

export function HomepageClient() {
  const { data, isLoading, error, dataUpdatedAt } = useStablecoins();
  const { data: logos } = useLogos();
  const { data: pegSummaryData } = usePegSummary();
  const { data: bluechipRatings } = useBluechipRatings();
  const { data: dexLiquidity } = useDexLiquidity();
  const { data: reportCardsData } = useReportCards();
  const metaById = TRACKED_META_BY_ID;
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
  const { rates: pegRates } = useMemo(() => derivePegRates(data?.peggedAssets ?? [], metaById, data?.fxFallbackRates), [data, metaById]);
  const filters = useHomepageFilters();

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md bg-destructive/10 p-4 text-destructive flex items-center justify-between">
          <span>Failed to load stablecoin data. Please check your connection.</span>
          <button
            onClick={() => window.location.reload()}
            className="text-sm font-medium underline hover:no-underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none rounded"
          >
            Retry
          </button>
        </div>
      )}
      {!error && (
        <StaleDataBanner
          queries={[{ label: "Prices", dataUpdatedAt, staleTime: CRON_15MIN }]}
        />
      )}

      <TotalMcapChart />

      <FilterBar {...filters} />

      <StablecoinTable
        data={data?.peggedAssets}
        isLoading={isLoading}
        activeFilters={filters.activeFilters}
        logos={logos}
        pegRates={pegRates}
        searchQuery={filters.searchQuery}
        pegScores={pegScores}
        bluechipRatings={bluechipRatings ?? undefined}
        dexLiquidity={dexLiquidity ?? undefined}
        reportCards={reportCardMap}
        onClearSearch={() => filters.setSearchQuery("")}
        onClearFilters={filters.clearAll}
      />

      <CategoryStats data={data?.peggedAssets} />

      <PegDiversityChart />

      <MarketHighlights data={data?.peggedAssets} logos={logos} pegRates={pegRates} />

      <div className="grid grid-cols-2 gap-3 sm:gap-5">
        <PegTrackerSummary />
        <LiquiditySummary />
        <BlacklistSummary />
        <CemeterySummary />
      </div>

      <p className="text-xs text-muted-foreground text-center max-w-3xl mx-auto">
        Pharos tracks {TRACKED_STABLECOINS.length} stablecoins across {PEG_CURRENCY_COUNT} peg currencies — USD, EUR, GBP,
        gold, silver, and more — with honest governance classification: {TRACKED_STABLECOINS.filter((s) => s.flags.governance === "centralized").length} CeFi,
        {" "}{TRACKED_STABLECOINS.filter((s) => s.flags.governance === "centralized-dependent").length} CeFi-Dependent, and {TRACKED_STABLECOINS.filter((s) => s.flags.governance === "decentralized").length} DeFi. Live market caps, peg
        deviation heatmaps, blacklist monitoring, DEX liquidity scores, and a cemetery of
        fallen stablecoins — updated every 15 minutes.
      </p>
      {dataUpdatedAt > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          Last updated: {new Date(dataUpdatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}
        </p>
      )}
    </div>
  );
}
