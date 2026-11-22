"use client";

import { useMemo, useState } from "react";
import { useDexLiquidityTable, usePegSummary, useReportCardsV9Table } from "@/hooks/api-hooks";
import { logosById } from "@/lib/logos";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useCoinStates } from "@/hooks/use-coin-states";
import { FilterSearchInput } from "@/components/filter-search-input";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { StablecoinTable } from "@/components/stablecoin-directory/stablecoin-table";
import { buildTrackedIdSet, filterStablecoins } from "@/components/stablecoin-directory/stablecoin-table-logic";
import { Skeleton } from "@/components/ui/skeleton";
import { buildStablecoinTableInputs } from "@/lib/stablecoin-table-inputs";
import { formatCurrency } from "@shared/lib/format";
import { scoreToGrade } from "@shared/lib/report-card-core";
import { CLIENT_ACTIVE_IDS } from "@shared/lib/stablecoins/client-registry";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import type { FilterTag } from "@shared/types/stablecoin-meta-primitives";
import type { PegRateSource } from "@shared/lib/peg-rates";

// Cohort titles promise "Ranked by Risk", so the embedded table opens in grade
// order (best first); the market-cap directory keeps its own default.
const COHORT_RISK_SORT = { key: "grade", direction: "desc" } as const;

interface StablecoinFilteredTableProps {
  activeFilters: readonly FilterTag[];
  renderNotice?: (context: { pegRateSources: Record<string, PegRateSource> }) => React.ReactNode;
}

function formatSharePct(pct: number): string {
  if (pct > 0 && pct < 0.1) return "<0.1%";
  if (pct > 99.9 && pct < 100) return ">99.9%";
  return `${pct.toFixed(1)}%`;
}

