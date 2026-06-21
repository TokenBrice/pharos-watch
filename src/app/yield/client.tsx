"use client";

import { useMemo, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { useYieldRankings } from "@/hooks/api-hooks";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { useLogos } from "@/hooks/use-logos";
import { useWatchlist } from "@/hooks/use-watchlist";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { YieldLeaderboard } from "@/components/yield-leaderboard";
import { YieldLeaderboardControls } from "@/components/yield-leaderboard-controls";
import { YieldRiskBudgetSlider } from "@/components/yield-risk-budget-slider";
import { YieldScatterPlot } from "@/components/yield-scatter-plot";
import { YieldSourceBoard } from "@/app/yield/source-board";
import { buildYieldSourceBoardModel } from "@/app/yield/source-board-model";
import { ReferenceRatesStrip } from "@/app/yield/reference-rates-strip";
import { YieldCoinIndex } from "@/app/yield/coin-index";
import {
  buildYieldViewModel,
  getActiveFilterSummaries,
  YIELD_PRESET_SPECS,
  YIELD_RISK_BUDGET_SPECS,
  type YieldPresetKey,
  type YieldRiskBudgetKey,
  type YieldViewModel,
} from "@/lib/yield-view-model";
import { buildStablecoinUrl } from "@/lib/urls";
import { buildYieldStoryCallouts } from "@/lib/yield-story-callouts";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import { dedupeYieldRankings } from "@shared/lib/yield-rankings";
import { formatYieldWarningSignal } from "@/lib/yield-constants";

export function YieldClient() {
  const { data, meta, isLoading, error, dataUpdatedAt, refetch } = useYieldRankings();
  const { data: logos } = useLogos();
  const { searchParams, setParam, replaceParams } = useUrlFilters();
  const router = useRouter();

  const rankings = useMemo(() => dedupeYieldRankings(data?.rankings ?? []), [data?.rankings]);
  const watchlist = useWatchlist();
  const urlParams = useMemo(
    () => ({
      peg: searchParams.get("peg"),
      yieldType: searchParams.get("yieldType"),
      q: searchParams.get("q"),
      warnings: searchParams.get("warnings"),
      minSafety: searchParams.get("minSafety"),
      minTvl: searchParams.get("minTvl"),
      sourceConfidence: searchParams.get("sourceConfidence"),
      benchmark: searchParams.get("benchmark"),
      opportunity: searchParams.get("opportunity"),
      depth: searchParams.get("depth"),
      sourceChanged: searchParams.get("sourceChanged"),
      sourcePosture: searchParams.get("sourcePosture"),
      trending: searchParams.get("trending"),
      watchlist: searchParams.get("watchlist"),
    }),
    [searchParams],
  );
  const viewModel = useMemo<YieldViewModel>(
    () =>
      buildYieldViewModel(rankings, urlParams, {
        benchmarks: data?.benchmarks ?? data?.provenance?.benchmarks ?? null,
        fallbackBenchmark: data?.provenance?.benchmark ?? null,
        watchlistIds: watchlist.idSet,
      }),
    [data?.benchmarks, data?.provenance?.benchmark, data?.provenance?.benchmarks, rankings, urlParams, watchlist.idSet],
  );
  const visibleRows = viewModel.visibleRows;
  const storyCallouts = useMemo(() => buildYieldStoryCallouts(visibleRows), [visibleRows]);

  const handleScrollToRow = useCallback((id: string) => {
    const el = document.getElementById(`yield-row-${id}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const sourceBoardModel = useMemo(
    () =>
      buildYieldSourceBoardModel(visibleRows, {
        benchmarks: data?.benchmarks ?? data?.provenance?.benchmarks ?? null,
        fallbackBenchmark: data?.provenance?.benchmark ?? null,
      }),
    [data?.benchmarks, data?.provenance?.benchmark, data?.provenance?.benchmarks, visibleRows],
  );

  // Counts the full /yield ranking universe per peg currency (not filter-
  // aware), so the reference-rates table can show how many tracked coins
  // each benchmark currency covers.
  const currencyCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const option of viewModel.options.peg) {
      if (
        option.value === "all" ||
        option.value === "non-usd" ||
        option.value === "aud-cad" ||
        option.value === "other"
      )
        continue;
      counts[option.value] = option.count;
    }
    return counts;
  }, [viewModel.options.peg]);

  useEffect(() => {
    if (viewModel.invalidParamKeys.length === 0) return;
    replaceParams((params) => {
      for (const key of viewModel.invalidParamKeys) {
        const normalizedValue = viewModel.normalizedParams[key];
        if (normalizedValue === null) params.delete(key);
        else params.set(key, normalizedValue);
      }
    });
  }, [replaceParams, viewModel.invalidParamKeys, viewModel.normalizedParams]);

  const handleFilterChange = useCallback(
    (key: string, value: string) => {
      setParam(key, value);
    },
    [setParam],
  );

  const handleClearFilters = useCallback(() => {
    replaceParams((params) => {
      for (const key of Object.keys(viewModel.normalizedParams)) {
        params.delete(key);
      }
    });
  }, [replaceParams, viewModel.normalizedParams]);

  const handleApplyPreset = useCallback(
    (presetKey: YieldPresetKey) => {
      const spec = YIELD_PRESET_SPECS.find((entry) => entry.key === presetKey);
      if (!spec) return;
      // Stackable presets: merge spec.overrides on top of current params.
      // Re-clicking the active preset clears just that preset's keys.
      replaceParams((params) => {
        if (viewModel.matchingPreset === presetKey) {
          for (const key of Object.keys(spec.overrides)) {
            params.delete(key);
          }
          return;
        }
        for (const [key, value] of Object.entries(spec.overrides)) {
          if (value == null) continue;
          params.set(key, String(value));
        }
      });
    },
    [replaceParams, viewModel.matchingPreset],
  );

  const handleApplyRiskBudget = useCallback(
    (key: YieldRiskBudgetKey) => {
      const spec = YIELD_RISK_BUDGET_SPECS.find((entry) => entry.key === key);
      if (!spec) return;
      replaceParams((params) => {
        for (const paramKey of Object.keys(viewModel.normalizedParams)) {
          params.delete(paramKey);
        }
        for (const [paramKey, value] of Object.entries(spec.overrides)) {
          if (value == null) continue;
          params.set(paramKey, String(value));
        }
      });
    },
    [replaceParams, viewModel.normalizedParams],
  );

  const handleNavigate = useCallback(
    (id: string) => {
      router.push(buildStablecoinUrl(id));
    },
    [router],
  );

  const stats = viewModel.stats;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-full rounded-xl" />
        <Skeleton className="h-[500px] w-full rounded-2xl" />
        <Skeleton className="h-[400px] w-full rounded-2xl" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <QueryErrorNotice
          error={error}
          hasData={false}
          onRetry={() => {
            void refetch();
          }}
        />
      </div>
    );
  }

  const exhibitTiles = storyCallouts;

  return (
    <div className="space-y-6">
      <StaleDataBanner queries={[{ preset: "yieldRankings", dataUpdatedAt, error, hasData: !!data, meta }]} />
      {data.warnings && data.warnings.length > 0 ? (
        <section aria-label="Yield API warnings" className="space-y-2">
          {data.warnings.map((warning) => (
            <div
              key={`${warning.code}:${warning.message}`}
              className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-950 dark:text-amber-100"
            >
              <p className="font-medium">{warning.message}</p>
              {warning.reasons && warning.reasons.length > 0 ? (
                <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-100/80">{warning.reasons.join(", ")}</p>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <div className="flex flex-col gap-6">
        <section aria-label="Yield view highlights" className="order-1 space-y-4">
          {exhibitTiles === null ? (
            <div className="rounded-xl border border-border/70 bg-card/80 px-4 py-5 text-center text-sm text-muted-foreground">
              No rows match your filters
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {exhibitTiles.topYield ? (
                <button
                  type="button"
                  onClick={() => handleScrollToRow(exhibitTiles.topYield!.id)}
                  className="group rounded-xl border border-border/70 bg-card/80 px-4 py-4 text-left transition-colors hover:border-border hover:bg-card"
                >
                  <h3 className="mb-2 text-base font-semibold tracking-tight text-foreground">Top yield this week</h3>
                  <div className="flex items-center gap-2">
                    <StablecoinLogo
                      src={logos?.[exhibitTiles.topYield.id]}
                      name={exhibitTiles.topYield.name}
                      size={20}
                    />
                    <span className="font-semibold text-foreground">{exhibitTiles.topYield.symbol}</span>
                    <span className="hidden truncate text-xs text-muted-foreground sm:inline">
                      {exhibitTiles.topYield.name}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground">
                    {formatPercent(exhibitTiles.topYield.apy30d)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {exhibitTiles.topYield.warningSignals.length > 0
                      ? formatYieldWarningSignal(exhibitTiles.topYield.warningSignals[0]!)
                      : exhibitTiles.topYield.yieldStability !== null && exhibitTiles.topYield.yieldStability >= 80
                        ? "Stable 30d range"
                        : "30d avg APY"}
                  </p>
                </button>
              ) : null}
              {exhibitTiles.mostStable ? (
                <button
                  type="button"
                  onClick={() => handleScrollToRow(exhibitTiles.mostStable!.id)}
                  className="group rounded-xl border border-border/70 bg-card/80 px-4 py-4 text-left transition-colors hover:border-border hover:bg-card"
                >
                  <h3 className="mb-2 text-base font-semibold tracking-tight text-foreground">Most stable A+ yield</h3>
                  <div className="flex items-center gap-2">
                    <StablecoinLogo
                      src={logos?.[exhibitTiles.mostStable.id]}
                      name={exhibitTiles.mostStable.name}
                      size={20}
                    />
                    <span className="font-semibold text-foreground">{exhibitTiles.mostStable.symbol}</span>
                    <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                      {exhibitTiles.mostStable.safetyGrade}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground">
                    {formatPercent(exhibitTiles.mostStable.apy30d)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {exhibitTiles.mostStable.yieldStability !== null
                      ? `${Math.round(exhibitTiles.mostStable.yieldStability * 100)}% consistency`
                      : "Yield stability unscored"}
                  </p>
                </button>
              ) : null}
              {exhibitTiles.largestMarket ? (
                <button
                  type="button"
                  onClick={() => handleScrollToRow(exhibitTiles.largestMarket!.id)}
                  className="group rounded-xl border border-border/70 bg-card/80 px-4 py-4 text-left transition-colors hover:border-border hover:bg-card"
                >
                  <h3 className="mb-2 text-base font-semibold tracking-tight text-foreground">Largest market</h3>
                  <div className="flex items-center gap-2">
                    <StablecoinLogo
                      src={logos?.[exhibitTiles.largestMarket.id]}
                      name={exhibitTiles.largestMarket.name}
                      size={20}
                    />
                    <span className="font-semibold text-foreground">{exhibitTiles.largestMarket.symbol}</span>
                    <span className="hidden truncate text-xs text-muted-foreground sm:inline">
                      {exhibitTiles.largestMarket.name}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground">
                    {formatCurrency(exhibitTiles.largestMarket.sourceTvlUsd!)} TVL
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatPercent(exhibitTiles.largestMarket.apy30d)} APY
                  </p>
                </button>
              ) : null}
            </div>
          )}
        </section>

        <section aria-label="Yield vs Safety landscape" className="order-2 space-y-3">
          <YieldRiskBudgetSlider
            stops={viewModel.riskBudget.stops}
            onSelect={handleApplyRiskBudget}
          />
          {visibleRows.length > 0 ? (
            <YieldScatterPlot
              rankings={visibleRows}
              benchmarkRate={stats.referenceBenchmark?.rate ?? data.riskFreeRate}
              benchmarkLabel={stats.referenceBenchmark?.label}
              benchmarkIsFallback={stats.referenceBenchmark?.isFallback}
              showBenchmarkReference
              usesDefaultBenchmarkFrame={stats.usesDefaultBenchmarkFrame}
              logos={logos}
              onDotClick={handleNavigate}
              compact
            />
          ) : null}
        </section>

        <section className="order-3" aria-label="Yield filters">
          <YieldLeaderboardControls
            viewModel={viewModel}
            onFilterChange={handleFilterChange}
            onClearFilters={handleClearFilters}
            onApplyPreset={handleApplyPreset}
          />
        </section>

        <section id="data" tabIndex={-1} aria-labelledby="leaderboard-heading" className="order-4">
          <div className="space-y-3">
            <YieldLeaderboard
              rows={visibleRows}
              logos={logos ?? {}}
              riskFreeRate={data.riskFreeRate}
              medianApy={data.medianApy ?? 0}
              scalingFactor={data.scalingFactor}
              emptyMessage={viewModel.emptyState.description}
              filterSummary={{
                visibleCount: visibleRows.length,
                totalCount: viewModel.totalRows,
                comparisonLabel: viewModel.comparisonLabel,
                activeFilters: getActiveFilterSummaries(viewModel),
              }}
            />
          </div>
        </section>

        <section className="order-5 space-y-6" aria-label="Yield reference rates and sources">
          {viewModel.emptyState.isEmpty ? (
            <div className="rounded-xl border border-border/70 bg-card/80 px-4 py-6 text-center">
              <p className="font-medium text-foreground">{viewModel.emptyState.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{viewModel.emptyState.description}</p>
              {viewModel.emptyState.suggestions.length > 0 ? (
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  {viewModel.emptyState.suggestions.map((suggestion) => (
                    <button
                      key={suggestion.filterKey}
                      type="button"
                      onClick={() => handleFilterChange(suggestion.filterKey, suggestion.targetValue ?? "all")}
                      className="pharos-focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border/70 bg-background/70 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                    >
                      <span>{suggestion.label}</span>
                      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                        +{suggestion.gain}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {visibleRows.length > 0 ? (
            <>
              <ReferenceRatesStrip
                benchmarks={data.benchmarks ?? data.provenance?.benchmarks ?? null}
                fallbackBenchmark={data.provenance?.benchmark ?? null}
                poolInputMeta={data.provenance?.dlPools ?? null}
                safetySnapshot={data.provenance?.safetySnapshot ?? null}
                currencyCounts={currencyCounts}
              />
              <YieldSourceBoard model={sourceBoardModel} />
            </>
          ) : null}
          <YieldCoinIndex />
        </section>
      </div>
    </div>
  );
}
