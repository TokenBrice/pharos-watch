"use client";

import { useMemo } from "react";
import { DoorOpen, Gauge, Route, Split } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  buildBreakdownEntries,
  BreakdownBar,
  BreakdownLegend,
  type BreakdownEntry,
} from "@/components/liquidity-breakdown";
import { MetricStatCard } from "@/components/metric-stat-card";
import { formatCurrency, formatPercent } from "@shared/lib/format";
import { PROTOCOL_COLORS, PROTOCOL_LOGOS, EXTRA_COLORS, CHAIN_COLORS, prettifyProtocol, normalizeChain } from "@/lib/dex-display-constants";
import { CHAIN_META } from "@shared/lib/chains";
import { getScoreColor } from "@/lib/severity-colors";
import { cn } from "@/lib/utils";
import type { DexLiquidityData } from "@shared/types";
import { DEX_GLOBAL_KEY } from "@shared/types";
import { MethodologyLabel } from "@/components/methodology-hint";

export interface LiquidityStatsData {
  totalTvl: number;
  totalVol: number;
  avgScore: number;
  withLiquidity: number;
  highConfidenceCoverage: number;
  fallbackCoverage: number;
  totalTracked: number;
  agg7dChange: number | null;
  avgBalance: number | null;
  avgOrganic: number | null;
}

interface LiquidityStatsProps {
  stats: LiquidityStatsData;
  liquidityMap: Record<string, DexLiquidityData>;
}

const MAX_PROTOCOL_LEGEND_ITEMS = 10;
const MAX_VISIBLE_PROTOCOLS = MAX_PROTOCOL_LEGEND_ITEMS - 1;
const MAX_EXIT_ROUTE_ITEMS = 5;

export interface LiquidityExitRouteItem {
  key: string;
  label: string;
  valueUsd: number;
  sharePct: number;
  colorClass: string;
}

export interface LiquidityExitRouteModel {
  totalTvlUsd: number;
  totalVolume24hUsd: number;
  protocolCount: number;
  chainCount: number;
  poolCount: number;
  protocolRoutes: LiquidityExitRouteItem[];
  chainRoutes: LiquidityExitRouteItem[];
  topProtocol: LiquidityExitRouteItem | null;
  topChain: LiquidityExitRouteItem | null;
  concentrationHhi: number | null;
  weightedBalancePct: number | null;
  organicPct: number | null;
  interpretation: string;
}

export function buildProtocolBreakdown(protocolTvl: Record<string, number>) {
  const { entries, total } = buildBreakdownEntries(protocolTvl, {
    maxVisibleItems: MAX_VISIBLE_PROTOCOLS,
    labelForKey: prettifyProtocol,
    colorForKey: (protocol, index) => PROTOCOL_COLORS[protocol] ?? EXTRA_COLORS[index % EXTRA_COLORS.length],
    logoForKey: (protocol) => {
      const path = PROTOCOL_LOGOS[protocol];
      return path ? { path } : null;
    },
  });
  const displayEntries = entries.map((entry) => [entry.key, entry.value] as [string, number]);
  const colorMap = Object.fromEntries(entries.map((entry) => [entry.key, entry.colorClass]));

  return { displayEntries, colorMap, total };
}

function computeHhi(values: Record<string, number>): number | null {
  const positiveValues = Object.values(values).filter((value) => value > 0);
  const total = positiveValues.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  return positiveValues.reduce((sum, value) => {
    const share = value / total;
    return sum + share * share;
  }, 0);
}

function buildExitRouteItems(
  values: Record<string, number>,
  {
    labelForKey,
    colorForKey,
    denominatorUsd,
  }: {
    labelForKey: (key: string) => string;
    colorForKey: (key: string, index: number) => string;
    denominatorUsd?: number;
  },
): LiquidityExitRouteItem[] {
  const total = Object.values(values).reduce((sum, value) => sum + Math.max(value, 0), 0);
  if (total <= 0) return [];
  const shareBase = denominatorUsd && denominatorUsd > 0 ? denominatorUsd : total;

  return Object.entries(values)
    .filter(([, value]) => value > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, MAX_EXIT_ROUTE_ITEMS)
    .map(([key, value], index) => ({
      key,
      label: labelForKey(key),
      valueUsd: value,
      sharePct: (value / shareBase) * 100,
      colorClass: colorForKey(key, index),
    }));
}

