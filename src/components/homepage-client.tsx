"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { usePegSummary } from "@/hooks/use-peg-summary";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { useReportCards } from "@/hooks/use-report-cards";
import { useHomepageFilters } from "@/hooks/use-homepage-filters";
import { MarketHighlights } from "@/components/market-highlights";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { FilterBar } from "@/components/filter-bar";
import { FeatureHighlights } from "@/components/feature-highlights";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { Skeleton } from "@/components/ui/skeleton";
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { PEG_CURRENCY_COUNT } from "@shared/lib/classification";
import { ACTIVE_PEGS, PEG_LABELS_SHORT, PEG_SLUGS, pegCoinCount } from "@/lib/peg-landing";
import { derivePegRates } from "@shared/lib/peg-rates";
import type { PegSummaryCoin } from "@shared/types";

function SectionSkeleton({ className }: { className: string }) {
  return <Skeleton className={className} />;
}

const StablecoinTable = dynamic(() => import("@/components/stablecoin-table").then((mod) => mod.StablecoinTable), {
  loading: () => <SectionSkeleton className="h-[720px] w-full rounded-xl" />,
});

const CategoryStats = dynamic(() => import("@/components/category-stats").then((mod) => mod.CategoryStats), {
  loading: () => <SectionSkeleton className="h-[320px] w-full rounded-xl" />,
});

const TotalMcapChart = dynamic(() => import("@/components/total-mcap-chart").then((mod) => mod.TotalMcapChart), {
  loading: () => <SectionSkeleton className="h-[360px] w-full rounded-xl" />,
});

const PsiHistoryChart = dynamic(() => import("@/components/psi-history-chart").then((mod) => mod.PsiHistoryChart), {
  loading: () => <SectionSkeleton className="h-[360px] w-full rounded-xl" />,
});

const DEWSSummary = dynamic(() => import("@/components/dews-summary").then((mod) => mod.DEWSSummary), {
  loading: () => <SectionSkeleton className="h-[320px] w-full rounded-xl" />,
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
    loading: () => <SectionSkeleton className="h-[360px] w-full rounded-xl" />,
  },
);

const DailyDigest = dynamic(() => import("@/components/daily-digest").then((mod) => mod.DailyDigest), {
  loading: () => <SectionSkeleton className="h-[220px] w-full rounded-xl" />,
});

export function HomepageClient() {
  const { data, isLoading, error: pricesError, dataUpdatedAt, refetch: refetchPrices } = useStablecoins();
  const { data: logos } = useLogos();
  const { data: pegSummaryData, dataUpdatedAt: pegUpdatedAt, error: pegError, refetch: refetchPeg } = usePegSummary();
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
  const { rates: pegRates } = useMemo(
    () => derivePegRates(data?.peggedAssets ?? [], metaById, data?.fxFallbackRates),
    [data, metaById],
  );
  const filters = useHomepageFilters();
  const globalError = pricesError ?? pegError ?? liquidityError ?? reportCardsError;
  const handleRetry = useCallback(() => {
    void Promise.allSettled([refetchPrices(), refetchPeg(), refetchLiquidity(), refetchReportCards()]);
  }, [refetchPeg, refetchLiquidity, refetchPrices, refetchReportCards]);

  return (
    <div className="space-y-6">
      <QueryErrorNotice error={globalError} hasData={!!data?.peggedAssets?.length} onRetry={handleRetry} />
      <StaleDataBanner
        queries={[
          { preset: "stablecoins", dataUpdatedAt, error: pricesError, hasData: !!data?.peggedAssets?.length },
          {
            preset: "pegSummary",
            dataUpdatedAt: pegUpdatedAt,
            error: pegError,
            hasData: !!pegSummaryData?.coins?.length,
          },
          { preset: "dexLiquidity", dataUpdatedAt: liqUpdatedAt, error: liquidityError, hasData: !!dexLiquidity },
          {
            preset: "reportCards",
            dataUpdatedAt: rcUpdatedAt,
            error: reportCardsError,
            hasData: !!reportCardsData?.cards?.length,
          },
        ]}
      />

      <SectionErrorBoundary name="highlights">
        <MarketHighlights data={data?.peggedAssets} logos={logos} pegRates={pegRates} />
      </SectionErrorBoundary>

      <SectionErrorBoundary name="digest">
        <DailyDigest variant="preview" />
      </SectionErrorBoundary>

      <SectionErrorBoundary name="table">
        <section>
          <h2 className="mb-4 text-xl font-semibold tracking-tight text-foreground">Key Stablecoin Data</h2>
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
          <div className="mt-8 space-y-2.5">
            <h2 className="pharos-kicker">Browse By Peg</h2>
            <div className="flex flex-wrap gap-2">
              {ACTIVE_PEGS.map((peg) => {
                const slug = PEG_SLUGS[peg];
                if (!slug) return null;
                return (
                  <Link
                    key={peg}
                    href={`/stablecoins/${slug}/`}
                    className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/70 bg-background/55 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm transition-[background-color,border-color,color,box-shadow] hover:border-border hover:bg-accent/65 hover:text-foreground sm:min-h-0 sm:py-1"
                  >
                    {PEG_LABELS_SHORT[peg]} ({pegCoinCount(peg)})
                  </Link>
                );
              })}
            </div>
          </div>
        </section>
      </SectionErrorBoundary>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SectionErrorBoundary name="dews-radar">
          <section className="flex h-full flex-col space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xl font-semibold tracking-tight">DEWS: Depeg Early Warning System</h2>
              <Link
                href="/depeg/"
                className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground"
              >
                View Depeg Tracker
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            <div className="flex-1">
              <DEWSSummary logos={logos} showHeader={false} className="h-full" />
            </div>
          </section>
        </SectionErrorBoundary>
        <SectionErrorBoundary name="mint-burn-snapshot">
          <HomepageFlowOverview />
        </SectionErrorBoundary>
      </div>

      <SectionErrorBoundary name="charts">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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

      <FeatureHighlights />

      <SectionErrorBoundary name="stats">
        <section>
          <h2 className="text-xl font-semibold tracking-tight mb-4">Stablecoin Distribution</h2>
          <CategoryStats data={data?.peggedAssets} reportCards={reportCardMap} />
        </section>
      </SectionErrorBoundary>

      <SectionErrorBoundary name="marketcap">
        <TotalMcapChart />
      </SectionErrorBoundary>

      <PegDiversityChart />

      <section className="space-y-2 border-t border-border/50 pt-6">
        <p className="mx-auto max-w-5xl text-center text-xs leading-loose text-muted-foreground">
          Pharos tracks {TRACKED_STABLECOINS.length} stablecoins across {PEG_CURRENCY_COUNT} peg currencies (USD, EUR,
          GBP, gold, silver, and more) with honest governance classification:{" "}
          {TRACKED_STABLECOINS.filter((s) => s.flags.governance === "centralized").length} CeFi,{" "}
          {TRACKED_STABLECOINS.filter((s) => s.flags.governance === "centralized-dependent").length} CeFi-Dependent, and{" "}
          {TRACKED_STABLECOINS.filter((s) => s.flags.governance === "decentralized").length} DeFi. Live market caps, peg
          deviation heatmaps, blacklist monitoring, DEX liquidity scores, and a cemetery of fallen stablecoins. Updated
          every 15 minutes.
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
