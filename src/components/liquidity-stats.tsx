"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  buildBreakdownEntries,
  BreakdownBar,
  BreakdownLegend,
  type BreakdownEntry,
} from "@/components/liquidity-breakdown";
import { buildProtocolBreakdown } from "@/components/liquidity-stats-model";
import { MetricStatCard } from "@/components/metric-stat-card";
import { formatCurrency, getNetColor } from "@shared/lib/format";
import {
  chainColorClass,
  chainLogo,
  prettifyProtocol,
  normalizeChain,
  protocolLogo,
} from "@/lib/dex-display-constants";
import { getScoreColor } from "@/lib/severity-colors";
import type { DexLiquidityData } from "@shared/types";
import { DEX_GLOBAL_KEY } from "@shared/types/market";
import { MethodologyLabel } from "@/components/methodology-hint";
import { LiquidityExitRouteMap } from "@/components/exit-route-map";
import type { LiquidityStatsData } from "@/components/liquidity-stats-types";

interface LiquidityStatsProps {
  stats: LiquidityStatsData;
  liquidityMap: Record<string, DexLiquidityData>;
}

function AggregateBreakdownCard({
  title,
  entries,
  total,
  logoClassName,
}: {
  title: string;
  entries: BreakdownEntry[];
  total: number;
  logoClassName?: string;
}) {
  if (total === 0) return null;

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <CardTitle className="pharos-kicker">{title}</CardTitle>
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
          logoClassName={logoClassName}
          logoSize={16}
          valueFormatter={(entry) => formatCurrency(entry.value)}
        />
      </CardContent>
    </Card>
  );
}

function ChainAggregateBar({ data }: { data: Record<string, DexLiquidityData> }) {
  const globalData = data[DEX_GLOBAL_KEY];
  const { entries, total } = useMemo(() => {
    return buildBreakdownEntries(globalData?.chainTvl ?? {}, {
      labelForKey: normalizeChain,
      colorForKey: chainColorClass,
      logoForKey: chainLogo,
    });
  }, [globalData]);

  return (
    <AggregateBreakdownCard
      title="Chain TVL Breakdown"
      entries={entries}
      total={total}
      logoClassName="h-4 w-4 rounded-full object-contain shrink-0"
    />
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
      logoPath: protocol === "_other" ? undefined : protocolLogo(protocol)?.path,
    })) satisfies BreakdownEntry[];
  }, [globalData]);
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);

  return <AggregateBreakdownCard title="Protocol TVL Breakdown" entries={entries} total={total} />;
}

export function LiquidityStats({ stats, liquidityMap }: LiquidityStatsProps) {
  return (
    <>
      {/* Summary Stats */}
      <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-6">
        <MetricStatCard
          variant="compact"
          title="Total DEX TVL"
          value={formatCurrency(stats.totalTvl)}
          subtext={
            <>
              Across all tracked stablecoins
              {stats.agg7dChange != null && (
                <span
                  className={`ml-2 font-mono ${getNetColor(stats.agg7dChange, { positiveInclusiveZero: true })}`}
                >
                  {stats.agg7dChange >= 0 ? "\u2191" : "\u2193"}
                  {Math.abs(stats.agg7dChange).toFixed(1)}% 7d
                </span>
              )}
            </>
          }
        />

        <MetricStatCard
          variant="compact"
          title="24h DEX Volume"
          value={formatCurrency(stats.totalVol)}
          subtext="Trading volume today"
        />

        <MetricStatCard
          variant="compact"
          title={<MethodologyLabel topic="liquidityScore">Avg Liq Score</MethodologyLabel>}
          value={
            <>
              {stats.avgScore}
              <span className="text-lg text-muted-foreground">/100</span>
            </>
          }
          valueClassName={getScoreColor(stats.avgScore)}
          subtext="Mean score of active coins"
        />

        <MetricStatCard
          variant="compact"
          title={<MethodologyLabel topic="liquidityScore">Covered on DEX</MethodologyLabel>}
          value={stats.withLiquidity}
          subtext={`${stats.highConfidenceCoverage} primary/mixed · ${stats.fallbackCoverage} fallback · of ${stats.totalTracked}`}
        />
        {stats.avgBalance != null && (
          <MetricStatCard
            variant="compact"
            title="Avg Pool Balance"
            value={`${stats.avgBalance}%`}
            subtext="TVL-weighted average"
          />
        )}
        {stats.avgOrganic != null && (
          <MetricStatCard
            variant="compact"
            title="Organic Liquidity"
            value={`${stats.avgOrganic}%`}
            subtext="Fee-based vs incentivized"
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