export function buildLiquidityExitRouteModel(
  liquidityMap: Record<string, DexLiquidityData>,
  aggregateStats?: Pick<LiquidityStatsData, "avgBalance" | "avgOrganic">,
): LiquidityExitRouteModel | null {
  const globalData = liquidityMap[DEX_GLOBAL_KEY];
  if (!globalData || globalData.totalTvlUsd <= 0) return null;

  const protocolRoutes = buildExitRouteItems(globalData.protocolTvl ?? {}, {
    labelForKey: prettifyProtocol,
    colorForKey: (protocol, index) => PROTOCOL_COLORS[protocol] ?? EXTRA_COLORS[index % EXTRA_COLORS.length],
    denominatorUsd: globalData.totalTvlUsd,
  });
  const chainRoutes = buildExitRouteItems(globalData.chainTvl ?? {}, {
    labelForKey: normalizeChain,
    colorForKey: (chain) => CHAIN_COLORS[chain.toLowerCase()] ?? "bg-muted-foreground",
    denominatorUsd: globalData.totalTvlUsd,
  });
  const concentrationHhi = globalData.concentrationHhi ?? computeHhi(globalData.protocolTvl ?? {});
  const weightedBalancePct = globalData.weightedBalanceRatio == null
    ? aggregateStats?.avgBalance ?? null
    : Math.round(globalData.weightedBalanceRatio * 100);
  const organicPct = globalData.organicFraction == null
    ? aggregateStats?.avgOrganic ?? null
    : Math.round(globalData.organicFraction * 100);
  const interpretation =
    concentrationHhi == null
      ? "Route concentration is not scored for this snapshot."
      : concentrationHhi < 0.18
        ? "Exit depth is broadly distributed across venues."
        : concentrationHhi < 0.35
          ? "Exit depth is usable, but route concentration is visible."
          : "Exit depth is crowded into a small set of venues.";

  return {
    totalTvlUsd: globalData.totalTvlUsd,
    totalVolume24hUsd: globalData.totalVolume24hUsd,
    protocolCount: Object.values(globalData.protocolTvl ?? {}).filter((value) => value > 0).length,
    chainCount: Object.values(globalData.chainTvl ?? {}).filter((value) => value > 0).length,
    poolCount: globalData.poolCount,
    protocolRoutes,
    chainRoutes,
    topProtocol: protocolRoutes[0] ?? null,
    topChain: chainRoutes[0] ?? null,
    concentrationHhi,
    weightedBalancePct,
    organicPct,
    interpretation,
  };
}

