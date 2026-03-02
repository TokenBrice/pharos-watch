"use client";

import { useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { CRON_30MIN } from "@/hooks/use-api-query";
import { useLogos } from "@/hooks/use-logos";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { LiquidityStats } from "@/components/liquidity-stats";
import { LiquidityTable } from "@/components/liquidity-table";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import type { LiquidityRow } from "@/components/liquidity-table";
import type { LiquidityStatsData } from "@/components/liquidity-stats";
import type { PegCurrency } from "@/lib/types";
import { DEX_GLOBAL_KEY } from "@/lib/types";
import { trackEvent, trackSearch } from "@/lib/analytics";

const PEG_FILTERS: { value: PegCurrency | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "USD", label: "USD" },
  { value: "EUR", label: "EUR" },
  { value: "GOLD", label: "Gold" },
];

export function LiquidityClient() {
  const { data: liquidityMap, isLoading, isError, error, dataUpdatedAt } = useDexLiquidity();
  const { data: logos } = useLogos();
  const { getParam, setParam } = useUrlFilters();
  const pegFilter = (getParam("peg", "all")) as PegCurrency | "all";
  const searchQuery = getParam("q");
  const setPegFilter = useCallback((v: PegCurrency | "all") => { trackEvent("filter_applied", { page: "liquidity", filter_type: "peg", filter_value: v }); setParam("peg", v); }, [setParam]);
  const setSearchQuery = useCallback((v: string) => { trackSearch("liquidity", v.length); setParam("q", v); }, [setParam]);
  const router = useRouter();

  // Combine tracked stablecoins with liquidity data, applying filters
  const rows = useMemo((): LiquidityRow[] => {
    if (!liquidityMap) return [];
    const q = searchQuery.toLowerCase().trim();
    return TRACKED_STABLECOINS
      .filter((meta) => {
        if (pegFilter !== "all" && meta.flags.pegCurrency !== pegFilter) return false;
        if (q && !meta.name.toLowerCase().includes(q) && !meta.symbol.toLowerCase().includes(q)) return false;
        return true;
      })
      .map((meta) => ({
        meta,
        liq: liquidityMap[meta.id],
      }))
      .filter((r): r is LiquidityRow => r.liq != null && (r.liq.liquidityScore ?? 0) > 0);
  }, [liquidityMap, pegFilter, searchQuery]);

  // Summary stats computed from full (unfiltered) data
  const summaryStats = useMemo((): LiquidityStatsData | null => {
    if (!liquidityMap) return null;
    // Use global deduped row for TVL/vol (avoids double-counting multi-stablecoin pools)
    const globalData = liquidityMap[DEX_GLOBAL_KEY];
    const totalTvl = globalData?.totalTvlUsd ?? 0;
    const totalVol = globalData?.totalVolume24hUsd ?? 0;
    let scoreSum = 0;
    let scoreCount = 0;
    let withLiquidity = 0;
    let tvlForChange = 0;    // current TVL only for coins with 7d change data
    let totalPrevTvl = 0;    // previous TVL for those same coins
    let totalBalance = 0;
    let balanceWeight = 0;
    let totalOrganic = 0;
    let organicWeight = 0;

    for (const meta of TRACKED_STABLECOINS) {
      const liq = liquidityMap[meta.id];
      if (!liq) continue;
      if (liq.liquidityScore != null && liq.liquidityScore > 0) {
        scoreSum += liq.liquidityScore;
        scoreCount++;
        withLiquidity++;
      }
      if (liq.tvlChange7d != null && liq.totalTvlUsd > 0) {
        const prevTvl = liq.totalTvlUsd / (1 + liq.tvlChange7d / 100);
        tvlForChange += liq.totalTvlUsd;
        totalPrevTvl += prevTvl;
      }
      if (liq.weightedBalanceRatio != null) {
        totalBalance += liq.weightedBalanceRatio * liq.totalTvlUsd;
        balanceWeight += liq.totalTvlUsd;
      }
      if (liq.organicFraction != null) {
        totalOrganic += liq.organicFraction * liq.totalTvlUsd;
        organicWeight += liq.totalTvlUsd;
      }
    }

    // Compute aggregate 7d change using matched totals (only coins with 7d data)
    const agg7dChange = totalPrevTvl > 0 ? ((tvlForChange - totalPrevTvl) / totalPrevTvl) * 100 : null;

    return {
      totalTvl,
      totalVol,
      avgScore: scoreCount > 0 ? Math.round(scoreSum / scoreCount) : 0,
      withLiquidity,
      totalTracked: TRACKED_STABLECOINS.length,
      agg7dChange: agg7dChange != null ? Math.round(agg7dChange * 10) / 10 : null,
      avgBalance: balanceWeight > 0 ? Math.round((totalBalance / balanceWeight) * 100) : null,
      avgOrganic: organicWeight > 0 ? Math.round((totalOrganic / organicWeight) * 100) : null,
    };
  }, [liquidityMap]);

  const handleRowClick = useCallback((id: string) => {
    router.push(`/stablecoin/${id}`);
  }, [router]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="rounded-xl">
              <CardHeader className="pb-1"><Skeleton className="h-3 w-24" /></CardHeader>
              <CardContent><Skeleton className="h-8 w-32" /></CardContent>
            </Card>
          ))}
        </div>
        <Skeleton className="h-[400px]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {isError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load liquidity data. {error instanceof Error ? error.message : "Please check your connection."}
        </div>
      )}
      {!isError && (
        <StaleDataBanner
          queries={[{ label: "Liquidity", dataUpdatedAt, staleTime: CRON_30MIN }]}
        />
      )}

      {summaryStats && liquidityMap && (
        <LiquidityStats stats={summaryStats} liquidityMap={liquidityMap} />
      )}

      {/* Filters + Leaderboard */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">Liquidity Leaderboard</h2>
          <div className="flex items-center gap-3">
            <ToggleGroup
              type="single"
              value={pegFilter}
              onValueChange={(v) => v && setPegFilter(v as PegCurrency | "all")}
              className="flex gap-1"
            >
              {PEG_FILTERS.map((f) => (
                <ToggleGroupItem key={f.value} value={f.value} variant="outline" size="sm" className="text-xs">
                  {f.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="relative w-full sm:w-44">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-8 text-xs"
                aria-label="Search stablecoins by name or symbol"
              />
            </div>
          </div>
        </div>

        <LiquidityTable
          rows={rows}
          logos={logos}
          searchQuery={searchQuery}
          onRowClick={handleRowClick}
        />
      </div>
    </div>
  );
}
