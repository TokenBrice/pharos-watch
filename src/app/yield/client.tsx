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
  type YieldPresetKey,
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
      replaceParams((params) => {
        for (const key of Object.keys(viewModel.normalizedParams)) {
          params.delete(key);
        }
        if (viewModel.matchingPreset === presetKey) return;
        for (const [key, value] of Object.entries(spec.overrides)) {
          if (value == null) continue;
          params.set(key, String(value));
        }
      });
    },
    [replaceParams, viewModel.matchingPreset, viewModel.normalizedParams],
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
        <section aria-label="Yield view highlights" className="order-1">
          {storyCallouts === null ? (
            <div className="rounded-xl border border-border/70 bg-card/80 px-4 py-5 text-center text-sm text-muted-foreground">
              No rows match your filters
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {storyCallouts.topYield ? (
                <button
                  type="button"
                  onClick={() => handleScrollToRow(storyCallouts.topYield!.id)}
                  className="group rounded-xl border border-border/70 bg-card/80 px-4 py-4 text-left transition-colors hover:border-border hover:bg-card"
                >
                  <p className="pharos-kicker mb-2">Top yield this week</p>
                  <div className="flex items-center gap-2">
                    <StablecoinLogo src={logos?.[storyCallouts.topYield.id]} name={storyCallouts.topYield.name} size={20} />
                    <span className="font-semibold text-foreground">{storyCallouts.topYield.symbol}</span>
                    <span className="hidden truncate text-xs text-muted-foreground sm:inline">{storyCallouts.topYield.name}</span>
                  </div>
                  <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground">
                    {formatPercent(storyCallouts.topYield.apy30d)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {storyCallouts.topYield.warningSignals.length > 0
                      ? `⚠ ${formatYieldWarningSignal(storyCallouts.topYield.warningSignals[0]!)}`
                      : storyCallouts.topYield.yieldStability !== null && storyCallouts.topYield.yieldStability >= 80
                        ? "Stable 30d range"
                        : "30d avg APY"}
                  </p>
                </button>
              ) : null}
              {storyCallouts.mostStable ? (
                <button
                  type="button"
                  onClick={() => handleScrollToRow(storyCallouts.mostStable!.id)}
                  className="group rounded-xl border border-border/70 bg-card/80 px-4 py-4 text-left transition-colors hover:border-border hover:bg-card"
                >
                  <p className="pharos-kicker mb-2">Most stable A+ yield</p>
                  <div className="flex items-center gap-2">
                    <StablecoinLogo src={logos?.[storyCallouts.mostStable.id]} name={storyCallouts.mostStable.name} size={20} />
                    <span className="font-semibold text-foreground">{storyCallouts.mostStable.symbol}</span>
                    <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">{storyCallouts.mostStable.safetyGrade}</span>
                  </div>
                  <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground">
                    {formatPercent(storyCallouts.mostStable.apy30d)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {storyCallouts.mostStable.yieldStability !== null
                      ? `${Math.round(storyCallouts.mostStable.yieldStability * 100)}% consistency`
                      : "Yield stability unscored"}
                  </p>
                </button>
              ) : null}
              {storyCallouts.largestMarket ? (
                <button
                  type="button"
                  onClick={() => handleScrollToRow(storyCallouts.largestMarket!.id)}
                  className="group rounded-xl border border-border/70 bg-card/80 px-4 py-4 text-left transition-colors hover:border-border hover:bg-card"
                >
                  <p className="pharos-kicker mb-2">Largest market</p>
                  <div className="flex items-center gap-2">
                    <StablecoinLogo src={logos?.[storyCallouts.largestMarket.id]} name={storyCallouts.largestMarket.name} size={20} />
                    <span className="font-semibold text-foreground">{storyCallouts.largestMarket.symbol}</span>
                    <span className="hidden truncate text-xs text-muted-foreground sm:inline">{storyCallouts.largestMarket.name}</span>
                  </div>
                  <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground">
                    {formatCurrency(storyCallouts.largestMarket.sourceTvlUsd!)} TVL
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatPercent(storyCallouts.largestMarket.apy30d)} APY
                  </p>
                </button>
              ) : null}
            </div>
          )}
        </section>

        <section className="order-2" aria-label="Yield filters">
          <YieldLeaderboardControls
            viewModel={viewModel}
            onFilterChange={handleFilterChange}
            onClearFilters={handleClearFilters}
            onApplyPreset={handleApplyPreset}
          />
        </section>

        <section aria-labelledby="leaderboard-heading" className="order-3">
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

        <section className="order-4 space-y-3" aria-label="Yield provenance">
          {viewModel.emptyState.isEmpty ? (
            <div className="rounded-xl border border-border/70 bg-card/80 px-4 py-6 text-center">
              <p className="font-medium text-foreground">{viewModel.emptyState.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{viewModel.emptyState.description}</p>
            </div>
          ) : null}

          {data?.provenance ? (
            <details className="group rounded-xl border border-border/70 bg-card/80 text-sm">
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3 text-xs font-medium text-muted-foreground select-none [&::-webkit-details-marker]:hidden">
                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
                Data Provenance
                <span className="flex w-full flex-wrap items-center justify-end gap-x-3 gap-y-1 font-mono tabular-nums text-foreground sm:ml-auto sm:w-auto sm:flex-nowrap">
                  {Object.values(data.benchmarks ?? data.provenance.benchmarks ?? { USD: data.provenance.benchmark })
                    .filter((b): b is NonNullable<typeof b> => b != null)
                    .map((b) => (
                      <span key={b.key ?? b.label ?? b.currency} className="inline-flex items-center gap-1.5">
                        <span className="text-muted-foreground font-sans">{b.currency ?? "USD"}</span>
                        {formatPercent(b.rate)}
                      </span>
                    ))}
                  <span className="text-muted-foreground font-sans">
                    {(data.provenance.safetySnapshot.coverageRatio * 100).toFixed(0)}% scored
                  </span>
                </span>
              </summary>
              <div className="grid grid-cols-1 gap-4 border-t border-border/50 px-4 py-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <p className="pharos-kicker">Benchmarks</p>
                  {Object.values(data.benchmarks ?? data.provenance.benchmarks ?? { USD: data.provenance.benchmark })
                    .filter((benchmark): benchmark is NonNullable<typeof benchmark> => benchmark != null)
                    .map((benchmark) => (
                      <div key={benchmark.key ?? benchmark.label ?? benchmark.currency} className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-medium text-foreground">{getYieldBenchmarkDisplayLabel(benchmark)}</p>
                          <p className="text-xs text-muted-foreground">
                            {benchmark.recordDate
                              ? `as of ${benchmark.recordDate}`
                              : benchmark.ageSeconds != null
                                ? `age ${Math.round(benchmark.ageSeconds / 3600)}h`
                                : "record date unavailable"}
                          </p>
                        </div>
                        <span className="font-mono tabular-nums text-foreground">{formatPercent(benchmark.rate)}</span>
                      </div>
                    ))}
                </div>
                <div className="space-y-1">
                  <p className="pharos-kicker">Yield Input Freshness</p>
                  <p className="font-medium text-foreground">
                    {data.provenance.dlPools.mode === "dex-cache"
                      ? "DEX-sync cached DeFiLlama pools"
                      : data.provenance.dlPools.mode === "direct-fetch"
                        ? "Direct DeFiLlama pool fetch"
                        : "DeFiLlama pool input unavailable"}
                  </p>
                  <p className="text-muted-foreground">
                    {data.provenance.dlPools.ageSeconds != null
                      ? `Pool input age ${Math.round(data.provenance.dlPools.ageSeconds / 60)}m`
                      : data.provenance.dlPools.fallbackMode
                        ? `Reason: ${data.provenance.dlPools.fallbackMode}`
                        : "Pool input age unavailable"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="pharos-kicker">Safety Coverage</p>
                  <p className="font-medium text-foreground">
                    {(data.provenance.safetySnapshot.coverageRatio * 100).toFixed(0)}% of tracked coins scored
                  </p>
                  <p className="text-muted-foreground">
                    {data.provenance.safetySnapshot.kind === "ok"
                      ? "Confidence-weighted source arbitration active"
                      : data.provenance.safetySnapshot.reason ?? "Safety snapshot degraded"}
                  </p>
                </div>
              </div>
            </details>
          ) : null}
        </section>

        {visibleRows.length > 0 ? (
          <>
            <details className="group order-5 lg:hidden">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl border border-border/70 bg-card/80 px-4 py-3 text-sm font-medium text-foreground select-none [&::-webkit-details-marker]:hidden">
                <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" />
                Yield vs Safety Scatter
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
            <section aria-labelledby="scatter-heading" className="order-5 hidden lg:block">
              <YieldScatterCard
                data={data}
                logos={logos}
                rows={visibleRows}
                stats={stats}
                headingId="scatter-heading"
                onDotClick={handleNavigate}
              />
            </section>
            <section className="order-6" aria-label="Yield sources">
              <YieldSourceBoard model={sourceBoardModel} />
            </section>
          </>
        ) : null}
      </div>

      {/* Disclaimer */}
      <p className="text-xs text-muted-foreground leading-relaxed">
        The Pharos Yield Score (PYS) is for informational purposes only and does not constitute financial advice. APY
        figures blend deterministic on-chain, benchmark-derived, DeFiLlama, and price-derived sources with
        confidence-aware arbitration. Past yields do not guarantee future returns.
      </p>
    </div>
  );
}
