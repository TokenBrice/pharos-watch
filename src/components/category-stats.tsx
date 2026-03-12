"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MetricStatCard } from "@/components/metric-stat-card";
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

const SKELETON_CARDS = Array.from({ length: 4 }, (_, i) => i);

interface CategoryStatsProps {
  data: StablecoinData[] | undefined;
  reportCards?: Record<string, ReportCard>;
}

function LegendRow({
  label,
  value,
  meta,
  dotClassName,
  labelClassName,
}: {
  label: string;
  value: string;
  meta?: string;
  dotClassName: string;
  labelClassName?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <div className="flex min-w-0 items-center gap-1.5">
        <div className={`h-2 w-2 shrink-0 rounded-full ${dotClassName}`} />
        <span className={`truncate font-medium ${labelClassName ?? ""}`}>{label}</span>
      </div>
      <div className="flex shrink-0 items-baseline gap-1.5">
        <span className="font-mono text-xs font-bold">{value}</span>
        {meta ? <span className="font-mono text-xs text-muted-foreground">{meta}</span> : null}
      </div>
    </div>
  );
}

export function CategoryStats({ data, reportCards }: CategoryStatsProps) {
  const stats = useMemo(() => {
    if (!data) return null;

    const trackedIds = TRACKED_IDS;
    const trackedData = data.filter((c) => trackedIds.has(c.id));
    const rankedByMcap = trackedData
      .map((coin) => ({
        id: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        mcap: getCirculatingRaw(coin),
      }))
      .filter((coin) => coin.mcap > 0)
      .sort((a, b) => b.mcap - a.mcap);
    const totalMcap = rankedByMcap.reduce((sum, coin) => sum + coin.mcap, 0);

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
    const topTwo = rankedByMcap.slice(0, 2);
    const topTen = rankedByMcap.slice(0, 10);
    const topTwoMcap = topTwo.reduce((sum, coin) => sum + coin.mcap, 0);
    const topTenMcap = topTen.reduce((sum, coin) => sum + coin.mcap, 0);
    const tailMcap = Math.max(totalMcap - topTenMcap, 0);
    const tailCount = Math.max(rankedByMcap.length - topTen.length, 0);
    const dominantLabel = topTwo.map((coin) => coin.symbol).join(" + ") || "Top 2";
    const leaders = rankedByMcap.slice(0, 4).map((coin) => ({
      ...coin,
      sharePct: totalMcap > 0 ? (coin.mcap / totalMcap) * 100 : 0,
    }));
    const concentrationSegments = [
      {
        label: dominantLabel,
        shortLabel: "Top 2",
        pct: totalMcap > 0 ? (topTwoMcap / totalMcap) * 100 : 0,
        countLabel: `${topTwo.length} coins`,
        bg: "bg-sky-500",
        text: "text-sky-700 dark:text-sky-400",
      },
      {
        label: "Next 8",
        shortLabel: "Next 8",
        pct: totalMcap > 0 ? ((topTenMcap - topTwoMcap) / totalMcap) * 100 : 0,
        countLabel: `${Math.max(topTen.length - topTwo.length, 0)} coins`,
        bg: "bg-slate-400",
        text: "text-slate-700 dark:text-slate-300",
      },
      {
        label: "Long tail",
        shortLabel: "Tail",
        pct: totalMcap > 0 ? (tailMcap / totalMcap) * 100 : 0,
        countLabel: `${tailCount} coins`,
        bg: "bg-zinc-600",
        text: "text-zinc-700 dark:text-zinc-400",
      },
    ].filter((segment) => segment.pct > 0);

    return {
      totalMcap,
      leaders,
      dominantLabel,
      concentrationSegments,
      topTwoPct: totalMcap > 0 ? (topTwoMcap / totalMcap) * 100 : 0,
      topTenPct: totalMcap > 0 ? (topTenMcap / totalMcap) * 100 : 0,
      tailPct: totalMcap > 0 ? (tailMcap / totalMcap) * 100 : 0,
      tailCount,
      centralizedMcap: gov.centralizedMcap,
      dependentMcap: gov.dependentMcap,
      decentralizedMcap: gov.decentralizedMcap,
      cefiPct: gov.cefiPct,
      depPct: gov.depPct,
      defiPct: gov.defiPct,
      collateralMcap, collateralTotal,
      altPegs, altTotal,
      altPegCount: Object.keys(pegTotals).length,
    };
  }, [data, reportCards]);

  if (!stats) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:gap-5 lg:grid-cols-2 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
          {SKELETON_CARDS.map((i) => (
            <Card key={i} className={i === 0 ? "rounded-xl xl:row-span-2" : "rounded-xl"}>
              <CardHeader className="pb-1">
                <Skeleton className="h-3 w-24" />
              </CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className={i === 0 ? "h-10 w-36" : "h-8 w-32"} />
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-3 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:gap-5 lg:grid-cols-2 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <MetricStatCard
          borderColorClass="border-l-slate-500"
          title="Market Concentration"
          headerRight={<span className="font-mono text-[11px] text-muted-foreground">{formatCurrency(stats.totalMcap, 0)}</span>}
          className="h-full xl:row-span-2"
          contentClassName="flex h-full flex-col gap-4"
        >
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] xl:grid-cols-1 2xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
            <div className="space-y-4">
              <div className="space-y-2">
                <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Top 2 dominance</p>
                <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
                  <p className="font-mono text-4xl font-black leading-none tracking-tight text-foreground">
                    {stats.topTwoPct.toFixed(1)}%
                  </p>
                  <p className="pb-1 text-sm text-muted-foreground">{stats.dominantLabel}</p>
                </div>
                <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
                  The top 10 stablecoins control {stats.topTenPct.toFixed(1)}% of tracked market cap. The remaining{" "}
                  {stats.tailCount} coins make up {stats.tailPct.toFixed(1)}% of the market.
                </p>
              </div>

              <div className="space-y-2.5">
                <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted/35">
                  {stats.concentrationSegments.map((segment) => (
                    <div key={segment.label} className={segment.bg} style={{ width: `${segment.pct}%` }} />
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {stats.concentrationSegments.map((segment) => (
                    <div key={segment.label} className="flex items-center gap-2 text-xs">
                      <div className={`h-2 w-2 rounded-full ${segment.bg}`} />
                      <span className={`font-medium ${segment.text}`}>{segment.shortLabel}</span>
                      <span className="font-mono text-muted-foreground">{segment.pct.toFixed(1)}%</span>
                      <span className="font-mono text-muted-foreground/75">{segment.countLabel}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-3 border-t border-border/50 pt-4 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0 xl:border-t xl:pl-0 xl:pt-4 2xl:border-l 2xl:border-t-0 2xl:pl-4 2xl:pt-0">
              <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Largest names</p>
              <div className="space-y-2.5">
                {stats.leaders.map((leader) => (
                  <div key={leader.id} className="flex items-baseline justify-between gap-3 border-b border-border/35 pb-2 last:border-b-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-semibold text-foreground">{leader.symbol}</p>
                      <p className="truncate text-xs text-muted-foreground">{leader.name}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono text-sm font-semibold text-foreground">{leader.sharePct.toFixed(1)}%</p>
                      <p className="font-mono text-xs text-muted-foreground">{formatCurrency(leader.mcap, 0)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </MetricStatCard>
        <MetricStatCard
          borderColorClass="border-l-yellow-500"
          title="Stablecoin Types"
          className="h-full"
          contentClassName="space-y-2"
        >
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-yellow-500" style={{ width: `${stats.cefiPct}%` }} />
            <div className="h-full bg-orange-500" style={{ width: `${stats.depPct}%` }} />
            <div className="h-full bg-green-500" style={{ width: `${stats.defiPct}%` }} />
          </div>
          <div className="space-y-1">
            {([
              { label: "Centralized", pct: stats.cefiPct, mcap: stats.centralizedMcap, ...GOVERNANCE_TIER_COLORS.centralized },
              { label: "Centralized-Dependent", pct: stats.depPct, mcap: stats.dependentMcap, ...GOVERNANCE_TIER_COLORS["centralized-dependent"] },
              { label: "Decentralized", pct: stats.defiPct, mcap: stats.decentralizedMcap, ...GOVERNANCE_TIER_COLORS.decentralized },
            ] as const).map((tier) => (
              <LegendRow
                key={tier.label}
                label={tier.label}
                value={`${tier.pct.toFixed(1)}%`}
                meta={formatCurrency(tier.mcap, 0)}
                dotClassName={tier.bg}
                labelClassName={tier.text}
              />
            ))}
          </div>
        </MetricStatCard>
        <MetricStatCard
          borderColorClass="border-l-violet-500"
          title="Alternative Pegs (Not USD)"
          headerRight={<span className="font-mono text-[11px] text-muted-foreground">{stats.altPegCount} pegs</span>}
          className="h-full"
          contentClassName="space-y-2"
        >
          {stats.altTotal > 0 ? (
            <>
              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
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
                    <LegendRow
                      key={peg}
                      label={PEG_META[peg]?.label ?? peg}
                      value={`${pct.toFixed(1)}%`}
                      meta={formatCurrency(mcap, 0)}
                      dotClassName={bgColor}
                      labelClassName={textColor}
                    />
                  );
                })}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">No non-USD peg market cap is available right now.</p>
          )}
        </MetricStatCard>
        <MetricStatCard
          borderColorClass="border-l-sky-500"
          title={
            <>
              Collateral Quality <span className="normal-case font-normal">(USDT &amp; USDC excluded)</span>
            </>
          }
          className="h-full xl:col-span-2"
          contentClassName="space-y-2"
        >
          {stats.collateralTotal > 0 ? (
            <>
              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
                {COLLATERAL_TIERS.map((tier) => {
                  const mcap = stats.collateralMcap[tier.key] ?? 0;
                  const pct = (mcap / stats.collateralTotal) * 100;
                  return pct > 0 ? <div key={tier.key} className={`h-full ${tier.bg}`} style={{ width: `${pct}%` }} /> : null;
                })}
              </div>
              <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {COLLATERAL_TIERS.map((tier) => {
                  const mcap = stats.collateralMcap[tier.key] ?? 0;
                  if (mcap === 0) return null;
                  const pct = (mcap / stats.collateralTotal) * 100;
                  return (
                    <LegendRow
                      key={tier.key}
                      label={tier.label}
                      value={`${pct.toFixed(1)}%`}
                      meta={formatCurrency(mcap, 0)}
                      dotClassName={tier.bg}
                      labelClassName={tier.text}
                    />
                  );
                })}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Collateral quality loads when safety-score market-cap context is available.
            </p>
          )}
        </MetricStatCard>
      </div>
    </div>
  );
}
