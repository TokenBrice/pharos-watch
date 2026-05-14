"use client";

import { useDeferredValue, useEffect, useMemo, useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useDexLiquidity } from "@/hooks/api-hooks";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { FilterSearchInput } from "@/components/filter-search-input";
import { useLogos } from "@/hooks/use-logos";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { LiquidityStats } from "@/components/liquidity-stats";
import { LiquidityTable } from "@/components/liquidity-table";
import type { PegCurrency } from "@shared/types";
import { trackEvent, trackSearch } from "@/lib/analytics";
import { buildStablecoinUrl } from "@/lib/urls";
import {
  PEG_FILTERS,
  buildLiquidityViewModel,
  formatLiquidityWarningMessage,
  normalizePegFilter,
} from "./model";

export function LiquidityClient() {
  const { data: liquidityMap, isLoading, error, dataUpdatedAt, refetch, meta } = useDexLiquidity();
  const { data: logos } = useLogos();
  const { getParam, setParam } = useUrlFilters();
  const rawPeg = getParam("peg", "all");
  const pegFilter = normalizePegFilter(rawPeg);
  const setPegFilter = useCallback(
    (v: PegCurrency | "all") => {
      trackEvent("filter_applied", { page: "liquidity", filter_type: "peg", filter_value: v });
      setParam("peg", v);
    },
    [setParam],
  );
  const router = useRouter();

  // Search: local state for instant input, deferred value for filtering,
  // debounced sync to URL + analytics to avoid per-keystroke overhead
  const [searchInput, setSearchInput] = useState(() => getParam("q"));
  const deferredSearch = useDeferredValue(searchInput);
  const urlSyncTimer = useRef<ReturnType<typeof setTimeout>>(null);
  useEffect(() => {
    if (urlSyncTimer.current) clearTimeout(urlSyncTimer.current);
    urlSyncTimer.current = setTimeout(() => {
      setParam("q", deferredSearch);
      if (deferredSearch) trackSearch("liquidity", deferredSearch.length);
    }, 300);
    return () => {
      if (urlSyncTimer.current) clearTimeout(urlSyncTimer.current);
    };
  }, [deferredSearch, setParam]);

  const { scoredRows, unratedRows, summaryStats } = useMemo(
    () => buildLiquidityViewModel(liquidityMap, pegFilter, deferredSearch),
    [liquidityMap, pegFilter, deferredSearch],
  );

  const handleRowClick = useCallback(
    (id: string) => {
      router.push(buildStablecoinUrl(id));
    },
    [router],
  );
  const handleRetry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const showDataHealthBanner = !meta?.warning;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="rounded-xl">
              <CardHeader className="pb-1">
                <Skeleton className="h-3 w-24" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-32" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Skeleton className="h-[400px]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <QueryFreshnessNotices
        error={error}
        hasData={!!liquidityMap}
        onRetry={handleRetry}
        queries={[{ preset: "dexLiquidity", dataUpdatedAt, error, hasData: !!liquidityMap, meta }]}
        showFreshnessBanner={showDataHealthBanner}
      />
      {meta?.warning && (
        <div
          role="alert"
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300"
        >
          {formatLiquidityWarningMessage(meta.warning)}
        </div>
      )}

      {summaryStats && liquidityMap && <LiquidityStats stats={summaryStats} liquidityMap={liquidityMap} />}

      {/* Filters + Leaderboard */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="pharos-kicker">Liquidity Leaderboard</h2>
          <div className="flex items-center gap-3">
            <ToggleGroup
              type="single"
              value={pegFilter}
              onValueChange={(v) => v && setPegFilter(v as PegCurrency | "all")}
              className="flex gap-1"
              aria-label="Filter by peg currency"
            >
              {PEG_FILTERS.map((f) => (
                <ToggleGroupItem
                  key={f.value}
                  value={f.value}
                  variant="outline"
                  size="sm"
                  className="text-xs min-h-[44px] md:min-h-0"
                >
                  {f.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FilterSearchInput
              value={searchInput}
              onValueChange={setSearchInput}
              placeholder="Search..."
              className="relative w-full sm:w-44"
              inputClassName="pl-8 h-11 md:h-8 text-xs"
              ariaLabel="Search stablecoins by name or symbol"
            />
          </div>
        </div>

        <LiquidityTable rows={scoredRows} logos={logos} searchQuery={deferredSearch} onRowClick={handleRowClick} />
      </div>

      {unratedRows.length > 0 && (
        <div className="space-y-3">
          <div className="space-y-1">
            <h2 className="pharos-kicker">Unrated / Not Observed</h2>
            <p className="text-sm text-muted-foreground">
              These assets are tracked, but the current liquidity pipeline has not observed enough DEX coverage to
              assign a Liquidity Score.
            </p>
          </div>
          <LiquidityTable rows={unratedRows} logos={logos} searchQuery={deferredSearch} onRowClick={handleRowClick} />
        </div>
      )}
    </div>
  );
}
