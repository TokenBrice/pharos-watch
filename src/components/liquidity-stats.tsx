"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";
import { PROTOCOL_COLORS, EXTRA_COLORS, CHAIN_COLORS, prettifyProtocol, normalizeChain } from "@/lib/dex-constants";
import { getScoreColor } from "@/lib/severity-colors";
import type { DexLiquidityData } from "@/lib/types";

export interface LiquidityStatsData {
  totalTvl: number;
  totalVol: number;
  avgScore: number;
  withLiquidity: number;
  totalTracked: number;
  agg7dChange: number | null;
  avgBalance: number | null;
  avgOrganic: number | null;
}

interface LiquidityStatsProps {
  stats: LiquidityStatsData;
  liquidityMap: Record<string, DexLiquidityData>;
}

const MAX_VISIBLE_PROTOCOLS = 10;

function ChainAggregateBar({ data }: { data: Record<string, DexLiquidityData> }) {
  const chainTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const liq of Object.values(data)) {
      for (const [chain, tvl] of Object.entries(liq.chainTvl)) {
        totals[chain] = (totals[chain] ?? 0) + tvl;
      }
    }
    return Object.entries(totals).sort((a, b) => b[1] - a[1]);
  }, [data]);

  const total = chainTotals.reduce((sum, [, v]) => sum + v, 0);
  if (total === 0) return null;

  return (
    <Card className="rounded-2xl border-l-[3px] border-l-sky-500">
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
          {chainTotals.slice(0, 10).map(([chain, tvl]) => (
            <div key={chain} className="flex items-center gap-2">
              <span className={`inline-block h-3 w-3 rounded-full ${CHAIN_COLORS[chain.toLowerCase()] ?? "bg-muted-foreground"}`} />
              <div>
                <p className="text-sm font-medium">{normalizeChain(chain)}</p>
                <p className="text-xs text-muted-foreground font-mono tabular-nums">{formatCurrency(tvl)}</p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ProtocolAggregateBar({ data }: { data: Record<string, DexLiquidityData> }) {
  // Aggregate protocol TVL across all stablecoins
  const { displayEntries, colorMap, total } = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const liq of Object.values(data)) {
      for (const [protocol, tvl] of Object.entries(liq.protocolTvl)) {
        totals[protocol] = (totals[protocol] ?? 0) + tvl;
      }
    }
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]) as [string, number][];
    const t = sorted.reduce((sum, [, v]) => sum + v, 0);

    // Top N protocols shown individually, rest grouped into "Other"
    const visible = sorted.slice(0, MAX_VISIBLE_PROTOCOLS);
    const otherTvl = sorted
      .slice(MAX_VISIBLE_PROTOCOLS)
      .reduce((sum, [, v]) => sum + v, 0);
    const entries: [string, number][] = otherTvl > 0
      ? [...visible, ["_other", otherTvl]]
      : visible;

    // Pre-compute colors: hardcoded for known, rotating palette for the rest
    const map: Record<string, string> = { _other: "bg-muted-foreground" };
    let idx = 0;
    for (const [protocol] of entries) {
      if (protocol === "_other") continue;
      map[protocol] = PROTOCOL_COLORS[protocol] ?? EXTRA_COLORS[idx++ % EXTRA_COLORS.length];
    }

    return { displayEntries: entries, colorMap: map, total: t };
  }, [data]);

  if (total === 0) return null;

  return (
    <Card className="rounded-2xl border-l-[3px] border-l-violet-500">
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
            return (
              <div key={protocol} className="flex items-center gap-2">
                <span className={`inline-block h-3 w-3 rounded-full ${color}`} />
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
        <Card className="rounded-2xl border-l-[3px] border-l-blue-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total DEX TVL</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono tracking-tight">{formatCurrency(stats.totalTvl)}</div>
            <p className="text-sm text-muted-foreground">
              Across all tracked stablecoins
              {stats.agg7dChange != null && (
                <span className={`ml-2 font-mono ${stats.agg7dChange >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                  {stats.agg7dChange >= 0 ? "\u2191" : "\u2193"}{Math.abs(stats.agg7dChange).toFixed(1)}% 7d
                </span>
              )}
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-l-[3px] border-l-emerald-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">24h DEX Volume</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono tracking-tight">{formatCurrency(stats.totalVol)}</div>
            <p className="text-sm text-muted-foreground">Trading volume today</p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-l-[3px] border-l-amber-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Avg Liq Score</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold font-mono tracking-tight ${getScoreColor(stats.avgScore)}`}>
              {stats.avgScore}<span className="text-lg text-muted-foreground">/100</span>
            </div>
            <p className="text-sm text-muted-foreground">Mean score of active coins</p>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-l-[3px] border-l-violet-500">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Active on DEX</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono tracking-tight">{stats.withLiquidity}</div>
            <p className="text-sm text-muted-foreground">of {stats.totalTracked} tracked stablecoins</p>
          </CardContent>
        </Card>
        {stats.avgBalance != null && (
          <Card className="rounded-2xl border-l-[3px] border-l-cyan-500">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Avg Pool Balance</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono tracking-tight">{stats.avgBalance}%</div>
              <p className="text-sm text-muted-foreground">TVL-weighted average</p>
            </CardContent>
          </Card>
        )}
        {stats.avgOrganic != null && (
          <Card className="rounded-2xl border-l-[3px] border-l-pink-500">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Organic Liquidity</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono tracking-tight">{stats.avgOrganic}%</div>
              <p className="text-sm text-muted-foreground">Fee-based vs incentivized</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Protocol TVL Breakdown */}
      <ProtocolAggregateBar data={liquidityMap} />

      {/* Chain TVL Breakdown */}
      <ChainAggregateBar data={liquidityMap} />
    </>
  );
}
