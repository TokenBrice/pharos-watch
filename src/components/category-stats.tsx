"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@shared/lib/format";
import { PEG_CHART_COLORS as PEG_META } from "@shared/lib/classification";
import { getCirculatingRaw, computeGovernanceBreakdown } from "@shared/lib/supply";
import { TRACKED_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { StablecoinData, ReportCard } from "@shared/types";
import { GOVERNANCE_TIER_COLORS } from "@shared/lib/classification";

const COLLATERAL_TIERS = [
  { key: "rwa", label: "RWA", bg: "bg-blue-500", text: "text-blue-700 dark:text-blue-400" },
  { key: "native", label: "Native", bg: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400" },
  { key: "eth-lst", label: "ETH LST", bg: "bg-indigo-500", text: "text-indigo-700 dark:text-indigo-400" },
  { key: "alt-lst-bridged-or-mixed", label: "Mixed", bg: "bg-purple-500", text: "text-purple-700 dark:text-purple-400" },
  { key: "exotic", label: "Exotic", bg: "bg-orange-500", text: "text-orange-700 dark:text-orange-400" },
] as const;

interface CategoryStatsProps {
  data: StablecoinData[] | undefined;
  reportCards?: Record<string, ReportCard>;
}

export function CategoryStats({ data, reportCards }: CategoryStatsProps) {
  const stats = useMemo(() => {
    if (!data) return null;

    const trackedIds = TRACKED_IDS;
    const trackedData = data.filter((c) => trackedIds.has(c.id));

    // Breakdown by governance
    const gov = computeGovernanceBreakdown(trackedData);

    // Collateral quality breakdown by mcap (exclude USDT/USDC — they dominate RWA)
    const collateralMcap: Record<string, number> = {};
    let collateralTotal = 0;
    if (reportCards) {
      for (const coin of trackedData) {
        if (coin.id === "usdt-tether" || coin.id === "usdc-circle") continue;
        const card = reportCards[coin.id];
        if (!card || card.isDefunct) continue;
        const mcap = getCirculatingRaw(coin);
        const cq = card.rawInputs.collateralQuality;
        collateralMcap[cq] = (collateralMcap[cq] ?? 0) + mcap;
        collateralTotal += mcap;
      }
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
      .slice(0, 4);

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
      gradeA, gradeB, gradeC, gradeDF, gradeNR, gradeTotal,
      centralizedMcap: gov.centralizedMcap,
      dependentMcap: gov.dependentMcap,
      decentralizedMcap: gov.decentralizedMcap,
      cefiPct: gov.cefiPct,
      depPct: gov.depPct,
      defiPct: gov.defiPct,
      collateralMcap, collateralTotal,
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
                    { label: "A tier", count: stats.gradeA, bg: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400" },
                    { label: "B tier", count: stats.gradeB, bg: "bg-blue-500", text: "text-blue-700 dark:text-blue-400" },
                    { label: "C tier", count: stats.gradeC, bg: "bg-amber-500", text: "text-amber-700 dark:text-amber-400" },
                    { label: "D / F", count: stats.gradeDF, bg: "bg-red-500", text: "text-red-700 dark:text-red-400" },
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
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">By Collateral <span className="normal-case font-normal">(USDT &amp; USDC excluded)</span></CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {stats.collateralTotal > 0 ? (
              <>
                <div className="h-2.5 w-full rounded-full bg-muted overflow-hidden flex">
                  {COLLATERAL_TIERS.map((t) => {
                    const mcap = stats.collateralMcap[t.key] ?? 0;
                    const pct = (mcap / stats.collateralTotal) * 100;
                    return pct > 0 ? <div key={t.key} className={`h-full ${t.bg}`} style={{ width: `${pct}%` }} /> : null;
                  })}
                </div>
                <div className="space-y-1">
                  {COLLATERAL_TIERS.map((t) => {
                    const mcap = stats.collateralMcap[t.key] ?? 0;
                    if (mcap === 0) return null;
                    const pct = (mcap / stats.collateralTotal) * 100;
                    return (
                      <div key={t.key} className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-1.5">
                          <div className={`h-2 w-2 rounded-full ${t.bg}`} />
                          <span className={`font-medium ${t.text}`}>{t.label}</span>
                        </div>
                        <div className="flex items-baseline gap-1.5">
                          <span className="font-bold font-mono text-xs">{pct.toFixed(1)}%</span>
                          <span className="text-muted-foreground text-xs font-mono">{formatCurrency(mcap, 0)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Loading…</p>
            )}
          </CardContent>
        </Card>
        {stats.altTotal > 0 && (
          <Card className="rounded-xl border-l-[3px] border-l-violet-500">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">By Peg (USD excluded)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="h-2.5 w-full rounded-full bg-muted overflow-hidden flex">
                {stats.altPegs.map(([peg, mcap]) => {
                  const pct = (mcap / stats.altTotal) * 100;
                  const bg = PEG_META[peg]?.bgColor ?? "bg-muted-foreground";
                  return <div key={peg} className={`h-full ${bg}`} style={{ width: `${pct}%` }} />;
                })}
              </div>
              <div className="space-y-1">
                {stats.altPegs.map(([peg, mcap]) => {
                  const pct = (mcap / stats.altTotal) * 100;
                  const textColor = PEG_META[peg]?.textColor ?? "text-muted-foreground";
                  const bgColor = PEG_META[peg]?.bgColor ?? "bg-muted-foreground";
                  return (
                    <div key={peg} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-1.5">
                        <div className={`h-2 w-2 rounded-full ${bgColor}`} />
                        <span className={`font-medium ${textColor}`}>{PEG_META[peg]?.label ?? peg}</span>
                      </div>
                      <div className="flex items-baseline gap-1.5">
                        <span className="font-bold font-mono text-xs">{pct.toFixed(1)}%</span>
                        <span className="text-muted-foreground text-xs font-mono">{formatCurrency(mcap, 0)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
