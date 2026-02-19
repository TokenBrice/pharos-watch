"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatPercentChange } from "@/lib/format";
import { PEG_META } from "@/lib/peg-config";
import { getCirculatingUSD, getPrevWeekUSD } from "@/lib/supply";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import type { StablecoinData } from "@/lib/types";
import { GOVERNANCE_TIER_COLORS } from "@/lib/classification";

interface CategoryStatsProps {
  data: StablecoinData[] | undefined;
  pegRates?: Record<string, number>;
}

export function CategoryStats({ data, pegRates }: CategoryStatsProps) {
  const stats = useMemo(() => {
    if (!data) return null;

    const rates = pegRates ?? { peggedUSD: 1 };
    const trackedIds = new Set(TRACKED_STABLECOINS.map((s) => s.id));
    const trackedData = data.filter((c) => trackedIds.has(c.id));

    const totalAll = trackedData.reduce((sum, c) => sum + getCirculatingUSD(c, rates), 0);
    const totalPrevWeek = trackedData.reduce((sum, c) => sum + getPrevWeekUSD(c, rates), 0);

    // Breakdown by governance
    const centralizedIds = new Set(TRACKED_STABLECOINS.filter((s) => s.flags.governance === "centralized").map((s) => s.id));
    const dependentIds = new Set(TRACKED_STABLECOINS.filter((s) => s.flags.governance === "centralized-dependent").map((s) => s.id));
    const decentralizedIds = new Set(TRACKED_STABLECOINS.filter((s) => s.flags.governance === "decentralized").map((s) => s.id));

    const centralizedCoins = trackedData.filter((c) => centralizedIds.has(c.id));
    const dependentCoins = trackedData.filter((c) => dependentIds.has(c.id));
    const decentralizedCoins = trackedData.filter((c) => decentralizedIds.has(c.id));

    // Dominance: USDT vs USDC vs rest
    let usdt = 0;
    let usdc = 0;
    let rest = 0;
    let usdtPrev = 0;
    let usdcPrev = 0;
    let restPrev = 0;
    for (const coin of trackedData) {
      const mcap = getCirculatingUSD(coin, rates);
      const prev = getPrevWeekUSD(coin, rates);
      if (coin.id === "1") { usdt = mcap; usdtPrev = prev; }
      else if (coin.id === "2") { usdc = mcap; usdcPrev = prev; }
      else { rest += mcap; restPrev += prev; }
    }

    const centralizedMcap = centralizedCoins.reduce((s, c) => s + getCirculatingUSD(c, rates), 0);
    const dependentMcap = dependentCoins.reduce((s, c) => s + getCirculatingUSD(c, rates), 0);
    const decentralizedMcap = decentralizedCoins.reduce((s, c) => s + getCirculatingUSD(c, rates), 0);
    const govTotal = centralizedMcap + dependentMcap + decentralizedMcap;

    // Alternative peg breakdown (non-USD)
    const metaById = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));
    const pegTotals: Record<string, number> = {};
    let altTotal = 0;
    for (const coin of trackedData) {
      const meta = metaById.get(coin.id);
      if (!meta || meta.flags.pegCurrency === "USD") continue;
      const mcap = getCirculatingUSD(coin, rates);
      pegTotals[meta.flags.pegCurrency] = (pegTotals[meta.flags.pegCurrency] ?? 0) + mcap;
      altTotal += mcap;
    }
    const altPegs = Object.entries(pegTotals)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);

    return {
      totalAll,
      totalPrevWeek,
      totalCount: trackedData.length,
      centralizedMcap,
      dependentMcap,
      decentralizedMcap,
      cefiPct: govTotal > 0 ? (centralizedMcap / govTotal) * 100 : 0,
      depPct: govTotal > 0 ? (dependentMcap / govTotal) * 100 : 0,
      defiPct: govTotal > 0 ? (decentralizedMcap / govTotal) * 100 : 0,
      usdt, usdc, rest,
      usdtPrev, usdcPrev, restPrev,
      altPegs, altTotal,
    };
  }, [data, pegRates]);

  if (!stats) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="rounded-2xl">
              <CardHeader className="pb-1">
                <Skeleton className="h-3 w-24" />
              </CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-8 w-32" />
                <Skeleton className="h-3 w-20" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
        <Card className="rounded-2xl border-l-[3px] border-l-blue-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Tracked</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono tracking-tight">{formatCurrency(stats.totalAll)}</div>
            <div className="flex items-center gap-2">
              <p className="text-xs text-muted-foreground">{stats.totalCount} stablecoins</p>
              {stats.totalPrevWeek > 0 && (
                <span className={`text-xs font-mono ${stats.totalAll >= stats.totalPrevWeek ? "text-green-500" : "text-red-500"}`}>
                  {stats.totalAll >= stats.totalPrevWeek ? "\u2191" : "\u2193"} {formatPercentChange(stats.totalAll, stats.totalPrevWeek)} 7d
                </span>
              )}
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl border-l-[3px] border-l-yellow-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">By Governance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="h-2.5 w-full rounded-full bg-muted overflow-hidden flex">
              <div className="h-full bg-yellow-500" style={{ width: `${stats.cefiPct}%` }} />
              <div className="h-full bg-orange-500" style={{ width: `${stats.depPct}%` }} />
              <div className="h-full bg-green-500" style={{ width: `${stats.defiPct}%` }} />
            </div>
            <div className="space-y-1">
              {([
                { label: "CeFi", pct: stats.cefiPct, mcap: stats.centralizedMcap, ...GOVERNANCE_TIER_COLORS.centralized },
                { label: "CeFi-Dep", pct: stats.depPct, mcap: stats.dependentMcap, ...GOVERNANCE_TIER_COLORS["centralized-dependent"] },
                { label: "DeFi", pct: stats.defiPct, mcap: stats.decentralizedMcap, ...GOVERNANCE_TIER_COLORS.decentralized },
              ] as const).map((t) => (
                <div key={t.label} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-1.5">
                    <div className={`h-2 w-2 rounded-full ${t.bg}`} />
                    <span className={`font-medium ${t.text}`}>{t.label}</span>
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-bold font-mono text-xs">{t.pct.toFixed(1)}%</span>
                    <span className="text-muted-foreground text-xs font-mono">{formatCurrency(t.mcap, 0)}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl border-l-[3px] border-l-sky-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">All Stablecoin Dominance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-emerald-500">USDT</span>
              <div className="flex items-center gap-2">
                <span className="font-mono font-semibold">{formatCurrency(stats.usdt, 0)}</span>
                {stats.usdtPrev > 0 && (
                  <span className={`text-[10px] font-mono ${stats.usdt >= stats.usdtPrev ? "text-green-500" : "text-red-500"}`}>
                    {stats.usdt >= stats.usdtPrev ? "\u2191" : "\u2193"}{((stats.usdt - stats.usdtPrev) / stats.usdtPrev * 100).toFixed(1)}%
                  </span>
                )}
              </div>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-sky-400">USDC</span>
              <div className="flex items-center gap-2">
                <span className="font-mono font-semibold">{formatCurrency(stats.usdc, 0)}</span>
                {stats.usdcPrev > 0 && (
                  <span className={`text-[10px] font-mono ${stats.usdc >= stats.usdcPrev ? "text-green-500" : "text-red-500"}`}>
                    {stats.usdc >= stats.usdcPrev ? "\u2191" : "\u2193"}{((stats.usdc - stats.usdcPrev) / stats.usdcPrev * 100).toFixed(1)}%
                  </span>
                )}
              </div>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zinc-500">Others</span>
              <div className="flex items-center gap-2">
                <span className="font-mono font-semibold">{formatCurrency(stats.rest, 0)}</span>
                {stats.restPrev > 0 && (
                  <span className={`text-[10px] font-mono ${stats.rest >= stats.restPrev ? "text-green-500" : "text-red-500"}`}>
                    {stats.rest >= stats.restPrev ? "\u2191" : "\u2193"}{((stats.rest - stats.restPrev) / stats.restPrev * 100).toFixed(1)}%
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
        {stats.altTotal > 0 && (
          <Card className="rounded-2xl border-l-[3px] border-l-violet-500">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Alt-Peg Stablecoins</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {stats.altPegs.map(([peg, mcap]) => {
                const pct = (mcap / stats.altTotal) * 100;
                const color = PEG_META[peg]?.textColor ?? "text-muted-foreground";
                return (
                  <div key={peg} className="flex justify-between text-sm">
                    <span className={color}>{PEG_META[peg]?.label ?? peg}</span>
                    <div className="flex items-baseline gap-1.5">
                      <span className="font-bold font-mono text-xs">{pct.toFixed(0)}%</span>
                      <span className="font-mono text-xs text-muted-foreground">{formatCurrency(mcap, 0)}</span>
                    </div>
                  </div>
                );
              })}
              <div className="pt-1 border-t">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Total</span>
                  <span className="font-mono">{formatCurrency(stats.altTotal, 0)}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
