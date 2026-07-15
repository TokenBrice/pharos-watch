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
import { QueryStateNotice } from "@/components/query-state-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ACTIVE_PEGS, pegCoinCount } from "@/lib/peg-landing";
import { CLIENT_ACTIVE_IDS } from "@shared/lib/stablecoins/client-registry";
import {
  CLIENT_ACTIVE_VARIANT_IDS,
  CLIENT_CORE_AGGREGATE_ACTIVE_IDS,
} from "@shared/lib/stablecoins/aggregate-client-registry";
import type { ColumnId } from "@/lib/column-visibility";
import { resolveQueryViewState } from "@/lib/query-view-state";

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
  const stablecoinsQuery = useStablecoins();
  const pegSummaryQuery = usePegSummary();
  const dexLiquidityQuery = useDexLiquidity();
  const reportCardsQuery = useReportCards();
  const stressSignalsQuery = useStressSignals();
  const { data: stablecoinsData, isLoading } = stablecoinsQuery;
  const { data: logos } = useLogos();
  const { data: pegSummaryData } = pegSummaryQuery;
  const { data: dexLiquidity } = dexLiquidityQuery;
  const { data: reportCardsData } = reportCardsQuery;
  const { data: stressData } = stressSignalsQuery;
  const pinned = usePinnedStablecoins();
  const eligibleIds =
    filters.activeUniverse === "core"
      ? CLIENT_CORE_AGGREGATE_ACTIVE_IDS
      : filters.activeUniverse === "variants"
        ? CLIENT_ACTIVE_VARIANT_IDS
        : CLIENT_ACTIVE_IDS;

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
        eligibleIds,
        filters: { activeFilters: filters.activeFilters, searchQuery },
      }),
    [stablecoinsData, pegSummaryData, reportCardMap, eligibleIds, filters.activeFilters, searchQuery],
  );
  const stablecoinsState = resolveQueryViewState({
    hasData: stablecoinsData !== undefined,
    isLoading,
    error: stablecoinsQuery.error,
    isEmpty: stablecoinsData?.peggedAssets.length === 0,
  });
  const failedQueries = [
    { label: "market", query: stablecoinsQuery, hasData: stablecoinsData !== undefined },
    { label: "peg", query: pegSummaryQuery, hasData: pegSummaryData !== undefined },
    { label: "liquidity", query: dexLiquidityQuery, hasData: dexLiquidity !== undefined },
    { label: "safety", query: reportCardsQuery, hasData: reportCardsData !== undefined },
    { label: "stress", query: stressSignalsQuery, hasData: stressData !== undefined },
  ].filter((entry) => entry.query.error != null);
  const failureState = failedQueries.some((entry) => !entry.hasData) ? "unavailable" : "stale-with-data";
  const failureLabel =
    failedQueries.length > 0 ? `${failedQueries.map((entry) => entry.label).join(", ")} ranking data` : "ranking data";
  const failedUpdatedTimes = failedQueries.map((entry) => entry.query.dataUpdatedAt).filter((value) => value > 0);
  const failedDataUpdatedAt = failedUpdatedTimes.length > 0 ? Math.min(...failedUpdatedTimes) : 0;
  const retryFailedQueries = () => {
    for (const entry of failedQueries) void entry.query.refetch();
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <h2 id={titleId} className="pharos-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            Stablecoin Overview
          </h2>
          {stablecoinsState === "unavailable" ? (
            <p className="text-sm text-muted-foreground">Stablecoin rankings are temporarily unavailable.</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Showing <span className="pharos-numeric text-foreground">{filteredRowCount.toLocaleString("en-US")}</span>{" "}
              {filters.activeUniverse === "core"
                ? "core stablecoins and cash equivalents"
                : filters.activeUniverse === "variants"
                  ? "tracked variants, excluded from core market aggregates"
                  : "active catalog listings, with variants tracked separately"}{" "}
              with live market data — inactive lifecycle states excluded,{" "}
              <Link
                href="/screener/"
                className="pharos-focus-ring rounded-sm underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
              >
                see Screener
              </Link>
              .
            </p>
          )}
        </div>
        <ToggleGroup
          type="single"
          value={filters.activeUniverse}
          onValueChange={(value) => {
            if (value === "core" || value === "variants" || value === "catalog") {
              filters.setActiveUniverse(value);
            }
          }}
          variant="outline"
          size="sm"
          aria-label="Select stablecoin listing universe"
        >
          <ToggleGroupItem value="core">Core</ToggleGroupItem>
          <ToggleGroupItem value="variants">Variants</ToggleGroupItem>
          <ToggleGroupItem value="catalog">All</ToggleGroupItem>
        </ToggleGroup>
      </header>
      {failedQueries.length > 0 ? (
        <QueryStateNotice
          state={failureState}
          label={failureLabel}
          dataUpdatedAt={failedDataUpdatedAt}
          onRetry={retryFailedQueries}
        />
      ) : null}
      {stablecoinsState !== "unavailable" ? (
        <StablecoinTable
          data={stablecoinsData?.peggedAssets}
          isLoading={isLoading}
          activeFilters={filters.activeFilters}
          eligibleIds={eligibleIds}
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
      ) : null}
      <PegBrowseStrip pegs={ACTIVE_PEGS} pegCoinCount={pegCoinCount} />
    </div>
  );
}
