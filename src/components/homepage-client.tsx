"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, SlidersHorizontal, X } from "lucide-react";
import { useDexLiquidity, usePegSummary, useReportCards, useStressSignals } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { useHomepageFilters, FILTER_GROUPS } from "@/hooks/use-homepage-filters";
import { usePinnedStablecoins } from "@/hooks/use-pinned-stablecoins";
import { useDataAnnounce } from "@/hooks/use-data-announce";
import { DataLiveRegion } from "@/components/data-live-region";
import { MarketHighlights } from "@/components/market-highlights";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import type { StaleQuery } from "@/components/stale-data-banner";
import { FilterBar } from "@/components/filter-bar";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { SectionSkeleton } from "@/components/homepage-skeletons";
import { PegBrowseStrip } from "@/components/peg-distribution-grid";
import { HomepageSectionBand } from "@/components/homepage-sections";
import { HomepageAltPegsTeaser } from "@/components/homepage-alt-pegs-teaser";
import { Button } from "@/components/ui/button";
import { UpcomingStablecoinsSection } from "@/components/upcoming-stablecoins-section";
import { ACTIVE_PEGS, pegCoinCount } from "@/lib/peg-landing";
import {
  buildHomepageCriticalViewModel,
  buildHomepageOptionalViewModel,
} from "@/components/homepage-client-view-model";
import { getHomepageActiveFilterLabel } from "@/lib/homepage-filter-labels";
import { buildAltPegSnapshot } from "@/lib/alt-peg-market";
import { refetchQueryGroup } from "@/lib/query-refetch-group";
import {
  ACTIVE_PEG_CURRENCY_COUNT,
  ACTIVE_STABLECOIN_COUNT,
  ACTIVE_STABLECOIN_GOVERNANCE_COUNTS,
} from "@/lib/stablecoin-static-data";

const CEFI_COUNT = ACTIVE_STABLECOIN_GOVERNANCE_COUNTS.centralized;
const CEFI_DEP_COUNT = ACTIVE_STABLECOIN_GOVERNANCE_COUNTS["centralized-dependent"];
const DEFI_COUNT = ACTIVE_STABLECOIN_GOVERNANCE_COUNTS.decentralized;

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

const DailyDigest = dynamic(() => import("@/components/daily-digest").then((mod) => mod.DailyDigest), {
  loading: () => <SectionSkeleton className="h-[220px] w-full rounded-xl" />,
});

function useDeferredHomepageOptionalQueries(criticalQueriesSettled: boolean) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (enabled || !criticalQueriesSettled) return;

    const timeoutId = window.setTimeout(() => setEnabled(true), 0);
    return () => window.clearTimeout(timeoutId);
  }, [criticalQueriesSettled, enabled]);

  return enabled;
}

