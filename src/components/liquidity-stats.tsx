"use client";

import { useMemo } from "react";
import Image from "next/image";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricStatCard } from "@/components/metric-stat-card";
import { formatCurrency } from "@shared/lib/format";
import {
  PROTOCOL_COLORS,
  PROTOCOL_LOGOS,
  EXTRA_COLORS,
  CHAIN_COLORS,
  prettifyProtocol,
  normalizeChain,
} from "@/lib/dex-constants";
import { CHAIN_META } from "@shared/lib/chains";
import { getScoreColor } from "@/lib/severity-colors";
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

export function buildProtocolBreakdown(protocolTvl: Record<string, number>) {
  const sorted = Object.entries(protocolTvl).sort((a, b) => b[1] - a[1]) as [string, number][];
  const total = sorted.reduce((sum, [, tvl]) => sum + tvl, 0);

  // Cap the legend at 10 items total: top 9 protocols plus grouped remainder.
  const visible = sorted.slice(0, MAX_VISIBLE_PROTOCOLS);
  const otherTvl = sorted.slice(MAX_VISIBLE_PROTOCOLS).reduce((sum, [, tvl]) => sum + tvl, 0);
  const displayEntries: [string, number][] = otherTvl > 0 ? [...visible, ["_other", otherTvl]] : visible;

  const colorMap: Record<string, string> = { _other: "bg-muted-foreground" };
  let idx = 0;
  for (const [protocol] of displayEntries) {
    if (protocol === "_other") continue;
    colorMap[protocol] = PROTOCOL_COLORS[protocol] ?? EXTRA_COLORS[idx++ % EXTRA_COLORS.length];
  }

  return { displayEntries, colorMap, total };
}

function ChainAggregateBar({ data }: { data: Record<string, DexLiquidityData> }) {
  const chainTotals = useMemo(() => {
    // Use global deduped row to avoid double-counting multi-stablecoin pools
    const globalData = data[DEX_GLOBAL_KEY];
    const totals: Record<string, number> = globalData?.chainTvl ? { ...globalData.chainTvl } : {};
    return Object.entries(totals).sort((a, b) => b[1] - a[1]);
  }, [data]);

  const total = chainTotals.reduce((sum, [, v]) => sum + v, 0);
  if (total === 0) return null;

  return (
    <Card className="rounded-xl border-l-[3px] border-l-sky-500">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Chain TVL Breakdown
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex h-4 w-full overflow-hidden rounded-full bg-muted">
          {chainTotals.map(([chain, tvl]) => {
            const pct = (tvl / total) * 100;
            if (pct < 0.5) return null;
            return (
              <div
                key={chain}
                className={`${CHAIN_COLORS[chain.toLowerCase()] ?? "bg-muted-foreground"} transition-all`}
                style={{ width: `${pct}%` }}
                title={`${normalizeChain(chain)}: ${formatCurrency(tvl)} (${pct.toFixed(1)}%)`}
              />
            );
          })}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {chainTotals.slice(0, 10).map(([chain, tvl]) => {
            const meta = CHAIN_META[chain.toLowerCase()];
            return (
              <div key={chain} className="flex items-center gap-2">
                <span
                  className={`inline-block h-3 w-3 rounded-sm shrink-0 ${CHAIN_COLORS[chain.toLowerCase()] ?? "bg-muted-foreground"}`}
                />
                {meta?.logoPath && (
                  <Image
                    src={meta.logoPath}
                    alt=""
                    width={16}
                    height={16}
                    className={`h-4 w-4 rounded-full object-contain shrink-0${meta.darkInvert ? " dark:invert" : ""}`}
                  />
                )}
                <div>
                  <p className="text-sm font-medium">{normalizeChain(chain)}</p>
                  <p className="text-xs text-muted-foreground font-mono tabular-nums">{formatCurrency(tvl)}</p>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function ProtocolAggregateBar({ data }: { data: Record<string, DexLiquidityData> }) {
  // Use global deduped row to avoid double-counting multi-stablecoin pools
  const { displayEntries, colorMap, total } = useMemo(() => {
    const globalData = data[DEX_GLOBAL_KEY];
    return buildProtocolBreakdown(globalData?.protocolTvl ?? {});
  }, [data]);

  if (total === 0) return null;

  return (
    <Card className="rounded-xl border-l-[3px] border-l-violet-500">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Protocol TVL Breakdown
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex h-4 w-full overflow-hidden rounded-full bg-muted">
          {displayEntries.map(([protocol, tvl]) => {
            const pct = (tvl / total) * 100;
            if (pct < 0.5) return null;
            const color = colorMap[protocol] ?? "bg-muted-foreground";
            const name = protocol === "_other" ? "Other" : prettifyProtocol(protocol);
            return (
              <div
                key={protocol}
                className={`${color} transition-all`}
                style={{ width: `${pct}%` }}
                title={`${name}: ${formatCurrency(tvl)} (${pct.toFixed(1)}%)`}
              />
            );
          })}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {displayEntries.map(([protocol, tvl]) => {
            const color = colorMap[protocol] ?? "bg-muted-foreground";
            const name = protocol === "_other" ? "Other" : prettifyProtocol(protocol);
            const logo = PROTOCOL_LOGOS[protocol];
            return (
              <div key={protocol} className="flex items-center gap-2">
                <span className={`inline-block h-3 w-3 rounded-sm shrink-0 ${color}`} />
                {logo && <Image src={logo} alt="" width={16} height={16} className="rounded-full shrink-0" />}
                <div>
                  <p className="text-sm font-medium">{name}</p>
                  <p className="text-xs text-muted-foreground font-mono tabular-nums">{formatCurrency(tvl)}</p>
                </div>
              </div>
            );
          })}
        </div>
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

      {/* Protocol TVL Breakdown */}
      <ProtocolAggregateBar data={liquidityMap} />

      {/* Chain TVL Breakdown */}
      <ChainAggregateBar data={liquidityMap} />
    </>
  );
}
