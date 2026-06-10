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
import { PegBrowseStrip } from "@/components/peg-distribution-grid";
import { Skeleton } from "@/components/ui/skeleton";
import { ACTIVE_PEGS, pegCoinCount } from "@/lib/peg-landing";
import { ALL_COLUMNS, type ColumnId } from "@/lib/column-visibility";

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

interface HomeAltRankingsSectionProps {
  titleId: string;
}

export function HomeAltRankingsSection({
  titleId,
}: HomeAltRankingsSectionProps) {
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
    <>
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
        showHeaderMethodologyHints={false}
        pinnedStablecoinIds={pinned.pinnedIds}
        onTogglePinnedStablecoin={pinned.togglePinned}
        toolbarEyebrow="Stablecoin Overview"
        toolbarDescription={null}
        toolbarTitleId={titleId}
        toolbarMeta={`${filteredRowCount.toLocaleString("en-US")} rows`}
      />
    </>
  );
}