export function HomepageClient() {
  const [showFilters, setShowFilters] = useState(false);
  const { data, isLoading, error: pricesError, dataUpdatedAt, refetch: refetchPrices, meta: pricesMeta } = useStablecoins();
  const { data: logos } = useLogos();
  const {
    data: pegSummaryData,
    isLoading: isPegLoading,
    dataUpdatedAt: pegUpdatedAt,
    error: pegError,
    refetch: refetchPeg,
    meta: pegMeta,
  } = usePegSummary();
  const optionalQueriesEnabled = useDeferredHomepageOptionalQueries(!isLoading && !isPegLoading);
  const {
    data: dexLiquidity,
    dataUpdatedAt: liqUpdatedAt,
    error: liquidityError,
    refetch: refetchLiquidity,
    meta: liquidityMeta,
  } = useDexLiquidity({ enabled: optionalQueriesEnabled });
  const {
    data: reportCardsData,
    dataUpdatedAt: rcUpdatedAt,
    error: reportCardsError,
    refetch: refetchReportCards,
    meta: reportCardsMeta,
  } = useReportCards({ enabled: optionalQueriesEnabled });
  const {
    data: stressData,
    dataUpdatedAt: stressUpdatedAt,
    error: stressError,
    refetch: refetchStress,
    meta: stressMeta,
  } = useStressSignals({ enabled: optionalQueriesEnabled });

  const filters = useHomepageFilters();
  const pinnedStablecoins = usePinnedStablecoins();
  const { reportCardMap, dewsRiskLevel } = useMemo(
    () => buildHomepageOptionalViewModel({
      reportCardsData,
      stressData,
    }),
    [reportCardsData, stressData],
  );
  const { filteredRowCount, pegRates, pegScores } = useMemo(
    () => buildHomepageCriticalViewModel({
      stablecoinsData: data,
      pegSummaryData,
      reportCardMap,
      filters: {
        activeFilters: filters.activeFilters,
        searchQuery: filters.searchQuery,
      },
    }),
    [data, filters.activeFilters, filters.searchQuery, pegSummaryData, reportCardMap],
  );
  const altPegSnapshot = useMemo(() => buildAltPegSnapshot(data?.peggedAssets), [data?.peggedAssets]);
  const hasStressSignals = !!stressData?.signals && Object.keys(stressData.signals).length > 0;
  const includeLiquidityFreshness = optionalQueriesEnabled || liqUpdatedAt > 0 || !!dexLiquidity || !!liquidityError;
  const includeReportCardsFreshness = optionalQueriesEnabled || rcUpdatedAt > 0 || !!reportCardsData?.cards?.length || !!reportCardsError;
  const includeStressFreshness = optionalQueriesEnabled || stressUpdatedAt > 0 || hasStressSignals || !!stressError;
  const globalError = pricesError ?? pegError ?? (optionalQueriesEnabled ? liquidityError ?? reportCardsError ?? stressError : null);
  const freshnessQueries = useMemo<StaleQuery[]>(() => {
    const queries: StaleQuery[] = [
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
    ];

    if (includeLiquidityFreshness) {
      queries.push({
        preset: "dexLiquidity",
        dataUpdatedAt: liqUpdatedAt,
        error: liquidityError,
        hasData: !!dexLiquidity,
        meta: liquidityMeta,
      });
    }

    if (includeReportCardsFreshness) {
      queries.push({
        preset: "reportCards",
        dataUpdatedAt: rcUpdatedAt,
        error: reportCardsError,
        hasData: !!reportCardsData?.cards?.length,
        meta: reportCardsMeta,
      });
    }

    if (includeStressFreshness) {
      queries.push({
        preset: "stressSignals",
        dataUpdatedAt: stressUpdatedAt,
        error: stressError,
        hasData: hasStressSignals,
        meta: stressMeta,
      });
    }

    return queries;
  }, [
    data?.peggedAssets?.length,
    dataUpdatedAt,
    dexLiquidity,
    includeLiquidityFreshness,
    includeReportCardsFreshness,
    includeStressFreshness,
    liqUpdatedAt,
    liquidityError,
    liquidityMeta,
    pegError,
    pegMeta,
    pegSummaryData?.coins?.length,
    pegUpdatedAt,
    pricesError,
    pricesMeta,
    rcUpdatedAt,
    reportCardsData?.cards?.length,
    reportCardsError,
    reportCardsMeta,
    hasStressSignals,
    stressError,
    stressMeta,
    stressUpdatedAt,
  ]);
  const handleRetry = useCallback(() => {
    const optionalRefetches = optionalQueriesEnabled ? [refetchLiquidity, refetchReportCards, refetchStress] : [];
    return refetchQueryGroup([refetchPrices, refetchPeg, ...optionalRefetches]);
  }, [optionalQueriesEnabled, refetchPeg, refetchLiquidity, refetchPrices, refetchReportCards, refetchStress]);

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
      <QueryFreshnessNotices
        error={globalError}
        hasData={!!data?.peggedAssets?.length}
        onRetry={handleRetry}
        queries={freshnessQueries}
      />

      <SectionErrorBoundary name="highlights">
        <MarketHighlights data={data?.peggedAssets} logos={logos} pegScores={pegScores} />
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
          <div className="mt-8">
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
                          aria-label={`Remove ${getHomepageActiveFilterLabel(tag)} filter`}
                        >
                          {getHomepageActiveFilterLabel(tag)}
                          <X className="h-3 w-3 text-muted-foreground" aria-hidden />
                        </button>
                      );
                    })}
                    <span className="text-[11px] font-mono tabular-nums text-muted-foreground">{filteredRowCount} rows</span>
                  </>
                ) : (
                  <span className="hidden text-[11px] text-muted-foreground/60 sm:inline">
                    Filter by peg, type, backing, grade, infrastructure, or variant
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
            suppressDesktopHorizontalScroll
            pinnedStablecoinIds={pinnedStablecoins.pinnedIds}
            onTogglePinnedStablecoin={pinnedStablecoins.togglePinned}
            onClearSearch={() => filters.setSearchQuery("")}
            onClearFilters={filters.clearAll}
          />
          </div>
        </section>
      </SectionErrorBoundary>

      <SectionErrorBoundary name="digest">
        <div className="space-y-2">
          <p className="pharos-meta text-muted-foreground/80">
            A short editorial summary Pharos publishes daily on the state of the market.
          </p>
          <DailyDigest variant="preview" />
        </div>
      </SectionErrorBoundary>

      <SectionErrorBoundary name="upcoming-stablecoins">
        <UpcomingStablecoinsSection logos={logos} />
      </SectionErrorBoundary>

      <section
        aria-label="Core monitoring"
        className="space-y-6 -mx-3 px-3 py-6 rounded-2xl sm:-mx-4 sm:px-4"
        style={{ borderTop: '2px solid var(--section-rule)', background: 'var(--surface-zone-monitoring)' }}
      >
        <HomepageSectionBand
          eyebrow="Core Monitoring"
          title="Live system stress and market health"
          description="Depeg risk, flows, safety distribution, and the market-wide stability regime."
        />

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <SectionErrorBoundary name="dews-radar">
            <section aria-label="DEWS depeg early warning" className="flex h-full flex-col space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div role="status" aria-label={`DEWS risk level: ${dewsRiskLevel}`}>
                  <h2 className="text-xl font-semibold tracking-tight">DEWS: Depeg Early Warning System</h2>
                </div>
                <Link
                  href="/depeg/"
                  className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 rounded-sm py-2 text-xs text-muted-foreground hover:text-foreground sm:min-h-0 sm:py-0"
                >
                  View Depeg Tracker
                  <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
              {optionalQueriesEnabled || stressUpdatedAt > 0 || hasStressSignals ? (
                <DEWSSummary logos={logos} showHeader={false} className="flex-1" />
              ) : (
                <ChartSkeleton className="h-[320px] w-full flex-1" type="radar" />
              )}
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
                  className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 rounded-sm py-2 text-xs text-muted-foreground hover:text-foreground sm:min-h-0 sm:py-0"
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
                  className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 rounded-sm py-2 text-xs text-muted-foreground hover:text-foreground sm:min-h-0 sm:py-0"
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
        style={{ borderTop: '2px solid var(--section-rule)', background: 'var(--surface-zone-research)' }}
      >
        <HomepageSectionBand
          eyebrow="Research Surfaces"
          title="Distribution and market structure"
          description="Whole-market concentration plus a dedicated route for non-USD structure."
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

        <SectionErrorBoundary name="alt-pegs">
          <HomepageAltPegsTeaser snapshot={altPegSnapshot} isLoading={isLoading} />
        </SectionErrorBoundary>
      </section>

      <section aria-label="About Pharos" className="space-y-2 border-t border-border/50 pt-6">
        <p className="mx-auto max-w-5xl text-center text-xs leading-relaxed text-muted-foreground">
          Pharos tracks {ACTIVE_STABLECOIN_COUNT} stablecoins across {ACTIVE_PEG_CURRENCY_COUNT} peg currencies with honest
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
