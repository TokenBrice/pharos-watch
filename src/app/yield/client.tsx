"use client";

import { useMemo, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
import { buildYieldViewModel, type YieldViewModel } from "@/lib/yield-view-model";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatPercent } from "@shared/lib/format";
import { dedupeYieldRankings } from "@shared/lib/yield-rankings";
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
        <section aria-label="Yield view trust rail" className="order-1 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <div className="rounded-xl border border-border/70 bg-card/80 px-3 py-3">
            <p className="pharos-kicker">Visible Rows</p>
            <p className="font-mono text-xl font-semibold tabular-nums text-foreground">
              {visibleRows.length}
              <span className="text-sm font-normal text-muted-foreground">/{rankings.length}</span>
            </p>
            <p className="text-xs text-muted-foreground">{viewModel.comparisonLabel}</p>
          </div>
          <div className="rounded-xl border border-border/70 bg-card/80 px-3 py-3">
            <p className="pharos-kicker">Avg Yield</p>
            <p className="font-mono text-xl font-semibold tabular-nums text-foreground">{formatPercent(stats.avgApy)}</p>
            <p className="text-xs text-muted-foreground">TVL-weighted when available</p>
          </div>
          <div className="rounded-xl border border-border/70 bg-card/80 px-3 py-3">
            <p className="pharos-kicker">Best PYS</p>
            <p className="text-xl font-semibold text-foreground">
              {stats.bestPys ? stats.bestPys.symbol : "—"}
            </p>
            <p className="font-mono text-xs tabular-nums text-muted-foreground">
              {stats.bestPys ? `PYS ${stats.bestPys.score.toFixed(1)}` : "No scored row"}
            </p>
          </div>
          <div className="rounded-xl border border-border/70 bg-card/80 px-3 py-3">
            <p className="pharos-kicker">Warnings</p>
            <p className="font-mono text-xl font-semibold tabular-nums text-foreground">{stats.warningRowCount}</p>
            <p className="text-xs text-muted-foreground">
              {visibleRows.length > 0 ? `${Math.round((stats.warningRowCount / visibleRows.length) * 100)}% of view` : "No visible rows"}
            </p>
          </div>
          <div className="rounded-xl border border-border/70 bg-card/80 px-3 py-3">
            <p className="pharos-kicker">Safety Coverage</p>
            <p className="font-mono text-xl font-semibold tabular-nums text-foreground">
              {data.provenance ? `${(data.provenance.safetySnapshot.coverageRatio * 100).toFixed(0)}%` : "—"}
            </p>
            <p className="text-xs text-muted-foreground">
              {stats.nullSafetyCount > 0 ? `${stats.nullSafetyCount} visible unscored` : "Visible rows scored"}
            </p>
          </div>
        </section>

        <section className="order-2" aria-label="Yield filters">
          <YieldLeaderboardControls
            viewModel={viewModel}
            onFilterChange={handleFilterChange}
            onClearFilters={handleClearFilters}
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