export function StablecoinFilteredTable({ activeFilters, renderNotice }: StablecoinFilteredTableProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const { data, isLoading, dataUpdatedAt, error, refetch, meta } = useStablecoins();
  const logos = logosById;
  const pegSummaryQuery = usePegSummary();
  const liquidityQuery = useDexLiquidityTable();
  const reportCardsQuery = useReportCardsV9Table();
  const pegSummaryData = pegSummaryQuery.data;
  const dexLiquidity = liquidityQuery.data;
  const reportCardsData = reportCardsQuery.data;
  const failedQueries = [pegSummaryQuery, liquidityQuery, reportCardsQuery].filter((query) => query.error);
  const coinStates = useCoinStates().byId;

  const tableInputs = useMemo(
    () =>
      buildStablecoinTableInputs({
        stablecoins: data?.peggedAssets,
        fxFallbackRates: data?.fxFallbackRates,
        pegSummaryCoins: pegSummaryData?.coins,
        reportCardsV9: reportCardsData,
      }),
    [data?.fxFallbackRates, data?.peggedAssets, pegSummaryData?.coins, reportCardsData],
  );

  // Cohort summary stats always come from the full unfiltered cohort (R7 / ADR-34),
  // preserving unavailable values rather than coercing missing supply or grades to zero.
  const cohortSummary = useMemo(() => {
    const assets = data?.peggedAssets;
    if (!assets) return null;

    const cohortIds = buildTrackedIdSet(activeFilters, tableInputs.reportCards);
    const cohortRows = filterStablecoins(assets, cohortIds, "");

    let globalCapUsd = 0;
    let globalObserved = 0;
    let globalTotal = 0;
    for (const asset of assets) {
      if (!CLIENT_ACTIVE_IDS.has(asset.id)) continue;
      globalTotal += 1;
      const cap = getCirculatingRawOrNull(asset);
      if (cap != null) {
        globalObserved += 1;
        globalCapUsd += cap;
      }
    }

    const observedMcaps: Array<{ symbol: string; cap: number }> = [];
    let cohortCapUsd = 0;
    for (const coin of cohortRows) {
      const cap = getCirculatingRawOrNull(coin);
      if (cap != null) {
        cohortCapUsd += cap;
        observedMcaps.push({ symbol: coin.symbol, cap });
      }
    }
    observedMcaps.sort((left, right) => right.cap - left.cap);

    const cohortObservedCount = observedMcaps.length;
    const cohortComplete = cohortObservedCount > 0 && cohortObservedCount === cohortRows.length;
    const globalComplete = globalObserved > 0 && globalObserved === globalTotal;

    const globalSharePct =
      cohortObservedCount > 0 && globalObserved > 0 && globalCapUsd > 0
        ? (cohortCapUsd / globalCapUsd) * 100
        : null;

    const topSlice = observedMcaps.slice(0, 3);
    const top3CapUsd = topSlice.reduce((sum, entry) => sum + entry.cap, 0);
    const top3Pct = cohortObservedCount > 0 && cohortCapUsd > 0 ? (top3CapUsd / cohortCapUsd) * 100 : null;
    const top3Symbols = topSlice.map((entry) => entry.symbol).join(", ");

    const ratedScores = cohortRows
      .map((coin) => {
        const card = tableInputs.reportCards?.[coin.id];
        if (!card || card.grade === "NR" || card.score == null || !Number.isFinite(card.score)) return null;
        return card.score;
      })
      .filter((score): score is number => score !== null)
      .sort((left, right) => left - right);

    let medianGrade: { grade: string; score: number } | null = null;
    if (ratedScores.length > 0) {
      const mid = Math.floor(ratedScores.length / 2);
      const rawMedian =
        ratedScores.length % 2 === 1
          ? ratedScores[mid]
          : (ratedScores[mid - 1] + ratedScores[mid]) / 2;
      const rounded = Math.round(rawMedian);
      medianGrade = { grade: scoreToGrade(rounded), score: rounded };
    }

    return {
      cohortCount: cohortRows.length,
      cohortCapUsd: cohortObservedCount > 0 ? cohortCapUsd : null,
      cohortObservedCount,
      cohortComplete,
      globalSharePct,
      globalComplete,
      medianGrade,
      ratedCount: ratedScores.length,
      top3Pct,
      top3Symbols,
      top3Count: topSlice.length,
    };
  }, [activeFilters, data?.peggedAssets, tableInputs.reportCards]);

  const showSkeleton = isLoading && !cohortSummary;
  const gradesLoading = reportCardsQuery.isLoading && !reportCardsData;

  return (
    <div className="space-y-4">
      <QueryFreshnessNotices
        error={error ?? failedQueries[0]?.error}
        hasData={!!data?.peggedAssets?.length}
        onRetry={() => {
          if (error) void refetch();
          for (const query of failedQueries) void query.refetch();
        }}
        queries={[
          { preset: "stablecoins", dataUpdatedAt, error, hasData: !!data?.peggedAssets?.length, meta },
          { preset: "pegSummary", dataUpdatedAt: pegSummaryQuery.dataUpdatedAt, error: pegSummaryQuery.error, hasData: !!pegSummaryData?.coins?.length, meta: pegSummaryQuery.meta },
          { preset: "dexLiquidity", dataUpdatedAt: liquidityQuery.dataUpdatedAt, error: liquidityQuery.error, hasData: !!dexLiquidity, meta: liquidityQuery.meta },
          { preset: "reportCards", dataUpdatedAt: reportCardsQuery.dataUpdatedAt, error: reportCardsQuery.error, hasData: !!reportCardsData?.cards?.length, meta: reportCardsQuery.meta },
        ]}
      />
      {renderNotice?.({ pegRateSources: tableInputs.pegRateSources })}

      <section aria-label="Cohort summary" className="pharos-card-shell overflow-hidden">
        <dl className="grid grid-cols-2 divide-y divide-border/50 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
          <div className="min-w-0 space-y-1 px-4 py-3.5">
            <dt className="pharos-label">Market Cap</dt>
            <dd className="pharos-numeric text-lg font-semibold leading-tight text-foreground sm:text-xl">
              {showSkeleton ? (
                <Skeleton className="h-6 w-24" />
              ) : cohortSummary?.cohortCapUsd != null ? (
                formatCurrency(cohortSummary.cohortCapUsd)
              ) : (
                "—"
              )}
            </dd>
            <dd className="pharos-meta">
              {showSkeleton
                ? "Loading cohort supply"
                : cohortSummary
                  ? cohortSummary.cohortComplete
                    ? `${cohortSummary.cohortCount} active ${cohortSummary.cohortCount === 1 ? "coin" : "coins"}`
                    : cohortSummary.cohortObservedCount > 0
                      ? `${cohortSummary.cohortObservedCount} of ${cohortSummary.cohortCount} observed`
                      : "Supply unavailable"
                  : "Supply unavailable"}
            </dd>
          </div>

          <div className="min-w-0 space-y-1 border-l border-border/50 px-4 py-3.5 lg:border-l-0">
            <dt className="pharos-label">Global Share</dt>
            <dd className="pharos-numeric text-lg font-semibold leading-tight text-foreground sm:text-xl">
              {showSkeleton ? (
                <Skeleton className="h-6 w-16" />
              ) : cohortSummary?.globalSharePct != null ? (
                formatSharePct(cohortSummary.globalSharePct)
              ) : (
                "—"
              )}
            </dd>
            <dd className="pharos-meta">
              {showSkeleton
                ? "Comparing active total"
                : cohortSummary?.globalSharePct != null
                  ? cohortSummary.cohortComplete && cohortSummary.globalComplete
                    ? "of active market cap"
                    : "of known active cap"
                  : "Share unavailable"}
            </dd>
          </div>

          <div className="min-w-0 space-y-1 px-4 py-3.5">
            <dt className="pharos-label">Median Grade</dt>
            <dd className="pharos-numeric text-lg font-semibold leading-tight text-foreground sm:text-xl">
              {showSkeleton || gradesLoading ? (
                <Skeleton className="h-6 w-20" />
              ) : cohortSummary?.medianGrade ? (
                <>
                  {cohortSummary.medianGrade.grade}{" "}
                  <span className="text-sm font-medium text-muted-foreground">
                    · {cohortSummary.medianGrade.score}
                  </span>
                </>
              ) : (
                "—"
              )}
            </dd>
            <dd className="pharos-meta">
              {showSkeleton || gradesLoading
                ? "Loading safety scores"
                : cohortSummary && reportCardsData
                  ? `${cohortSummary.ratedCount} of ${cohortSummary.cohortCount} rated`
                  : "Grades unavailable"}
            </dd>
          </div>

          <div className="min-w-0 space-y-1 border-l border-border/50 px-4 py-3.5 lg:border-l-0">
            <dt className="pharos-label">Top-3 Concentration</dt>
            <dd className="pharos-numeric text-lg font-semibold leading-tight text-foreground sm:text-xl">
              {showSkeleton ? (
                <Skeleton className="h-6 w-16" />
              ) : cohortSummary?.top3Pct != null ? (
                formatSharePct(cohortSummary.top3Pct)
              ) : (
                "—"
              )}
            </dd>
            <dd className="pharos-meta truncate" title={cohortSummary?.top3Symbols || undefined}>
              {showSkeleton
                ? "Checking largest coins"
                : cohortSummary?.top3Pct != null
                  ? cohortSummary.top3Symbols
                  : "Concentration unavailable"}
            </dd>
          </div>
        </dl>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 bg-muted/20 px-4 py-2.5">
          <FilterSearchInput
            value={searchQuery}
            onValueChange={setSearchQuery}
            placeholder="Filter coins by name or symbol..."
            ariaLabel="Filter coins in this cohort by name or symbol"
            className="relative w-full sm:max-w-xs"
            inputClassName="h-11 bg-card pl-8 text-xs sm:h-8"
          />
          {searchQuery.trim().length > 0 ? (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="pharos-focus-ring min-h-11 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground sm:min-h-8"
            >
              Clear search
            </button>
          ) : null}
        </div>
      </section>

      <StablecoinTable
        data={data?.peggedAssets}
        isLoading={isLoading}
        activeFilters={activeFilters}
        searchQuery={searchQuery}
        onClearSearch={() => setSearchQuery("")}
        unavailable={Boolean(error && !data?.peggedAssets)}
        logos={logos}
        pegScores={tableInputs.pegScores}
        dexLiquidity={dexLiquidity ?? undefined}
        reportCards={tableInputs.reportCards}
        coinStates={coinStates}
        initialSort={COHORT_RISK_SORT}
        reportCardsMethodologyVersion={reportCardsData?.safetyScoreIdentity?.methodologyVersion ?? null}
        sourceGenerations={{
          stablecoins: meta?.updatedAt,
          pegSummary: pegSummaryQuery.meta?.updatedAt,
          dexLiquidity: liquidityQuery.meta?.updatedAt,
          reportCards: reportCardsQuery.meta?.updatedAt,
        }}
      />
    </div>
  );
}
