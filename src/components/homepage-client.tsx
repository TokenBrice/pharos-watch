"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, SlidersHorizontal, X } from "lucide-react";
import { useDexLiquidity, usePegSummary, useReportCards, useStressSignals } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { useHomepageFilters, FILTER_GROUPS } from "@/hooks/use-homepage-filters";
import { useStartHereCallout } from "@/hooks/use-start-here-callout";
import { useDataAnnounce } from "@/hooks/use-data-announce";
import { DataLiveRegion } from "@/components/data-live-region";
import { MarketHighlights } from "@/components/market-highlights";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { FilterBar } from "@/components/filter-bar";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { SectionSkeleton, ChartSkeleton } from "@/components/homepage-skeletons";
import { PegBrowseStrip } from "@/components/peg-distribution-grid";
import { StartHereCallout, HomepageSectionBand } from "@/components/homepage-sections";
import { Button } from "@/components/ui/button";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { UpcomingStablecoinsSection } from "@/components/upcoming-stablecoins-section";
import { PEG_CURRENCY_COUNT } from "@shared/lib/classification";
import { ACTIVE_PEGS, pegCoinCount } from "@/lib/peg-landing";
import { FILTER_TAG_LABELS } from "@shared/types";
import { buildHomepageViewModel } from "@/components/homepage-client-view-model";

const CEFI_COUNT = ACTIVE_STABLECOINS.filter((s) => s.flags.governance === "centralized").length;
const CEFI_DEP_COUNT = ACTIVE_STABLECOINS.filter((s) => s.flags.governance === "centralized-dependent").length;
const DEFI_COUNT = ACTIVE_STABLECOINS.filter((s) => s.flags.governance === "decentralized").length;

const StablecoinTable = dynamic(() => import("@/components/stablecoin-table").then((mod) => mod.StablecoinTable), {
  loading: () => <SectionSkeleton className="h-[720px] w-full rounded-xl" />,
});

const CategoryStats = dynamic(() => import("@/components/category-stats").then((mod) => mod.CategoryStats), {
  loading: () => <SectionSkeleton className="h-[320px] w-full rounded-xl" />,
});

const TotalMcapChart = dynamic(() => import("@/components/total-mcap-chart").then((mod) => mod.TotalMcapChart), {
  loading: () => <ChartSkeleton className="h-[360px] w-full" type="area" />,
});

const PsiHistoryChart = dynamic(() => import("@/components/psi-history-chart").then((mod) => mod.PsiHistoryChart), {
  loading: () => <ChartSkeleton className="h-[360px] w-full" type="area" />,
});

const DEWSSummary = dynamic(() => import("@/components/dews-summary").then((mod) => mod.DEWSSummary), {
  loading: () => <ChartSkeleton className="h-[320px] w-full" type="radar" />,
});

