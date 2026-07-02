"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";

import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { useDexLiquidity, usePegSummary, useReportCards, useStressSignals } from "@/hooks/api-hooks";
import { usePinnedStablecoins } from "@/hooks/use-pinned-stablecoins";
import { useHomeAltFilters } from "@/hooks/use-home-alt-filters";
import {
  buildHomepageCriticalViewModel,
  buildHomepageOptionalViewModel,
} from "@/components/homepage-client-view-model";
import { PegBrowseStrip } from "@/components/peg-distribution-grid";
import { Skeleton } from "@/components/ui/skeleton";
import { ACTIVE_PEGS, pegCoinCount } from "@/lib/peg-landing";
import type { ColumnId } from "@/lib/column-visibility";

const StablecoinTable = dynamic(() => import("@/components/stablecoin-table").then((mod) => mod.StablecoinTable), {
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
});

const HOME_ALT_DEFAULT_COLUMNS: readonly ColumnId[] = [
  "rank",
  "name",
  "price",
  "peg",
  "mcap",
  "change24h",
  "change7d",
  "grade",
  "stability",
  "liquidity",
  "blacklistable",
  "backing",
  "type",
];
const HOME_ALT_COLUMN_PREFERENCE_NAMESPACE = "pharos-home-alt-table-v3";

interface HomeAltRankingsSectionProps {
  titleId: string;
}

export function HomeAltRankingsSection({ titleId }: HomeAltRankingsSectionProps) {
  const filters = useHomeAltFilters();
  const [searchQuery, setSearchQuery] = useState("");
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
    () =>
      buildHomepageCriticalViewModel({
        stablecoinsData,
        pegSummaryData,
        reportCardMap,
        filters: { activeFilters: filters.activeFilters, searchQuery },
      }),
    [stablecoinsData, pegSummaryData, reportCardMap, filters.activeFilters, searchQuery],
  );

  return (
    <div className="space-y-5">
      <header className="space-y-1.5">
        <h2 id={titleId} className="pharos-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          Stablecoin Overview
        </h2>
        <p className="text-sm text-muted-foreground">
          Showing{" "}
          <span className="pharos-numeric text-foreground">{filteredRowCount.toLocaleString("en-US")}</span>{" "}
          active stablecoins with live market data — pre-launch and frozen excluded,{" "}
          <Link
            href="/screener/"
            className="pharos-focus-ring rounded-sm underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
          >
            see Screener
          </Link>
          .
        </p>
      </header>
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
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onClearSearch={() => setSearchQuery("")}
        toolbarEyebrow=""
        toolbarDescription={null}
        toolbarVariant="figmaOverview"
      />
      <PegBrowseStrip pegs={ACTIVE_PEGS} pegCoinCount={pegCoinCount} />
    </div>
  );
}
