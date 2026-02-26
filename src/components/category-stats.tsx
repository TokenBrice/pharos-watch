"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatPercentChange } from "@/lib/format";
import { PEG_CHART_COLORS as PEG_META } from "@/lib/classification";
import { getCirculatingRaw, getPrevWeekRaw, computeGovernanceBreakdown } from "@/lib/supply";
import { TRACKED_IDS, TRACKED_META_BY_ID } from "@/lib/stablecoins";
import type { StablecoinData, ReportCard } from "@/lib/types";
import { GOVERNANCE_TIER_COLORS } from "@/lib/classification";

interface CategoryStatsProps {
  data: StablecoinData[] | undefined;
  reportCards?: Record<string, ReportCard>;
}

export function CategoryStats({ data, reportCards }: CategoryStatsProps) {
  const stats = useMemo(() => {
    if (!data) return null;

    const trackedIds = TRACKED_IDS;
    const trackedData = data.filter((c) => trackedIds.has(c.id));

    const totalAll = trackedData.reduce((sum, c) => sum + getCirculatingRaw(c), 0);
    const totalPrevWeek = trackedData.reduce((sum, c) => sum + getPrevWeekRaw(c), 0);

    // Breakdown by governance
    const gov = computeGovernanceBreakdown(trackedData);

    // Dominance: USDT vs USDC vs rest
    let usdt = 0;
    let usdc = 0;
    let rest = 0;
    let usdtPrev = 0;
    let usdcPrev = 0;
    let restPrev = 0;
    for (const coin of trackedData) {
      const mcap = getCirculatingRaw(coin);
      const prev = getPrevWeekRaw(coin);
      if (coin.id === "1") { usdt = mcap; usdtPrev = prev; }
      else if (coin.id === "2") { usdc = mcap; usdcPrev = prev; }
      else { rest += mcap; restPrev += prev; }
    }

    // Alternative peg breakdown (non-USD)
    const metaById = TRACKED_META_BY_ID;
    const pegTotals: Record<string, number> = {};
    let altTotal = 0;
    for (const coin of trackedData) {
      const meta = metaById.get(coin.id);
      if (!meta || meta.flags.pegCurrency === "USD") continue;
      const mcap = getCirculatingRaw(coin);
      pegTotals[meta.flags.pegCurrency] = (pegTotals[meta.flags.pegCurrency] ?? 0) + mcap;
      altTotal += mcap;
    }
    const altPegs = Object.entries(pegTotals)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);

    // Safety score breakdown by grade tier
    let gradeA = 0;
    let gradeB = 0;
    let gradeC = 0;
    let gradeDF = 0;
    let gradeNR = 0;
    if (reportCards) {
      for (const card of Object.values(reportCards)) {
        if (card.isDefunct) continue;
        const g = card.overallGrade;
        if (g === "A+" || g === "A" || g === "A-") gradeA++;
        else if (g === "B+" || g === "B" || g === "B-") gradeB++;
        else if (g === "C+" || g === "C" || g === "C-") gradeC++;
        else if (g === "D" || g === "F") gradeDF++;
        else gradeNR++;
      }
    }
    const gradeTotal = gradeA + gradeB + gradeC + gradeDF;

    return {
      totalAll,
      totalPrevWeek,
      totalCount: trackedData.length,
      gradeA, gradeB, gradeC, gradeDF, gradeNR, gradeTotal,
      centralizedMcap: gov.centralizedMcap,
      dependentMcap: gov.dependentMcap,
      decentralizedMcap: gov.decentralizedMcap,
      cefiPct: gov.cefiPct,
      depPct: gov.depPct,
      defiPct: gov.defiPct,
      usdt, usdc, rest,
      usdtPrev, usdcPrev, restPrev,
      altPegs, altTotal,
    };
  }, [data, reportCards]);

  if (!stats) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="rounded-xl">
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
        <Card className="rounded-xl border-l-[3px] border-l-blue-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">By Safety Score</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {stats.gradeTotal > 0 ? (
              <>
                <div className="h-2.5 w-full rounded-full bg-muted overflow-hidden flex">
                  <div className="h-full bg-emerald-500" style={{ width: `${(stats.gradeA / stats.gradeTotal) * 100}%` }} />
                  <div className="h-full bg-blue-500" style={{ width: `${(stats.gradeB / stats.gradeTotal) * 100}%` }} />
                  <div className="h-full bg-amber-500" style={{ width: `${(stats.gradeC / stats.gradeTotal) * 100}%` }} />
                  <div className="h-full bg-red-500" style={{ width: `${(stats.gradeDF / stats.gradeTotal) * 100}%` }} />
                </div>
                <div className="space-y-1">
                  {([
                    { label: "A tier", count: stats.gradeA, bg: "bg-emerald-500", text: "text-emerald-500" },
                    { label: "B tier", count: stats.gradeB, bg: "bg-blue-500", text: "text-blue-500" },
                    { label: "C tier", count: stats.gradeC, bg: "bg-amber-500", text: "text-amber-500" },
                    { label: "D / F", count: stats.gradeDF, bg: "bg-red-500", text: "text-red-500" },
                  ] as const).map((t) => (
                    <div key={t.label} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-1.5">
                        <div className={`h-2 w-2 rounded-full ${t.bg}`} />
                        <span className={`font-medium ${t.text}`}>{t.label}</span>
                      </div>
                      <div className="flex items-baseline gap-1.5">
                        <span className="font-bold font-mono text-xs">{t.count}</span>
                        <span className="text-muted-foreground text-xs font-mono">{stats.gradeTotal > 0 ? ((t.count / stats.gradeTotal) * 100).toFixed(0) : 0}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Loading scores…</p>
            )}
          </CardContent>
        </Card>
        <Card className="rounded-xl border-l-[3px] border-l-yellow-500">
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
        <Card className="rounded-xl border-l-[3px] border-l-sky-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">All Stablecoin Dominance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-emerald-500">USDT</span>
              <div className="flex items-center gap-2">
                <span className="font-mono font-semibold">{formatCurrency(stats.usdt, 0)}</span>
                {stats.usdtPrev > 0 && (
                  <span className={`text-xs font-mono ${stats.usdt >= stats.usdtPrev ? "text-green-500" : "text-red-500"}`}>
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
                  <span className={`text-xs font-mono ${stats.usdc >= stats.usdcPrev ? "text-green-500" : "text-red-500"}`}>
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
                  <span className={`text-xs font-mono ${stats.rest >= stats.restPrev ? "text-green-500" : "text-red-500"}`}>
                    {stats.rest >= stats.restPrev ? "\u2191" : "\u2193"}{((stats.rest - stats.restPrev) / stats.restPrev * 100).toFixed(1)}%
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
        {stats.altTotal > 0 && (
          <Card className="rounded-xl border-l-[3px] border-l-violet-500">
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
              <div className="pt-1 border-t border-border/50">
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