const HomepageFlowOverview = dynamic(
  () => import("@/components/homepage-flow-overview").then((mod) => mod.HomepageFlowOverview),
  {
    loading: () => <SectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const HomepageSafetyOverview = dynamic(
  () => import("@/components/homepage-safety-overview").then((mod) => mod.HomepageSafetyOverview),
  {
    loading: () => <SectionSkeleton className="h-[320px] w-full rounded-xl" />,
  },
);

const PegDiversityChart = dynamic(
  () => import("@/components/peg-diversity-chart").then((mod) => mod.PegDiversityChart),
  {
    loading: () => <ChartSkeleton className="h-[360px] w-full" type="bar" />,
  },
);

const NonUsdShareChart = dynamic(
  () => import("@/components/non-usd-share-chart").then((mod) => mod.NonUsdShareChart),
  {
    loading: () => <ChartSkeleton className="h-[360px] w-full" type="area" />,
  },
);

const DailyDigest = dynamic(() => import("@/components/daily-digest").then((mod) => mod.DailyDigest), {
  loading: () => <SectionSkeleton className="h-[220px] w-full rounded-xl" />,
});

export function HomepageClient() {
  const { isReady: startHereReady, shouldShow: shouldShowStartHereCallout, retireCallout } = useStartHereCallout();
  const [showFilters, setShowFilters] = useState(false);
  const { data, isLoading, error: pricesError, dataUpdatedAt, refetch: refetchPrices, meta: pricesMeta } = useStablecoins();
  const { data: logos } = useLogos();
  const { data: pegSummaryData, dataUpdatedAt: pegUpdatedAt, error: pegError, refetch: refetchPeg, meta: pegMeta } = usePegSummary();
  const {
    data: dexLiquidity,
    dataUpdatedAt: liqUpdatedAt,
    error: liquidityError,
    refetch: refetchLiquidity,
    meta: liquidityMeta,
  } = useDexLiquidity();
  const {
    data: reportCardsData,
    dataUpdatedAt: rcUpdatedAt,
    error: reportCardsError,
    refetch: refetchReportCards,
    meta: reportCardsMeta,
  } = useReportCards();
  const { data: stressData } = useStressSignals();

  const filters = useHomepageFilters();
  const { dewsRiskLevel, filteredRowCount, pegRates, pegScores, reportCardMap } = useMemo(
    () => buildHomepageViewModel({
      stablecoinsData: data,
      pegSummaryData,
      reportCardsData,
      stressData,
      dexLiquidity,
      filters: {
        activeFilters: filters.activeFilters,
        searchQuery: filters.searchQuery,
      },
    }),
    [data, dexLiquidity, filters.activeFilters, filters.searchQuery, pegSummaryData, reportCardsData, stressData],
  );
  const globalError = pricesError ?? pegError ?? liquidityError ?? reportCardsError;
  const handleRetry = useCallback(() => {
    void Promise.allSettled([refetchPrices(), refetchPeg(), refetchLiquidity(), refetchReportCards()]);
  }, [refetchPeg, refetchLiquidity, refetchPrices, refetchReportCards]);

  // Announce data updates to screen readers
  useDataAnnounce([
    { dataUpdatedAt, dataName: "Market data" },
    { dataUpdatedAt: pegUpdatedAt, dataName: "Peg summary" },
    { dataUpdatedAt: liqUpdatedAt, dataName: "Liquidity" },
    { dataUpdatedAt: rcUpdatedAt, dataName: "Report cards" },
  ]);

  return (
    <div className="space-y-6">
      <DataLiveRegion />
      <QueryErrorNotice error={globalError} hasData={!!data?.peggedAssets?.length} onRetry={handleRetry} />
      <StaleDataBanner
        queries={[
          {
            preset: "stablecoins",
            dataUpdatedAt,
            error: pricesError,
            hasData: !!data?.peggedAssets?.length,
            meta: pricesMeta,
          },
          {
            preset: "pegSummary",
            dataUpdatedAt: pegUpdatedAt,
            error: pegError,
            hasData: !!pegSummaryData?.coins?.length,
            meta: pegMeta,
          },
          {
            preset: "dexLiquidity",
            dataUpdatedAt: liqUpdatedAt,
            error: liquidityError,
            hasData: !!dexLiquidity,
            meta: liquidityMeta,
          },
          {
            preset: "reportCards",
            dataUpdatedAt: rcUpdatedAt,
            error: reportCardsError,
            hasData: !!reportCardsData?.cards?.length,
            meta: reportCardsMeta,
          },
        ]}
      />

      {startHereReady && shouldShowStartHereCallout ? <StartHereCallout onOpenStartHere={retireCallout} /> : null}

      <SectionErrorBoundary name="highlights">
        <MarketHighlights data={data?.peggedAssets} logos={logos} pegRates={pegRates} />
      </SectionErrorBoundary>

      <SectionErrorBoundary name="table">
        <section aria-label="Tracked stablecoin universe">
          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <HomepageSectionBand
              eyebrow="Tracked Universe"
              title="Key Stablecoin Data"
              description="Filter and sort across all tracked stablecoins."
            />
            {/* Active filter chips now shown inline in the table toolbar */}
          </div>
          <PegBrowseStrip pegs={ACTIVE_PEGS} pegCoinCount={pegCoinCount} />
          <div className="mt-4">
          <StablecoinTable
            data={data?.peggedAssets}
            isLoading={isLoading}
            activeFilters={filters.activeFilters}
            toolbarActions={
              <>
                {filters.activeFilters.length > 0 ? (
                  <>
                    {filters.activeFilters.map((tag) => {
                      const group = FILTER_GROUPS.find((g) => g.options.includes(tag));
                      return (
                        <button
                          key={tag}
                          onClick={() => group && filters.handleGroupChange(group.label, "all")}
                          className="pharos-focus-ring inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-primary/20"
                          aria-label={`Remove ${FILTER_TAG_LABELS[tag]} filter`}
                        >
                          {FILTER_TAG_LABELS[tag]}
                          <X className="h-3 w-3 text-muted-foreground" aria-hidden />
                        </button>
                      );
                    })}
                    <span className="text-[11px] font-mono tabular-nums text-muted-foreground">{filteredRowCount} rows</span>
                  </>
                ) : (
                  <span className="hidden text-[11px] text-muted-foreground/60 sm:inline">
                    Filter by peg, backing, governance, grade
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowFilters((prev) => !prev)}
                  className="gap-1.5 text-xs text-muted-foreground"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  {showFilters ? "Hide" : "Filters"}
                  {filters.hasFilters && (
                    <span className="inline-flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                      {filters.activeFilters.length}
                    </span>
                  )}
                </Button>
              </>
            }
            filterPanel={showFilters ? <FilterBar {...filters} /> : null}
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

      <SectionErrorBoundary name="digest">
        <DailyDigest variant="preview" />
      </SectionErrorBoundary>

      <SectionErrorBoundary name="upcoming-stablecoins">
        <UpcomingStablecoinsSection logos={logos} />
      </SectionErrorBoundary>

      <section
        aria-label="Core monitoring"
        className="space-y-6 -mx-3 px-3 py-6 rounded-2xl sm:-mx-4 sm:px-4"
        style={{ borderTop: '2px solid var(--zone-divider)', background: 'var(--surface-zone-monitoring)' }}
      >
        <HomepageSectionBand
          eyebrow="Core Monitoring"
          title="Live system stress and market health"
          description="Depeg risk, flows, safety distribution, and the market-wide stability regime."
        />

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2 xl:items-start">
          <SectionErrorBoundary name="dews-radar">
            <section aria-label="DEWS depeg early warning" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div role="status" aria-label={`DEWS risk level: ${dewsRiskLevel}`} className={`border-l-4 pl-3 transition-colors duration-300 ${
                  dewsRiskLevel === "danger"
                    ? "border-l-red-500"
                    : dewsRiskLevel === "warning"
                      ? "border-l-amber-500"
                      : dewsRiskLevel === "alert"
                        ? "border-l-orange-500"
                        : "border-l-transparent"
                }`}>
                  <h2 className="text-xl font-semibold tracking-tight">DEWS: Depeg Early Warning System</h2>
                </div>
                <Link
                  href="/depeg/"
                  className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground"
                >
                  View Depeg Tracker
                  <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
              <DEWSSummary logos={logos} showHeader={false} />
            </section>
          </SectionErrorBoundary>
          <SectionErrorBoundary name="mint-burn-snapshot">
            <HomepageFlowOverview />
          </SectionErrorBoundary>
        </div>

        <SectionErrorBoundary name="charts">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <section className="flex h-full flex-col space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xl font-semibold tracking-tight">Safety Scores Overview</h2>
                <Link
                  href="/safety-scores/"
                  className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground"
                >
                  View Safety Scores
                  <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
              <HomepageSafetyOverview
                cards={reportCardsData?.cards}
                peggedAssets={data?.peggedAssets}
                className="h-full"
              />
            </section>
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xl font-semibold tracking-tight">Pharos Stability Index History</h2>
                <Link
                  href="/stability-index/"
                  className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground"
                >
                  More Information on PSI
                  <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
              <PsiHistoryChart excludeEvents={["Tether DOJ Probe", "IRON Finance"]} showHeader={false} />
            </section>
          </div>
        </SectionErrorBoundary>
      </section>

      <section
        aria-label="Research surfaces"
        className="space-y-6 -mx-3 px-3 py-6 rounded-2xl sm:-mx-4 sm:px-4"
        style={{ borderTop: '2px solid var(--zone-divider)', background: 'var(--surface-zone-research)' }}
      >
        <HomepageSectionBand
          eyebrow="Research Surfaces"
          title="Distribution and market structure"
          description="Cohort mix, total market-cap regime changes, and non-USD peg growth."
        />

        <SectionErrorBoundary name="stats">
          <section>
            <h2 className="mb-4 text-xl font-semibold tracking-tight">Stablecoin Market Structure</h2>
            <CategoryStats data={data?.peggedAssets} reportCards={reportCardMap} />
          </section>
        </SectionErrorBoundary>

        <SectionErrorBoundary name="marketcap">
          <TotalMcapChart />
        </SectionErrorBoundary>

        <SectionErrorBoundary name="peg-diversity">
          <PegDiversityChart />
        </SectionErrorBoundary>

        <SectionErrorBoundary name="non-usd-share">
          <NonUsdShareChart />
        </SectionErrorBoundary>
      </section>

      <section aria-label="About Pharos" className="space-y-2 border-t border-border/50 pt-6">
        <p className="mx-auto max-w-5xl text-center text-xs leading-relaxed text-muted-foreground">
          Pharos tracks {ACTIVE_STABLECOINS.length} stablecoins across {PEG_CURRENCY_COUNT} peg currencies with honest
          governance classification:{" "}
          {CEFI_COUNT} CeFi, {CEFI_DEP_COUNT} CeFi-Dependent, and {DEFI_COUNT} DeFi. Use the dashboard
          for live market ranking, then drill into peg stress, safety, liquidity, blacklist risk, flows, and dead-coin
          history on the specialist routes. Core market data refreshes every 15 minutes; slower diagnostics run on
          their own cadences.
        </p>
        {dataUpdatedAt > 0 && (
          <p className="text-center text-xs text-muted-foreground">
            Last updated:{" "}
            {new Date(dataUpdatedAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              timeZoneName: "short",
            })}
          </p>
        )}
      </section>
    </div>
  );
}
