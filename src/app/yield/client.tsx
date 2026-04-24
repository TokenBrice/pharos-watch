"use client";

import { useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useYieldRankings } from "@/hooks/api-hooks";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { useLogos } from "@/hooks/use-logos";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { YieldLeaderboard } from "@/components/yield-leaderboard";
import { YieldScatterPlot } from "@/components/yield-scatter-plot";
import { YieldSourceBoard } from "@/app/yield/source-board";
import { buildYieldSourceBoardModel } from "@/app/yield/source-board-model";
import {
  getYieldBenchmarkDisplayLabel,
  resolveYieldScatterBenchmarkFrame,
} from "@/lib/yield-benchmark";
import { buildStablecoinUrl } from "@/lib/urls";
import { PEG_BADGE_STYLES } from "@shared/lib/classification";
import { formatPercent } from "@shared/lib/format";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { dedupeYieldRankings } from "@shared/lib/yield-rankings";
import type { PegCurrency } from "@shared/types";

type YieldPegFilter = PegCurrency | "all" | "non-usd";

const YIELD_PEG_PRIORITY: readonly PegCurrency[] = [
  "EUR",
  "CHF",
  "GOLD",
  "GBP",
  "JPY",
  "AUD",
  "CAD",
  "BRL",
  "ZAR",
  "CNH",
  "CNY",
  "PHP",
  "TRY",
  "IDR",
  "RUB",
  "UAH",
  "ARS",
  "SILVER",
  "VAR",
  "OTHER",
];

const HIDDEN_INDIVIDUAL_YIELD_PEG_FILTERS = new Set<PegCurrency>(["SGD", "MXN"]);

function getYieldPegLabel(peg: PegCurrency): string {
  return PEG_BADGE_STYLES[peg].label.replace(/\s+Peg$/, "");
}

function getYieldRankingPeg(rankingId: string): PegCurrency | null {
  return TRACKED_META_BY_ID.get(rankingId)?.flags.pegCurrency ?? null;
}

function compareYieldPegs(a: PegCurrency, b: PegCurrency): number {
  const aIndex = YIELD_PEG_PRIORITY.indexOf(a);
  const bIndex = YIELD_PEG_PRIORITY.indexOf(b);

  if (aIndex !== -1 || bIndex !== -1) {
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  }

  return getYieldPegLabel(a).localeCompare(getYieldPegLabel(b));
}

function matchesYieldPegFilter(peg: PegCurrency | null, filter: YieldPegFilter): boolean {
  if (filter === "all") return true;
  if (!peg) return false;
  if (filter === "non-usd") return peg !== "USD";
  return peg === filter;
}

