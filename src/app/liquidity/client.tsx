"use client";

import { useMemo, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDexLiquidity } from "@/hooks/api-hooks";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { FilterSearchInput } from "@/components/filter-search-input";
import { useLogos } from "@/hooks/use-logos";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { LiquidityStats } from "@/components/liquidity-stats";
import { LiquidityTable } from "@/components/liquidity-table";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import type { PegCurrency } from "@shared/types";
import { useUrlSearchSync } from "@/hooks/use-url-search-sync";
import { trackEvent } from "@/lib/analytics";
import { decodeState, encodeState, type UrlStateSchema } from "@/lib/url-state";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { PEG_LABELS_SHORT } from "@shared/lib/classification";
import {
  PEG_FILTERS,
  buildLiquidityViewModel,
  formatLiquidityWarningMessage,
} from "./model";

interface LiquidityUrlState {
  peg: PegCurrency | "all";
}

const LIQUIDITY_PEG_VALUES: readonly (PegCurrency | "all")[] = [
  "all",
  ...(Object.keys(PEG_LABELS_SHORT) as PegCurrency[]),
];

export const LIQUIDITY_URL_SCHEMA: UrlStateSchema<LiquidityUrlState> = {
  peg: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: LIQUIDITY_PEG_VALUES,
  },
};

export function LiquidityClient() {
  const { data: liquidityMap, isLoading, error, dataUpdatedAt, refetch, meta } = useDexLiquidity();
  const { data: logos } = useLogos();
  const { searchParams, replaceParams } = useUrlFilters();
  const { peg: pegFilter } = useMemo(
    () => decodeState(searchParams, LIQUIDITY_URL_SCHEMA),
    [searchParams],
  );
  const setPegFilter = useCallback(
    (v: PegCurrency | "all") => {
      trackEvent("filter_applied", { page: "liquidity", filter_type: "peg", filter_value: v });
      const encoded = encodeState({ peg: v }, LIQUIDITY_URL_SCHEMA);
      replaceParams((params) => {
        params.delete("peg");
        for (const [key, value] of new URLSearchParams(encoded)) params.set(key, value);
      });
    },
    [replaceParams],
  );
  const router = useRouter();

  // Search: local state for instant input, deferred value for filtering,
  // debounced sync to URL + analytics to avoid per-keystroke overhead
  const { searchInput, setSearchInput, deferredSearch } = useUrlSearchSync("liquidity");

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

  const leaderboardToolbar = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <h2 className="pharos-kicker">Liquidity Leaderboard</h2>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter by peg currency" className="flex flex-wrap gap-1.5">
          {PEG_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setPegFilter(f.value)}
              aria-pressed={pegFilter === f.value}
              className={
                pegFilter === f.value
                  ? "pharos-focus-ring pharos-control-pill pharos-control-pill-active min-h-11 md:min-h-9"
                  : "pharos-focus-ring pharos-control-pill min-h-11 md:min-h-9"
              }
            >
              {f.label}
            </button>
          ))}
        </div>
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
  );

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

      {/* Leaderboard workbench: filters live in the table toolbar */}
      <section id="data" aria-label="Data table" tabIndex={-1}>
        <LiquidityTable
          rows={scoredRows}
          logos={logos}
          searchQuery={deferredSearch}
          onRowClick={handleRowClick}
          toolbar={leaderboardToolbar}
        />
      </section>

      {unratedRows.length > 0 && (
        <div className="space-y-3">
          <div className="space-y-1">
            <h2 className="pharos-kicker">Unrated / Not Observed</h2>
            <p className="text-sm text-muted-foreground">
              These assets are tracked, but the current liquidity pipeline has not observed enough DEX coverage to
              assign a Liquidity Score.
            </p>
          </div>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {unratedRows.map((row) => (
              <li key={row.meta.id}>
                <Link
                  href={buildStablecoinUrl(row.meta.id)}
                  className="pharos-focus-ring flex items-center gap-2 rounded-xl border border-border/60 bg-background/60 px-3 py-2 transition hover:border-border hover:bg-muted/40"
                >
                  <StablecoinLogo src={logos?.[row.meta.id]} name={row.meta.name} size={28} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{row.meta.symbol}</span>
                    <span className="block truncate text-xs text-muted-foreground">{row.meta.name}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