function ExitRouteRail({
  title,
  routes,
}: {
  title: string;
  routes: LiquidityExitRouteItem[];
}) {
  if (routes.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
        No route data available.
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <p className="pharos-kicker">{title}</p>
      <div className="space-y-2">
        {routes.map((route) => (
          <div key={route.key} className="grid grid-cols-[minmax(6.5rem,0.9fr)_minmax(0,1.6fr)_auto] items-center gap-3 text-sm">
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">{route.label}</p>
              <p className="font-mono text-[11px] text-muted-foreground">{formatCurrency(route.valueUsd, 0)}</p>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-muted/45" aria-hidden="true">
              <div
                className={cn("h-full rounded-full", route.colorClass)}
                style={{ width: `${Math.min(Math.max(route.sharePct, 1), 100)}%` }}
              />
            </div>
            <span className="w-12 text-right font-mono text-xs text-muted-foreground">
              {formatPercent(route.sharePct, 1)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ExitRouteMetric({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/35 p-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-[11px] uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-1 font-mono text-lg font-bold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function LiquidityExitRouteMap({
  data,
  stats,
}: {
  data: Record<string, DexLiquidityData>;
  stats: LiquidityStatsData;
}) {
  const model = useMemo(() => buildLiquidityExitRouteModel(data, stats), [data, stats]);
  if (!model) return null;

  return (
    <Card className="overflow-hidden rounded-xl border-l-[3px] border-l-emerald-500">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-lg font-semibold tracking-tight">Exit Route Map</CardTitle>
            <p className="max-w-3xl text-sm text-muted-foreground">
              DEX depth by venue and chain. This maps secondary-market exits only; issuer redemption capacity is scored separately.
            </p>
          </div>
          <div className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
            {model.interpretation}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
          <div className="pharos-chart-stage space-y-5">
            <div className="grid gap-5 lg:grid-cols-2">
              <ExitRouteRail title="Protocol doors" routes={model.protocolRoutes} />
              <ExitRouteRail title="Chain lanes" routes={model.chainRoutes} />
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              <span>
                Leading door:{" "}
                <span className="font-medium text-foreground">{model.topProtocol?.label ?? "n/a"}</span>
              </span>
              <span>
                Leading lane:{" "}
                <span className="font-medium text-foreground">{model.topChain?.label ?? "n/a"}</span>
              </span>
              <span className="font-mono tabular-nums">{formatCurrency(model.totalTvlUsd, 0)} total DEX TVL</span>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <ExitRouteMetric
              icon={<DoorOpen className="h-4 w-4 text-emerald-700 dark:text-emerald-300" aria-hidden />}
              label="Open routes"
              value={`${model.protocolCount} / ${model.chainCount}`}
              detail={`${model.poolCount} pools across protocol / chain buckets`}
            />
            <ExitRouteMetric
              icon={<Gauge className="h-4 w-4 text-amber-700 dark:text-amber-300" aria-hidden />}
              label="Crowding index"
              value={model.concentrationHhi == null ? "NR" : model.concentrationHhi.toFixed(2)}
              detail="HHI concentration; lower means more route diversity"
            />
            <ExitRouteMetric
              icon={<Split className="h-4 w-4 text-sky-700 dark:text-sky-300" aria-hidden />}
              label="Pool balance"
              value={model.weightedBalancePct == null ? "NR" : `${model.weightedBalancePct}%`}
              detail="TVL-weighted balance across measured pools"
            />
            <ExitRouteMetric
              icon={<Route className="h-4 w-4 text-violet-700 dark:text-violet-300" aria-hidden />}
              label="Organic"
              value={model.organicPct == null ? "NR" : `${model.organicPct}%`}
              detail={`${formatCurrency(model.totalVolume24hUsd, 0)} 24h routed volume`}
            />
          </div>
        </div>
        <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
          Source: DEX liquidity snapshot. Exit routes show secondary-market depth, not issuer redemption capacity.
        </p>
      </CardContent>
    </Card>
  );
}

function ChainAggregateBar({ data }: { data: Record<string, DexLiquidityData> }) {
  const globalData = data[DEX_GLOBAL_KEY];
  const { entries, total } = useMemo(() => {
    return buildBreakdownEntries(globalData?.chainTvl ?? {}, {
      labelForKey: normalizeChain,
      colorForKey: (chain) => CHAIN_COLORS[chain.toLowerCase()] ?? "bg-muted-foreground",
      logoForKey: (chain) => {
        const meta = CHAIN_META[chain.toLowerCase()];
        return meta?.logoPath ? { path: meta.logoPath, darkInvert: meta.darkInvert } : null;
      },
    });
  }, [globalData]);

  if (total === 0) return null;

  return (
    <Card className="rounded-xl border-l-[3px] border-l-sky-500">
      <CardHeader className="pb-2">
        <CardTitle className="pharos-kicker">
          Chain TVL Breakdown
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <BreakdownBar
          entries={entries}
          total={total}
          minPercent={0.5}
          className="flex h-4 w-full overflow-hidden rounded-full bg-muted"
          titleFormatter={(entry, percent) => `${entry.label}: ${formatCurrency(entry.value)} (${percent.toFixed(1)}%)`}
        />
        <BreakdownLegend
          entries={entries.slice(0, 10)}
          total={total}
          minPercent={0}
          variant="stacked"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
          itemClassName="flex items-center gap-2"
          markerClassName="h-3 w-3"
          logoClassName="h-4 w-4 rounded-full object-contain shrink-0"
          logoSize={16}
          valueFormatter={(entry) => formatCurrency(entry.value)}
        />
      </CardContent>
    </Card>
  );
}

function ProtocolAggregateBar({ data }: { data: Record<string, DexLiquidityData> }) {
  const globalData = data[DEX_GLOBAL_KEY];
  const entries = useMemo(() => {
    const { displayEntries, colorMap } = buildProtocolBreakdown(globalData?.protocolTvl ?? {});
    return displayEntries.map(([protocol, tvl]) => ({
      key: protocol,
      label: protocol === "_other" ? "Other" : prettifyProtocol(protocol),
      value: tvl,
      colorClass: colorMap[protocol] ?? "bg-muted-foreground",
      logoPath: protocol === "_other" ? undefined : PROTOCOL_LOGOS[protocol],
    })) satisfies BreakdownEntry[];
  }, [globalData]);
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);

  if (total === 0) return null;

  return (
    <Card className="rounded-xl border-l-[3px] border-l-violet-500">
      <CardHeader className="pb-2">
        <CardTitle className="pharos-kicker">
          Protocol TVL Breakdown
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <BreakdownBar
          entries={entries}
          total={total}
          minPercent={0.5}
          className="flex h-4 w-full overflow-hidden rounded-full bg-muted"
          titleFormatter={(entry, percent) => `${entry.label}: ${formatCurrency(entry.value)} (${percent.toFixed(1)}%)`}
        />
        <BreakdownLegend
          entries={entries}
          total={total}
          minPercent={0}
          variant="stacked"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
          itemClassName="flex items-center gap-2"
          markerClassName="h-3 w-3"
          logoSize={16}
          valueFormatter={(entry) => formatCurrency(entry.value)}
        />
      </CardContent>
    </Card>
  );
}

export function LiquidityStats({ stats, liquidityMap }: LiquidityStatsProps) {
  return (
    <>
      {/* Summary Stats */}
      <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-6">
        <MetricStatCard
          borderColorClass="border-l-blue-500"
          title="Total DEX TVL"
          value={formatCurrency(stats.totalTvl)}
          valueClassName="text-2xl font-extrabold font-mono tabular-nums tracking-tight"
          subtext={
            <>
              Across all tracked stablecoins
              {stats.agg7dChange != null && (
                <span
                  className={`ml-2 font-mono ${stats.agg7dChange >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}
                >
                  {stats.agg7dChange >= 0 ? "\u2191" : "\u2193"}
                  {Math.abs(stats.agg7dChange).toFixed(1)}% 7d
                </span>
              )}
            </>
          }
          subtextClassName="text-sm text-muted-foreground"
        />

        <MetricStatCard
          borderColorClass="border-l-emerald-500"
          title="24h DEX Volume"
          value={formatCurrency(stats.totalVol)}
          valueClassName="text-2xl font-extrabold font-mono tabular-nums tracking-tight"
          subtext="Trading volume today"
          subtextClassName="text-sm text-muted-foreground"
        />

        <MetricStatCard
          borderColorClass="border-l-amber-500"
          title={<MethodologyLabel topic="liquidityScore">Avg Liq Score</MethodologyLabel>}
          value={
            <>
              {stats.avgScore}
              <span className="text-lg text-muted-foreground">/100</span>
            </>
          }
          valueClassName={`text-2xl font-extrabold font-mono tabular-nums tracking-tight ${getScoreColor(stats.avgScore)}`}
          subtext="Mean score of active coins"
          subtextClassName="text-sm text-muted-foreground"
        />

        <MetricStatCard
          borderColorClass="border-l-violet-500"
          title={<MethodologyLabel topic="liquidityScore">Covered on DEX</MethodologyLabel>}
          value={stats.withLiquidity}
          valueClassName="text-2xl font-extrabold font-mono tabular-nums tracking-tight"
          subtext={`${stats.highConfidenceCoverage} primary/mixed · ${stats.fallbackCoverage} fallback · of ${stats.totalTracked}`}
          subtextClassName="text-sm text-muted-foreground"
        />
        {stats.avgBalance != null && (
          <MetricStatCard
            borderColorClass="border-l-cyan-500"
            title="Avg Pool Balance"
            value={`${stats.avgBalance}%`}
            valueClassName="text-2xl font-extrabold font-mono tabular-nums tracking-tight"
            subtext="TVL-weighted average"
            subtextClassName="text-sm text-muted-foreground"
          />
        )}
        {stats.avgOrganic != null && (
          <MetricStatCard
            borderColorClass="border-l-pink-500"
            title="Organic Liquidity"
            value={`${stats.avgOrganic}%`}
            valueClassName="text-2xl font-extrabold font-mono tabular-nums tracking-tight"
            subtext="Fee-based vs incentivized"
            subtextClassName="text-sm text-muted-foreground"
          />
        )}
      </div>

      <LiquidityExitRouteMap data={liquidityMap} stats={stats} />

      {/* Protocol TVL Breakdown */}
      <ProtocolAggregateBar data={liquidityMap} />

      {/* Chain TVL Breakdown */}
      <ChainAggregateBar data={liquidityMap} />
    </>
  );
}