export function YieldClient() {
  const { data, meta, isLoading, error, dataUpdatedAt, refetch } = useYieldRankings();
  const { data: logos } = useLogos();
  const { getParam, setParam } = useUrlFilters();
  const router = useRouter();

  const rankings = useMemo(() => dedupeYieldRankings(data?.rankings ?? []), [data?.rankings]);
  const pegFilterOptions = useMemo(() => {
    const pegs = Array.from(
      new Set(
        rankings
          .map((ranking) => getYieldRankingPeg(ranking.id))
          .filter((peg): peg is PegCurrency => peg != null),
      ),
    ).sort(compareYieldPegs);
    const hasNonUsd = pegs.some((peg) => peg !== "USD");
    const options: Array<{ value: YieldPegFilter; label: string }> = [{ value: "all", label: "All" }];

    if (hasNonUsd) {
      options.push({ value: "non-usd", label: "Non-USD" });
    }
    if (pegs.includes("USD")) {
      options.push({ value: "USD", label: "USD" });
    }

    for (const peg of pegs) {
      if (peg === "USD" || HIDDEN_INDIVIDUAL_YIELD_PEG_FILTERS.has(peg)) continue;
      options.push({ value: peg, label: getYieldPegLabel(peg) });
    }

    return options;
  }, [rankings]);
  const rawPegFilter = getParam("peg", "all");
  const pegFilter = useMemo<YieldPegFilter>(
    () => (pegFilterOptions.some((option) => option.value === rawPegFilter) ? rawPegFilter as YieldPegFilter : "all"),
    [pegFilterOptions, rawPegFilter],
  );
  const filteredRankings = useMemo(
    () => rankings.filter((ranking) => matchesYieldPegFilter(getYieldRankingPeg(ranking.id), pegFilter)),
    [rankings, pegFilter],
  );
  const sourceBoardModel = useMemo(
    () => buildYieldSourceBoardModel(filteredRankings, {
      benchmarks: data?.benchmarks ?? data?.provenance?.benchmarks ?? null,
      fallbackBenchmark: data?.provenance?.benchmark ?? null,
    }),
    [data?.benchmarks, data?.provenance?.benchmark, data?.provenance?.benchmarks, filteredRankings],
  );
  const setPegFilter = useCallback(
    (value: YieldPegFilter) => {
      setParam("peg", value);
    },
    [setParam],
  );

  const handleNavigate = useCallback(
    (id: string) => {
      router.push(buildStablecoinUrl(id));
    },
    [router],
  );

  // Compute summary stats from the active yield universe filter.
  const stats = useMemo(() => {
    if (!data) return null;
    const benchmarkRegistry = data.benchmarks ?? data.provenance?.benchmarks;
    const {
      referenceBenchmark,
      hasMixedBenchmarks,
      usesDefaultBenchmarkFrame,
      sharedBenchmarkKey,
    } = resolveYieldScatterBenchmarkFrame({
      rankings: filteredRankings,
      benchmarks: benchmarkRegistry,
      fallbackBenchmark: data.provenance?.benchmark ?? null,
    });
    if (filteredRankings.length === 0) {
      return {
        avgApy: 0,
        bestPys: null,
        referenceBenchmark,
        hasMixedBenchmarks,
        usesDefaultBenchmarkFrame,
        sharedBenchmarkKey,
      };
    }

    // Weighted average APY (weighted by TVL where available)
    let tvlSum = 0;
    let weightedApySum = 0;
    let unweightedApySum = 0;
    for (const r of filteredRankings) {
      const tvl = r.sourceTvlUsd ?? 0;
      if (tvl > 0) {
        tvlSum += tvl;
        weightedApySum += r.apy30d * tvl;
      }
      unweightedApySum += r.apy30d;
    }
    const avgApy = tvlSum > 0 ? weightedApySum / tvlSum : unweightedApySum / filteredRankings.length;

    // Best risk-adjusted (highest PYS)
    let bestPys: { name: string; symbol: string; score: number } | null = null;
    for (const r of filteredRankings) {
      if (r.pharosYieldScore !== null && (bestPys === null || r.pharosYieldScore > bestPys.score)) {
        bestPys = { name: r.name, symbol: r.symbol, score: r.pharosYieldScore };
      }
    }

    return {
      avgApy,
      bestPys,
      referenceBenchmark,
      hasMixedBenchmarks,
      usesDefaultBenchmarkFrame,
      sharedBenchmarkKey,
    };
  }, [data, filteredRankings]);

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

  if (!stats) {
    return null;
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

      <p className="text-sm text-muted-foreground">
        Latest yield snapshot covers{" "}
        <span className="font-mono font-medium tabular-nums text-foreground">{rankings.length}</span>{" "}
        stablecoins with native yield, lending, or rate-derived opportunities.
      </p>

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

      {pegFilterOptions.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Peg:</span>
          <ToggleGroup
            type="single"
            value={pegFilter}
            onValueChange={(value) => value && setPegFilter(value as YieldPegFilter)}
            className="flex flex-wrap gap-1"
            aria-label="Filter yield rankings by peg currency"
          >
            {pegFilterOptions.map((option) => (
              <ToggleGroupItem
                key={option.value}
                value={option.value}
                variant="outline"
                size="sm"
                className="pharos-toggle-pill min-h-11 px-3 sm:min-h-8 sm:py-1"
              >
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      ) : null}

      {/* Scatter plot with integrated summary stats */}
      {data && filteredRankings.length > 0 && (
        <section aria-labelledby="scatter-heading">
          <Card className="rounded-2xl border-border/70 bg-card/80">
            <CardHeader className="space-y-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-2">
                  <h2 id="scatter-heading" className="text-xl font-semibold">
                    Yield vs Safety
                  </h2>
                  <p className="text-sm text-muted-foreground max-w-prose">
                    {stats?.hasMixedBenchmarks
                      ? "Each logo marks a stablecoin. Mixed views keep the USD frame for orientation, while each row still carries its local benchmark context."
                      : "Each logo marks a stablecoin. Click a point to open the detail page."}
                  </p>
                </div>
                {stats && (
                  <div key={pegFilter} className="flex animate-fade-in flex-wrap items-start gap-x-6 gap-y-2 sm:shrink-0 sm:text-right">
                    {pegFilter !== "all" && (
                      <div className="flex items-center self-center rounded-full border border-border/60 bg-muted/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                        {pegFilter === "non-usd" ? "Non-USD" : pegFilter}
                      </div>
                    )}
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
                    {stats.bestPys && (
                      <div>
                        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Best PYS</p>
                        <p className="text-lg font-bold leading-tight">{stats.bestPys.symbol}</p>
                        <p className="text-[10px] font-mono text-muted-foreground tabular-nums">PYS {stats.bestPys.score.toFixed(1)}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <YieldScatterPlot
                rankings={filteredRankings}
                benchmarkRate={stats.referenceBenchmark?.rate ?? data.riskFreeRate}
                benchmarkLabel={stats.referenceBenchmark?.label}
                benchmarkIsFallback={stats.referenceBenchmark?.isFallback}
                showBenchmarkReference
                usesDefaultBenchmarkFrame={stats.usesDefaultBenchmarkFrame}
                logos={logos}
                onDotClick={handleNavigate}
              />
            </CardContent>
          </Card>
        </section>
      )}

      {/* Leaderboard table */}
      {data && (
        <section aria-labelledby="leaderboard-heading">
          <div className="space-y-3">
            <h2 id="leaderboard-heading" className="text-xl font-semibold">
              Yield Leaderboard
            </h2>
            <YieldLeaderboard
              rankings={filteredRankings}
              logos={logos ?? {}}
              riskFreeRate={data.riskFreeRate}
              medianApy={data.medianApy ?? 0}
            />
          </div>
        </section>
      )}

      {filteredRankings.length > 0 ? <YieldSourceBoard model={sourceBoardModel} /> : null}

      {/* Disclaimer */}
      <p className="text-xs text-muted-foreground leading-relaxed">
        The Pharos Yield Score (PYS) is for informational purposes only and does not constitute financial advice. APY
        figures blend deterministic on-chain, benchmark-derived, DeFiLlama, and price-derived sources with
        confidence-aware arbitration. Past yields do not guarantee future returns.
      </p>
    </div>
  );
}
