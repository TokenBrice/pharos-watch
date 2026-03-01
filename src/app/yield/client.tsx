"use client";

import { useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useYieldRankings } from "@/hooks/use-yield-rankings";
import { useLogos } from "@/hooks/use-logos";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { CRON_20MIN } from "@/hooks/use-api-query";
import { YieldLeaderboard } from "@/components/yield-leaderboard";
import { YieldScatterPlot } from "@/components/yield-scatter-plot";

export function YieldClient() {
  const { data, isLoading, isError, error, dataUpdatedAt } = useYieldRankings();
  const { data: logos } = useLogos();
  const router = useRouter();

  const handleNavigate = useCallback(
    (id: string) => {
      router.push(`/stablecoin/${id}`);
    },
    [router],
  );

  // Compute summary stats from rankings
  const stats = useMemo(() => {
    if (!data) return null;
    const { rankings, riskFreeRate } = data;
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
    const avgApy = tvlSum > 0
      ? weightedApySum / tvlSum
      : unweightedApySum / rankings.length;

    // Best risk-adjusted (highest PYS)
    let bestPys: { name: string; symbol: string; score: number } | null = null;
    for (const r of rankings) {
      if (r.pharosYieldScore !== null && (bestPys === null || r.pharosYieldScore > bestPys.score)) {
        bestPys = { name: r.name, symbol: r.symbol, score: r.pharosYieldScore };
      }
    }

    return { avgApy, riskFreeRate, bestPys };
  }, [data]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-3 sm:gap-5 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="rounded-xl">
              <CardHeader className="pb-1"><Skeleton className="h-3 w-24" /></CardHeader>
              <CardContent><Skeleton className="h-8 w-32" /></CardContent>
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
      {/* New feature notice */}
      <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-4 text-sm text-amber-200">
        This is a new feature, data collection and further adjustment work is in
        progress: please be patient.
      </div>

      {isError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load yield data. {error instanceof Error ? error.message : "Please check your connection."}
        </div>
      )}
      {!isError && (
        <StaleDataBanner
          queries={[{ label: "Yield Rankings", dataUpdatedAt, staleTime: CRON_20MIN }]}
        />
      )}

      {/* Summary stat cards */}
      {stats && (
        <div className="grid grid-cols-1 gap-3 sm:gap-5 sm:grid-cols-3">
          <Card className="rounded-xl">
            <CardHeader className="pb-1">
              <span className="text-xs text-muted-foreground">Average Yield (TVL-weighted)</span>
            </CardHeader>
            <CardContent>
              <span className="text-2xl font-bold font-mono tabular-nums">
                {stats.avgApy.toFixed(2)}%
              </span>
            </CardContent>
          </Card>
          <Card className="rounded-xl">
            <CardHeader className="pb-1">
              <span className="text-xs text-muted-foreground">Risk-Free Rate (T-Bill)</span>
            </CardHeader>
            <CardContent>
              <span className="text-2xl font-bold font-mono tabular-nums">
                {stats.riskFreeRate.toFixed(2)}%
              </span>
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
                <span className="text-muted-foreground">--</span>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Scatter plot */}
      {data && data.rankings.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Yield vs Safety</h2>
          <p className="text-sm text-muted-foreground">
            Each dot is a yield-bearing stablecoin. Click to view details.
          </p>
          <YieldScatterPlot
            rankings={data.rankings}
            riskFreeRate={data.riskFreeRate}
            onDotClick={handleNavigate}
          />
        </div>
      )}

      {/* Leaderboard table */}
      {data && (
        <div className="space-y-3">
          <h2 className="text-xl font-semibold">Yield Leaderboard</h2>
          <YieldLeaderboard
            rankings={data.rankings}
            logos={logos}
            onRowClick={handleNavigate}
          />
        </div>
      )}

      {/* Disclaimer */}
      <p className="text-xs text-muted-foreground leading-relaxed">
        The Pharos Yield Score (PYS) is for informational purposes only and does not constitute
        financial advice. APY figures are sourced from DeFiLlama and may fluctuate. Past yields
        do not guarantee future returns. Always do your own research before allocating capital
        to any yield-bearing stablecoin.
      </p>
    </div>
  );
}
