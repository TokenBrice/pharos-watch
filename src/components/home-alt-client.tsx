"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";

import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import {
  useDexLiquidity,
  usePegSummary,
  useReportCards,
  useStressSignals,
} from "@/hooks/api-hooks";
import { usePinnedStablecoins } from "@/hooks/use-pinned-stablecoins";
import { useHomeAltFilters } from "@/hooks/use-home-alt-filters";
import {
  buildHomepageCriticalViewModel,
  buildHomepageOptionalViewModel,
} from "@/components/homepage-client-view-model";

import { HomeAltHero } from "@/components/home-alt-hero";
import { HomeAltMiniCardGrid } from "@/components/home-alt-mini-card-grid";
import { HomeAltCalloutStrip } from "@/components/home-alt-callout-strip";
import { PegBrowseStrip } from "@/components/peg-distribution-grid";
import { Skeleton } from "@/components/ui/skeleton";
import { ACTIVE_PEGS, pegCoinCount } from "@/lib/peg-landing";

import type { ColumnId } from "@/lib/column-visibility";

const DailyDigest = dynamic(
  () => import("@/components/daily-digest").then((mod) => mod.DailyDigest),
  {
    loading: () => <Skeleton className="h-32 w-full" />,
  },
);

const StablecoinTable = dynamic(
  () => import("@/components/stablecoin-table").then((mod) => mod.StablecoinTable),
  {
    loading: () => (
      <div className="pharos-table-shell">
        <Skeleton className="h-10 w-full" />
        <div className="space-y-2 p-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      </div>
    ),
  },
);

const HOME_ALT_DEFAULT_COLUMNS: readonly ColumnId[] = [
  "rank",
  "name",
  "mcap",
  "change24h",
  "change7d",
  "grade",
  "stability",
  "liquidity",
];

export function HomeAltClient() {
  const filters = useHomeAltFilters();
  const { data: stablecoinsData, isLoading } = useStablecoins();
  const { data: logos } = useLogos();
  const { data: pegSummaryData } = usePegSummary();
  const { data: dexLiquidity } = useDexLiquidity();
  const { data: reportCardsData } = useReportCards();
  const { data: stressData } = useStressSignals();
  const pinned = usePinnedStablecoins();

  const { reportCardMap } = useMemo(
    () => buildHomepageOptionalViewModel({ reportCardsData, stressData }),
    [reportCardsData, stressData],
  );
  const { pegRates, pegScores, filteredRowCount } = useMemo(
    () => buildHomepageCriticalViewModel({
      stablecoinsData,
      pegSummaryData,
      reportCardMap,
      filters: { activeFilters: filters.activeFilters, searchQuery: "" },
    }),
    [stablecoinsData, pegSummaryData, reportCardMap, filters.activeFilters],
  );

  return (
    <div>
      {/* Hero + signal cards read as one composition */}
      <div className="space-y-3">
        <HomeAltHero />
        <HomeAltMiniCardGrid />
      </div>

      {/* Editorial band — single hairline divides it from the dashboard above */}
      <section
        aria-label="Daily digest"
        className="mt-3 pt-2.5 sm:mt-3.5 sm:pt-3"
      >
        <DailyDigest variant="preview" />
      </section>

      <div className="mt-3 sm:mt-3.5">
        <HomeAltCalloutStrip />
      </div>

      <section
        aria-labelledby="home-alt-rankings"
        className="mt-8 space-y-4 sm:mt-10"
      >
        <PegBrowseStrip
          pegs={ACTIVE_PEGS}
          pegCoinCount={pegCoinCount}
          fiatExceptUsdHref="/home-alt/?peg=fiat-non-usd-peg#home-alt-rankings"
        />
        <StablecoinTable
          data={stablecoinsData?.peggedAssets}
          isLoading={isLoading}
          activeFilters={filters.activeFilters}
          logos={logos}
          pegRates={pegRates}
          pegScores={pegScores}
          dexLiquidity={dexLiquidity ?? undefined}
          reportCards={reportCardMap}
          initialVisibleColumns={HOME_ALT_DEFAULT_COLUMNS}
          columnPreferenceNamespace="pharos-home-alt-table"
          suppressDesktopHorizontalScroll
          pinnedStablecoinIds={pinned.pinnedIds}
          onTogglePinnedStablecoin={pinned.togglePinned}
          toolbarEyebrow="Stablecoin Overview"
          toolbarDescription={null}
          toolbarTitleId="home-alt-rankings"
          toolbarMeta={`${filteredRowCount.toLocaleString("en-US")} rows`}
        />
      </section>
    </div>
  );
}
