"use client";

import { useCallback, useMemo } from "react";
import Link from "next/link";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { useReportCards } from "@/hooks/use-report-cards";
import { useHomepageFilters } from "@/hooks/use-homepage-filters";
import { StablecoinTable } from "@/components/stablecoin-table";
import { CategoryStats } from "@/components/category-stats";
import { MarketHighlights } from "@/components/market-highlights";
import { TotalMcapChart } from "@/components/total-mcap-chart";
import { PsiHistoryChart } from "@/components/psi-history-chart";
import { PegDiversityChart } from "@/components/peg-diversity-chart";
import { DailyDigest } from "@/components/daily-digest";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { FilterBar } from "@/components/filter-bar";
import { FeatureHighlights } from "@/components/feature-highlights";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@/lib/stablecoins";
import { PEG_CURRENCY_COUNT } from "@/lib/classification";
import { ACTIVE_PEGS, PEG_LABELS_SHORT, PEG_SLUGS, pegCoinCount } from "@/lib/peg-landing";
import { derivePegRates } from "@/lib/peg-rates";
import type { PegSummaryCoin } from "@/lib/types";

export function HomepageClient() {
  const {
    data,
    isLoading,
    error: pricesError,
    dataUpdatedAt,
    refetch: refetchPrices,
  } = useStablecoins();
  const { data: logos } = useLogos();
  const {
    data: pegSummaryData,
    dataUpdatedAt: pegUpdatedAt,
    error: pegError,
    refetch: refetchPeg,
  } = usePegSummary();
  const {
    data: dexLiquidity,
    dataUpdatedAt: liqUpdatedAt,
    error: liquidityError,
    refetch: refetchLiquidity,
  } = useDexLiquidity();
  const {
    data: reportCardsData,
    dataUpdatedAt: rcUpdatedAt,
    error: reportCardsError,
    refetch: refetchReportCards,
  } = useReportCards();
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
  const globalError = pricesError ?? pegError ?? liquidityError ?? reportCardsError;
  const handleRetry = useCallback(() => {
    void Promise.allSettled([
      refetchPrices(),
      refetchPeg(),
      refetchLiquidity(),
      refetchReportCards(),
    ]);
  }, [refetchPeg, refetchLiquidity, refetchPrices, refetchReportCards]);

  return (
    <div className="space-y-6">
      <QueryErrorNotice
        error={globalError}
        hasData={!!data?.peggedAssets?.length}
        onRetry={handleRetry}
      />
      <StaleDataBanner
        queries={[
          { preset: "stablecoins", dataUpdatedAt, error: pricesError, hasData: !!data?.peggedAssets?.length },
          { preset: "pegSummary", dataUpdatedAt: pegUpdatedAt, error: pegError, hasData: !!pegSummaryData?.coins?.length },
          { preset: "dexLiquidity", dataUpdatedAt: liqUpdatedAt, error: liquidityError, hasData: !!dexLiquidity },
          { preset: "reportCards", dataUpdatedAt: rcUpdatedAt, error: reportCardsError, hasData: !!reportCardsData?.cards?.length },
        ]}
      />

      <SectionErrorBoundary name="highlights">
        <MarketHighlights data={data?.peggedAssets} logos={logos} pegRates={pegRates} />
      </SectionErrorBoundary>

      <SectionErrorBoundary name="digest">
        <DailyDigest />
      </SectionErrorBoundary>

      <SectionErrorBoundary name="charts">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <TotalMcapChart />
          <PsiHistoryChart excludeEvents={["Tether DOJ Probe", "IRON Finance"]} />
        </div>
      </SectionErrorBoundary>

      <SectionErrorBoundary name="table">
        <section>
          <div className="space-y-2 mb-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Browse By Peg
            </h2>
            <div className="flex flex-wrap gap-2">
              {ACTIVE_PEGS.map((peg) => {
                const slug = PEG_SLUGS[peg];
                if (!slug) return null;
                return (
                  <Link
                    key={peg}
                    href={`/stablecoins/${slug}/`}
                    className="inline-flex items-center rounded-full border px-3 py-1.5 sm:py-1 min-h-11 sm:min-h-0 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  >
                    {PEG_LABELS_SHORT[peg]} ({pegCoinCount(peg)})
                  </Link>
                );
              })}
            </div>
          </div>
          <h2 className="text-xl font-semibold tracking-tight mb-4">Key Stablecoin Data</h2>
          <FilterBar {...filters} />
          <div className="mt-6">
            <StablecoinTable
              data={data?.peggedAssets}
              isLoading={isLoading}
              activeFilters={filters.activeFilters}
              logos={logos}
              pegRates={pegRates}
              searchQuery={filters.searchQuery}
              pegScores={pegScores}
              dexLiquidity={dexLiquidity ?? undefined}
              reportCards={reportCardMap}
              onClearSearch={() => filters.setSearchQuery("")}
              onClearFilters={filters.clearAll}
            />
          </div>
        </section>
      </SectionErrorBoundary>

      <FeatureHighlights />

      <SectionErrorBoundary name="stats">
        <section>
          <h2 className="text-xl font-semibold tracking-tight mb-4">Stablecoin Distribution</h2>
          <CategoryStats data={data?.peggedAssets} reportCards={reportCardMap} />
        </section>
      </SectionErrorBoundary>

      <PegDiversityChart />

      <p className="text-xs text-muted-foreground text-center max-w-3xl mx-auto">
        Pharos tracks {TRACKED_STABLECOINS.length} stablecoins across {PEG_CURRENCY_COUNT} peg currencies (USD, EUR, GBP,
        gold, silver, and more) with honest governance classification: {TRACKED_STABLECOINS.filter((s) => s.flags.governance === "centralized").length} CeFi,
        {" "}{TRACKED_STABLECOINS.filter((s) => s.flags.governance === "centralized-dependent").length} CeFi-Dependent, and {TRACKED_STABLECOINS.filter((s) => s.flags.governance === "decentralized").length} DeFi. Live market caps, peg
        deviation heatmaps, blacklist monitoring, DEX liquidity scores, and a cemetery of
        fallen stablecoins. Updated every 15 minutes.
      </p>
      {dataUpdatedAt > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          Last updated: {new Date(dataUpdatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}
        </p>
      )}
    </div>
  );
}
