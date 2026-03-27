"use client";

import { useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
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
        <div className="grid grid-cols-1 gap-3 sm:gap-5 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
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
        <Skeleton className="h-[350px]" />
        <Skeleton className="h-[400px]" />
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
    <SectionErrorBoundary name="Yield">
    <div className="space-y-6">
      <QueryErrorNotice
        error={error}
        hasData={!!data}
        onRetry={() => {
          void refetch();
        }}
      />
      <StaleDataBanner queries={[{ preset: "yieldRankings", dataUpdatedAt, error, hasData: !!data, meta }]} />

      {data?.provenance ? (
        <div className="grid grid-cols-1 gap-3 sm:gap-5 sm:grid-cols-3">
          <Card className="rounded-xl">
            <CardHeader className="pb-1">
              <span className="text-xs text-muted-foreground">Benchmarks</span>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
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
            </CardContent>
          </Card>
          <Card className="rounded-xl">
            <CardHeader className="pb-1">
              <span className="text-xs text-muted-foreground">Yield Input Freshness</span>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p className="font-medium text-foreground">
                {data.provenance.dlPools.mode === "dex-cache"
                  ? "Using DEX-sync cached DeFiLlama pools"
                  : data.provenance.dlPools.mode === "direct-fetch"
                    ? "Using direct DeFiLlama pool fetch"
                    : "DeFiLlama pool input unavailable"}
              </p>
              <p className="text-muted-foreground">
                {data.provenance.dlPools.ageSeconds != null
                  ? `Pool input age ${Math.round(data.provenance.dlPools.ageSeconds / 60)}m`
                  : data.provenance.dlPools.fallbackMode
                    ? `Reason: ${data.provenance.dlPools.fallbackMode}`
                    : "Pool input age unavailable"}
              </p>
            </CardContent>
          </Card>
          <Card className="rounded-xl">
            <CardHeader className="pb-1">
              <span className="text-xs text-muted-foreground">Safety Coverage</span>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p className="font-medium text-foreground">
                {(data.provenance.safetySnapshot.coverageRatio * 100).toFixed(0)}% of tracked coins scored
              </p>
              <p className="text-muted-foreground">
                {data.provenance.safetySnapshot.kind === "ok"
                  ? "Confidence-weighted source arbitration active"
                  : data.provenance.safetySnapshot.reason ?? "Safety snapshot degraded"}
              </p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {pegFilterOptions.length > 1 ? (
        <Card className="rounded-2xl border-border/70 bg-card/80">
          <CardContent className="flex flex-col gap-3 pt-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1">
              <p className="pharos-kicker">Yield Universe</p>
              <p className="text-sm text-muted-foreground">
                Scope the page by peg target. The `Non-USD` preset groups every live non-dollar yield row, including
                the existing EUR, CHF, SGD, MXN, and commodity coverage.
              </p>
            </div>
            <ToggleGroup
              type="single"
              value={pegFilter}
              onValueChange={(value) => value && setPegFilter(value as YieldPegFilter)}
              className="flex flex-wrap justify-start gap-1"
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
          </CardContent>
        </Card>
      ) : null}

      {/* Summary stat cards */}
      {stats && (
        <div className="grid grid-cols-1 gap-3 sm:gap-5 sm:grid-cols-3">
          <Card className="rounded-xl">
            <CardHeader className="pb-1">
              <span className="text-xs text-muted-foreground">Average Yield (TVL-weighted)</span>
            </CardHeader>
            <CardContent>
              <span className="text-2xl font-bold font-mono tabular-nums">{formatPercent(stats.avgApy)}</span>
            </CardContent>
          </Card>
          <Card className="rounded-xl">
            <CardHeader className="pb-1">
              <span className="text-xs text-muted-foreground">
                {stats.usesDefaultBenchmarkFrame ? "Scatter Frame (USD)" : "Benchmark"}
              </span>
            </CardHeader>
            <CardContent>
              <span className="text-2xl font-bold font-mono tabular-nums">
                {formatPercent(stats.referenceBenchmark?.rate ?? data.riskFreeRate)}
              </span>
              <p className="mt-1 text-xs text-muted-foreground">
                {stats.referenceBenchmark
                  ? getYieldBenchmarkDisplayLabel({
                    benchmarkLabel: stats.referenceBenchmark.label,
                    benchmarkIsFallback: stats.referenceBenchmark.isFallback,
                  })
                  : "USD default"}
              </p>
            </CardContent>
          </Card>
          <Card className="rounded-xl">
            <CardHeader className="pb-1">
              <span className="text-xs text-muted-foreground">Best Risk-Adjusted</span>
            </CardHeader>
            <CardContent>
              {stats.bestPys ? (
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold">{stats.bestPys.symbol}</span>
                  <span className="text-sm font-mono text-muted-foreground tabular-nums">
                    PYS {stats.bestPys.score.toFixed(1)}
                  </span>
                </div>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Scatter plot */}
      {data && filteredRankings.length > 0 && (
        <section aria-labelledby="scatter-heading">
          <Card className="rounded-2xl border-border/70 bg-card/80">
            <CardHeader className="space-y-4">
              <div className="space-y-2">
                <h2 id="scatter-heading" className="text-xl font-semibold">
                  Yield vs Safety
                </h2>
                <p className="text-sm text-muted-foreground">
                  {stats.hasMixedBenchmarks
                    ? "Each logo marks a stablecoin. Mixed views keep the USD frame for orientation, while each row still carries its local benchmark context."
                    : "Each logo marks a stablecoin. Click a point to open the detail page."}
                </p>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <div className="rounded-2xl border border-border/60 bg-background/45 px-4 py-3">
                  <p className="pharos-kicker">{stats.hasMixedBenchmarks ? "Local Benchmarks" : "Below Benchmark"}</p>
                  <p className="mt-1 text-sm text-foreground">
                    {stats.hasMixedBenchmarks
                      ? "Background zones use the USD frame. Row benchmark tags still show whether a coin is being judged against USD T-Bill, EUR 3M compounded €STR, or CHF 3M compounded SARON."
                      : `Yields under ${formatPercent(stats.referenceBenchmark?.rate ?? data.riskFreeRate)} are failing the basic hurdle rate.`}
                  </p>
                </div>
                <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3">
                  <p className="pharos-kicker text-emerald-400">{stats.hasMixedBenchmarks ? "Read The Plot" : "Sweet Spot"}</p>
                  <p className="mt-1 text-sm text-foreground">
                    {stats.hasMixedBenchmarks
                      ? "On mixed views, use the quadrants as a USD orientation frame, then confirm excess yield against each row's benchmark tag."
                      : `Right side plus above the ${getYieldBenchmarkDisplayLabel({
                        benchmarkLabel: stats.referenceBenchmark?.label,
                        benchmarkIsFallback: stats.referenceBenchmark?.isFallback,
                      })} line is where strong yield meets acceptable safety.`}
                  </p>
                </div>
                <div className="rounded-2xl border border-red-500/20 bg-red-500/8 px-4 py-3">
                  <p className="pharos-kicker text-red-400">Danger Zone</p>
                  <p className="mt-1 text-sm text-foreground">
                    High yield on weak safety usually means the risk is doing the heavy lifting.
                  </p>
                </div>
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

      {/* Disclaimer */}
      <p className="text-xs text-muted-foreground leading-relaxed">
        The Pharos Yield Score (PYS) is for informational purposes only and does not constitute financial advice. APY
        figures blend deterministic on-chain, benchmark-derived, DeFiLlama, and price-derived sources with
        confidence-aware arbitration. Past yields do not guarantee future returns.
      </p>
    </div>
    </SectionErrorBoundary>
  );
}
