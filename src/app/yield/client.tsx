"use client";

import { useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useYieldRankings } from "@/hooks/api-hooks";
import { useLogos } from "@/hooks/use-logos";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { YieldLeaderboard } from "@/components/yield-leaderboard";
import { YieldScatterPlot } from "@/components/yield-scatter-plot";
import { buildStablecoinUrl } from "@/lib/urls";
import { formatPercent } from "@shared/lib/format";
import { dedupeYieldRankings } from "@shared/lib/yield-rankings";

export function YieldClient() {
  const { data, meta, isLoading, error, dataUpdatedAt, refetch } = useYieldRankings();
  const { data: logos } = useLogos();
  const router = useRouter();

  const rankings = useMemo(() => dedupeYieldRankings(data?.rankings ?? []), [data?.rankings]);

  const handleNavigate = useCallback(
    (id: string) => {
      router.push(buildStablecoinUrl(id));
    },
    [router],
  );

  // Compute summary stats from rankings
  const stats = useMemo(() => {
    if (!data) return null;
    const { riskFreeRate } = data;
    if (rankings.length === 0) return { avgApy: 0, riskFreeRate, bestPys: null };

    // Weighted average APY (weighted by TVL where available)
    let tvlSum = 0;
    let weightedApySum = 0;
    let unweightedApySum = 0;
    for (const r of rankings) {
      const tvl = r.sourceTvlUsd ?? 0;
      if (tvl > 0) {
        tvlSum += tvl;
        weightedApySum += r.apy30d * tvl;
      }
      unweightedApySum += r.apy30d;
    }
    const avgApy = tvlSum > 0 ? weightedApySum / tvlSum : unweightedApySum / rankings.length;

    // Best risk-adjusted (highest PYS)
    let bestPys: { name: string; symbol: string; score: number } | null = null;
    for (const r of rankings) {
      if (r.pharosYieldScore !== null && (bestPys === null || r.pharosYieldScore > bestPys.score)) {
        bestPys = { name: r.name, symbol: r.symbol, score: r.pharosYieldScore };
      }
    }

    return { avgApy, riskFreeRate, bestPys };
  }, [data, rankings]);

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

      {data?.provenance ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Card className="rounded-xl">
            <CardHeader className="pb-1">
              <span className="text-xs text-muted-foreground">Benchmark Provenance</span>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p className="font-medium">
                {data.provenance.benchmark.recordDate
                  ? `T-Bill as of ${data.provenance.benchmark.recordDate}`
                  : "T-Bill record date unavailable"}
              </p>
              <p className="text-muted-foreground">
                {data.provenance.benchmark.isFallback
                  ? `Fallback benchmark in use${data.provenance.benchmark.fallbackMode ? ` (${data.provenance.benchmark.fallbackMode})` : ""}`
                  : data.provenance.benchmark.ageSeconds != null
                    ? `Benchmark age ${Math.round(data.provenance.benchmark.ageSeconds / 3600)}h`
                    : "Benchmark age unavailable"}
              </p>
            </CardContent>
          </Card>
          <Card className="rounded-xl">
            <CardHeader className="pb-1">
              <span className="text-xs text-muted-foreground">Yield Input Freshness</span>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p className="font-medium">
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
              <p className="font-medium">
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
              <span className="text-xs text-muted-foreground">Risk-Free Rate (T-Bill)</span>
            </CardHeader>
            <CardContent>
              <span className="text-2xl font-bold font-mono tabular-nums">{formatPercent(stats.riskFreeRate)}</span>
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
      {data && rankings.length > 0 && (
        <section aria-labelledby="scatter-heading">
          <Card className="rounded-2xl border-border/70 bg-card/80">
            <CardHeader className="space-y-4">
              <div className="space-y-2">
                <h2 id="scatter-heading" className="text-xl font-semibold">
                  Yield vs Safety
                </h2>
                <p className="text-sm text-muted-foreground">
                  Each logo marks a stablecoin. Click a point to open the detail page.
                </p>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <div className="rounded-2xl border border-border/60 bg-background/45 px-4 py-3">
                  <p className="pharos-kicker">Below T-Bill</p>
                  <p className="mt-1 text-sm text-foreground">
                    Yields under {formatPercent(data.riskFreeRate)} are failing the basic hurdle rate.
                  </p>
                </div>
                <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/8 px-4 py-3">
                  <p className="pharos-kicker text-emerald-400">Sweet Spot</p>
                  <p className="mt-1 text-sm text-foreground">
                    Right side plus above the T-Bill line is where strong yield meets acceptable safety.
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
                rankings={rankings}
                riskFreeRate={data.riskFreeRate}
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
              rankings={rankings}
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
  );
}
