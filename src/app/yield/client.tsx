"use client";

import { useMemo, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { useYieldRankings } from "@/hooks/api-hooks";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { useLogos } from "@/hooks/use-logos";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { YieldLeaderboard } from "@/components/yield-leaderboard";
import { YieldLeaderboardControls } from "@/components/yield-leaderboard-controls";
import { YieldScatterPlot } from "@/components/yield-scatter-plot";
import { YieldSourceBoard } from "@/app/yield/source-board";
import { buildYieldSourceBoardModel } from "@/app/yield/source-board-model";
import { getYieldBenchmarkDisplayLabel } from "@/lib/yield-benchmark";
import {
  buildYieldViewModel,
  YIELD_PRESET_SPECS,
  YIELD_RISK_BUDGET_SPECS,
  type YieldPresetKey,
  type YieldRiskBudgetKey,
  type YieldViewModel,
} from "@/lib/yield-view-model";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import { dedupeYieldRankings } from "@shared/lib/yield-rankings";
import { formatYieldWarningSignal } from "@/lib/yield-constants";
import type { YieldRankingsResponse } from "@shared/types";

interface YieldScatterCardProps {
  data: YieldRankingsResponse;
  logos: Record<string, string> | undefined;
  rows: YieldViewModel["visibleRows"];
  stats: YieldViewModel["stats"];
  headingId: string;
  onDotClick: (id: string) => void;
}

function YieldScatterCard({ data, logos, rows, stats, headingId, onDotClick }: YieldScatterCardProps) {
  return (
    <Card className="rounded-2xl border-border/70 bg-card/80">
      <CardHeader className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <h2 id={headingId} className="text-xl font-semibold">
              Yield vs Safety
            </h2>
            <p className="text-sm text-muted-foreground max-w-prose">
              {stats.hasMixedBenchmarks
                ? "Each logo marks a stablecoin. Mixed views keep the USD frame for orientation, while each row still carries its local benchmark context."
                : "Each logo marks a stablecoin. Click a point to open the detail page."}
            </p>
          </div>
          <div className="flex animate-fade-in flex-wrap items-start gap-x-6 gap-y-2 sm:shrink-0 sm:text-right">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Avg Yield</p>
              <p className="text-lg font-bold font-mono tabular-nums leading-tight">{formatPercent(stats.avgApy)}</p>
            </div>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {stats.usesDefaultBenchmarkFrame ? "Frame (USD)" : "Benchmark"}
              </p>
              <p className="text-lg font-bold font-mono tabular-nums leading-tight">
                {formatPercent(stats.referenceBenchmark?.rate ?? data.riskFreeRate)}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {stats.referenceBenchmark
                  ? getYieldBenchmarkDisplayLabel({
                    benchmarkLabel: stats.referenceBenchmark.label,
                    benchmarkIsFallback: stats.referenceBenchmark.isFallback,
                  })
                  : "USD default"}
              </p>
            </div>
            {stats.bestPys ? (
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Best PYS</p>
                <p className="text-lg font-bold leading-tight">{stats.bestPys.symbol}</p>
                <p className="text-[10px] font-mono text-muted-foreground tabular-nums">PYS {stats.bestPys.score.toFixed(1)}</p>
              </div>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <YieldScatterPlot
          rankings={rows}
          benchmarkRate={stats.referenceBenchmark?.rate ?? data.riskFreeRate}
          benchmarkLabel={stats.referenceBenchmark?.label}
          benchmarkIsFallback={stats.referenceBenchmark?.isFallback}
          showBenchmarkReference
          usesDefaultBenchmarkFrame={stats.usesDefaultBenchmarkFrame}
          logos={logos}
          onDotClick={onDotClick}
        />
      </CardContent>
    </Card>
  );
}

export function YieldClient() {
  const { data, meta, isLoading, error, dataUpdatedAt, refetch } = useYieldRankings();
  const { data: logos } = useLogos();
  const { searchParams, setParam, replaceParams } = useUrlFilters();
  const router = useRouter();

  const rankings = useMemo(() => dedupeYieldRankings(data?.rankings ?? []), [data?.rankings]);
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
      trending: searchParams.get("trending"),
    }),
    [searchParams],
  );
  const viewModel = useMemo<YieldViewModel>(
    () => buildYieldViewModel(rankings, urlParams, {
      benchmarks: data?.benchmarks ?? data?.provenance?.benchmarks ?? null,
      fallbackBenchmark: data?.provenance?.benchmark ?? null,
    }),
    [data?.benchmarks, data?.provenance?.benchmark, data?.provenance?.benchmarks, rankings, urlParams],
  );
  const visibleRows = viewModel.visibleRows;
  const storyCallouts = useMemo(() => {
    if (visibleRows.length === 0) return null;

    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

    const topYield = [...visibleRows].sort(
      (a, b) => b.apy30d - a.apy30d || byId(a, b),
    )[0] ?? null;

    const stableAplusRows = visibleRows
      .filter((r) => (r.safetyGrade === "A+" || r.safetyGrade === "A") && r.apy30d > 0)
      .sort((a, b) => {
        const sa = a.yieldStability ?? -1;
        const sb = b.yieldStability ?? -1;
        return sb - sa || b.apy30d - a.apy30d || byId(a, b);
      });
    const mostStable = stableAplusRows[0] ?? null;

    const largestMarket = [...visibleRows]
      .filter((r) => (r.sourceTvlUsd ?? 0) > 0)
      .sort((a, b) => (b.sourceTvlUsd ?? 0) - (a.sourceTvlUsd ?? 0) || byId(a, b))[0] ?? null;

    return { topYield, mostStable, largestMarket };
  }, [visibleRows]);

  const handleScrollToRow = useCallback((id: string) => {
    const el = document.getElementById(`yield-row-${id}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const sourceBoardModel = useMemo(
    () => buildYieldSourceBoardModel(visibleRows, {
      benchmarks: data?.benchmarks ?? data?.provenance?.benchmarks ?? null,
      fallbackBenchmark: data?.provenance?.benchmark ?? null,
    }),
    [data?.benchmarks, data?.provenance?.benchmark, data?.provenance?.benchmarks, visibleRows],
  );

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

  const handleFilterChange = useCallback((key: string, value: string) => {
    setParam(key, value);
  }, [setParam]);

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

  const ledeText = useMemo(() => {
    if (visibleRows.length === 0) return "No yield rows match this view.";
    const { ledeFacts, topYield, medianApy } = stats;
    const aGrade = ledeFacts.aGradeAboveBenchmark;
    const benchmarkLabel = ledeFacts.benchmarkLabel ?? "benchmark";
    const lowGradeCount = ledeFacts.doubleDigitInLowGrade;
    if (aGrade !== null && lowGradeCount > 0) {
      return `${aGrade.count} A-grade ${aGrade.count === 1 ? "coin clears" : "coins clear"} the ${benchmarkLabel} by ≥${aGrade.bps}bps; ${lowGradeCount} double-digit APY${lowGradeCount === 1 ? "" : "s"} concentrate in C-or-lower venues.`;
    }
    if (aGrade !== null) {
      return `${aGrade.count} A-grade ${aGrade.count === 1 ? "coin clears" : "coins clear"} the ${benchmarkLabel} by ≥${aGrade.bps}bps.`;
    }
    if (lowGradeCount > 0) {
      return `${lowGradeCount} double-digit APY${lowGradeCount === 1 ? "" : "s"} concentrate in C-or-lower venues.`;
    }
    if (topYield) {
      const grade = topYield.safetyGrade ? ` (${topYield.safetyGrade})` : "";
      return `Top yield ${topYield.symbol} ${formatPercent(topYield.apy)}${grade}; median APY ${formatPercent(medianApy)}.`;
    }
    return "No notable yield highlights in this view.";
  }, [stats, visibleRows.length]);

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
      <SectionErrorBoundary name="Yield">
        <div className="space-y-6">
          <QueryErrorNotice
            error={error}
            hasData={false}
            onRetry={() => {
              void refetch();
            }}
          />
        </div>
      </SectionErrorBoundary>
    );
  }

  const exhibitTiles = storyCallouts;

  return (
    <div className="space-y-6">
      <QueryErrorNotice
        error={error}
        hasData={!!data}
        onRetry={() => {
          void refetch();
        }}
      />
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
                <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-100/80">
                  {warning.reasons.join(", ")}
                </p>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <div className="flex flex-col gap-6">
        <section aria-label="Yield view highlights" className="order-1 space-y-4">
          <p className="text-base leading-relaxed text-foreground">{ledeText}</p>
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
                  <p className="pharos-kicker mb-1">Exhibit 01</p>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">Top yield this week</p>
                  <div className="flex items-center gap-2">
                    <StablecoinLogo src={logos?.[exhibitTiles.topYield.id]} name={exhibitTiles.topYield.name} size={20} />
                    <span className="font-semibold text-foreground">{exhibitTiles.topYield.symbol}</span>
                    <span className="hidden truncate text-xs text-muted-foreground sm:inline">{exhibitTiles.topYield.name}</span>
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
                  <p className="pharos-kicker mb-1">Exhibit 02</p>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">Most stable A+ yield</p>
                  <div className="flex items-center gap-2">
                    <StablecoinLogo src={logos?.[exhibitTiles.mostStable.id]} name={exhibitTiles.mostStable.name} size={20} />
                    <span className="font-semibold text-foreground">{exhibitTiles.mostStable.symbol}</span>
                    <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">{exhibitTiles.mostStable.safetyGrade}</span>
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
                  <p className="pharos-kicker mb-1">Exhibit 03</p>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">Largest market</p>
                  <div className="flex items-center gap-2">
                    <StablecoinLogo src={logos?.[exhibitTiles.largestMarket.id]} name={exhibitTiles.largestMarket.name} size={20} />
                    <span className="font-semibold text-foreground">{exhibitTiles.largestMarket.symbol}</span>
                    <span className="hidden truncate text-xs text-muted-foreground sm:inline">{exhibitTiles.largestMarket.name}</span>
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

        {visibleRows.length > 0 ? (
          <div className="order-2 space-y-3">
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
            <details className="group lg:hidden">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl border border-border/70 bg-card/80 px-4 py-3 text-sm font-medium text-foreground select-none [&::-webkit-details-marker]:hidden">
                <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" />
                Open full chart
              </summary>
              <div className="mt-3">
                <YieldScatterCard
                  data={data}
                  logos={logos}
                  rows={visibleRows}
                  stats={stats}
                  headingId="scatter-heading-mobile"
                  onDotClick={handleNavigate}
                />
              </div>
            </details>
            <section aria-labelledby="scatter-heading" className="hidden lg:block">
              <YieldScatterCard
                data={data}
                logos={logos}
                rows={visibleRows}
                stats={stats}
                headingId="scatter-heading"
                onDotClick={handleNavigate}
              />
            </section>
          </div>
        ) : null}

        <section className="order-3" aria-label="Yield filters">
          <YieldLeaderboardControls
            viewModel={viewModel}
            onFilterChange={handleFilterChange}
            onClearFilters={handleClearFilters}
            onApplyPreset={handleApplyPreset}
            onApplyRiskBudget={handleApplyRiskBudget}
          />
        </section>

        <section aria-labelledby="leaderboard-heading" className="order-4">
          <div className="space-y-3">
            <h2 id="leaderboard-heading" className="text-xl font-semibold">
              Yield Leaderboard
            </h2>
            <YieldLeaderboard
              rows={visibleRows}
              logos={logos ?? {}}
              riskFreeRate={data.riskFreeRate}
              medianApy={data.medianApy ?? 0}
              emptyMessage={viewModel.emptyState.description}
            />
          </div>
        </section>

        <section className="order-5 space-y-3" aria-label="Yield sources">
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
                      onClick={() =>
                        handleFilterChange(suggestion.filterKey, suggestion.targetValue ?? "all")
                      }
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
            <YieldSourceBoard
              model={sourceBoardModel}
              benchmarks={data.benchmarks ?? data.provenance?.benchmarks ?? null}
              poolInputMeta={data.provenance?.dlPools ?? null}
              safetySnapshot={data.provenance?.safetySnapshot ?? null}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
}
