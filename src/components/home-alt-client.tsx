"use client";

import { useEffect, useMemo, useState } from "react";
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
import { useHomepageDiscoverySuggestions } from "@/hooks/use-homepage-discovery";
import {
  buildHomepageCriticalViewModel,
  buildHomepageOptionalViewModel,
} from "@/components/homepage-client-view-model";

import { HomeAltHero } from "@/components/home-alt-hero";
import { HomeAltMiniCardGrid } from "@/components/home-alt-mini-card-grid";
import { HomepageDiscoveryModule } from "@/components/homepage-discovery-module";
import { LazySection } from "@/components/lazy-section";
import { PegBrowseStrip } from "@/components/peg-distribution-grid";
import { Skeleton } from "@/components/ui/skeleton";
import { ACTIVE_PEGS, pegCoinCount } from "@/lib/peg-landing";
import { ALL_COLUMNS, type ColumnId } from "@/lib/column-visibility";

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

const HOME_ALT_DEFAULT_COLUMNS: readonly ColumnId[] = ALL_COLUMNS.map((column) => column.id);
const HOME_ALT_COLUMN_PREFERENCE_NAMESPACE = "pharos-home-alt-table-v2";

/**
 * M14 — force-mount below-fold panels when the URL carries an anchor so the
 * browser can resolve the scroll target. Hash changes during the session
 * don't matter; the lazy gate has long since unmounted by then.
 */
function useHashTargetForceMount() {
  const [forced, setForced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash && window.location.hash !== "#") {
      // One-shot setState that runs only when the URL arrives with a hash.
      // The empty dep array guarantees it never re-fires, so the cascade
      // lint rule is a false positive here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForced(true);
    }
  }, []);
  return forced;
}

function BelowFold({
  forced,
  minHeight,
  children,
}: {
  forced: boolean;
  minHeight: number;
  children: React.ReactNode;
}) {
  if (forced) return <>{children}</>;
  return <LazySection minHeight={minHeight}>{children}</LazySection>;
}

export function HomeAltClient() {
  const filters = useHomeAltFilters();
  const hashTargetForcesMount = useHashTargetForceMount();
  const { data: stablecoinsData, isLoading } = useStablecoins();
  const { data: logos } = useLogos();
  const { data: pegSummaryData } = usePegSummary();
  const { data: dexLiquidity } = useDexLiquidity();
  const { data: reportCardsData } = useReportCards();
  const { data: stressData } = useStressSignals();
  const pinned = usePinnedStablecoins();
  const discoverySuggestions = useHomepageDiscoverySuggestions();

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
      <BelowFold forced={hashTargetForcesMount} minHeight={220}>
        <section
          aria-label="Daily digest"
          className="mt-3 pt-2.5 sm:mt-3.5 sm:pt-3"
        >
          <DailyDigest variant="preview" />
        </section>

        <div className="mt-3 sm:mt-3.5">
          <HomepageDiscoveryModule suggestions={discoverySuggestions} />
        </div>
      </BelowFold>

      <section
        aria-labelledby="home-alt-rankings"
        className="mt-8 space-y-4 sm:mt-10"
      >
        <PegBrowseStrip
          pegs={ACTIVE_PEGS}
          pegCoinCount={pegCoinCount}
          fiatExceptUsdHref="/?peg=fiat-non-usd-peg#home-alt-rankings"
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
          columnPreferenceNamespace={HOME_ALT_COLUMN_PREFERENCE_NAMESPACE}
          suppressDesktopHorizontalScroll
          showHeaderMethodologyHints={false}
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
