"use client";

import { useMemo, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip } from "recharts";
import { ChartSkeleton } from "@/components/chart-skeleton";
import {
  buildBreakdownEntries,
  BreakdownBar,
  BreakdownLegend,
} from "@/components/liquidity-breakdown";
import { useDexLiquidityHistory } from "@/hooks/api-hooks";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { formatCurrency, formatChartDate } from "@shared/lib/format";
import { RECHARTS_TOOLTIP_STYLES, CHART_BLUE } from "@/lib/chart-colors";
import {
  PROTOCOL_COLORS,
  PROTOCOL_LOGOS,
  EXTRA_COLORS,
  CHAIN_COLORS,
  prettifyProtocol,
  normalizeChain,
} from "@/lib/dex-display-constants";
import { CHAIN_META } from "@shared/lib/chains";
import { getDurabilityColor, getDurabilityBgColor } from "@/lib/severity-colors";
import { BalanceBar } from "@/components/balance-bar";
import {
  formatFeeTierLabel,
  getPoolVariantLabel,
  formatBalanceDetails,
} from "@/components/dex-liquidity-card-model";
import type { DexLiquidityPool, DexLiquidityData } from "@shared/types";
import { LIQUIDITY_SCORE_WEIGHTS } from "@shared/lib/liquidity-score-weights";

export function TrendArrow({ value }: { value: number | null }) {
  if (value == null) return null;
  if (Math.abs(value) < 0.05) return null;
  const isPositive = value >= 0;
  return (
    <span
      className={`text-xs font-mono ${isPositive ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}
    >
      {isPositive ? "\u2191" : "\u2193"}
      {Math.abs(value).toFixed(1)}%
    </span>
  );
}

export function PoolSourceLabel({
  count,
  tvl,
  priceSources,
}: {
  count: number;
  tvl: number | null;
  priceSources: Array<{ protocol: string }> | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const protocols = priceSources && priceSources.length > 0
    ? [...new Set(priceSources.map((s) => prettifyProtocol(s.protocol)))]
    : null;
  const summary = `from ${count} ${count === 1 ? "pool" : "pools"}`;
  const tvlSuffix = tvl != null ? ` (${formatCurrency(tvl)} TVL)` : "";

  if (!protocols || protocols.length <= 5) {
    const protocolLabel = protocols ? protocols.join(" / ") : "DEX";
    return (
      <span className="text-xs text-muted-foreground">
        from {count} {protocolLabel} {count === 1 ? "pool" : "pools"}{tvlSuffix}
      </span>
    );
  }

  return (
    <span className="text-xs text-muted-foreground">
      {summary}{tvlSuffix}
      {" "}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="pharos-focus-ring rounded-sm text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
      >
        {expanded ? "hide sources" : "show all"}
      </button>
      {expanded && (
        <span className="mt-1 block leading-relaxed">
          {protocols.join(" / ")}
        </span>
      )}
    </span>
  );
}

export function ProtocolBar({ protocolTvl }: { protocolTvl: Record<string, number> }) {
  const { entries, total } = buildBreakdownEntries(protocolTvl, {
    labelForKey: prettifyProtocol,
    colorForKey: (protocol, index) => PROTOCOL_COLORS[protocol] ?? EXTRA_COLORS[index % EXTRA_COLORS.length],
    logoForKey: (protocol) => {
      const path = PROTOCOL_LOGOS[protocol];
      return path ? { path } : null;
    },
  });
  if (total === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-foreground">Protocol Breakdown</p>
      <BreakdownBar
        entries={entries}
        total={total}
        minPercent={1}
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
        titleFormatter={(entry, percent) => `${entry.label}: ${formatCurrency(entry.value)} (${percent.toFixed(0)}%)`}
      />
      <BreakdownLegend
        entries={entries}
        total={total}
        minPercent={1}
        variant="inline"
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
        itemClassName="flex items-center gap-1.5"
        markerClassName="h-2.5 w-2.5"
        logoSize={14}
        valueFormatter={(_, percent) => `${percent.toFixed(0)}%`}
        nameClassName="text-xs text-muted-foreground"
        valueClassName="text-xs text-muted-foreground"
      />
    </div>
  );
}

export function ChainBar({ chainTvl }: { chainTvl: Record<string, number> }) {
  const { entries, total } = buildBreakdownEntries(chainTvl, {
    labelForKey: normalizeChain,
    colorForKey: (chain) => CHAIN_COLORS[chain.toLowerCase()] ?? "bg-muted-foreground",
    logoForKey: (chain) => {
      const meta = CHAIN_META[chain.toLowerCase()];
      return meta?.logoPath ? { path: meta.logoPath, darkInvert: meta.darkInvert } : null;
    },
  });
  if (total === 0 || entries.length <= 1) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-foreground">Chain Breakdown</p>
      <BreakdownBar
        entries={entries}
        total={total}
        minPercent={1}
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
        titleFormatter={(entry, percent) => `${entry.label}: ${formatCurrency(entry.value)} (${percent.toFixed(0)}%)`}
      />
      <BreakdownLegend
        entries={entries}
        total={total}
        minPercent={1}
        variant="inline"
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
        itemClassName="flex items-center gap-1.5"
        markerClassName="h-2.5 w-2.5"
        logoClassName="h-3.5 w-3.5 rounded-full object-contain shrink-0"
        logoSize={14}
        valueFormatter={(entry) => formatCurrency(entry.value)}
        nameClassName="text-xs text-muted-foreground"
        valueClassName="text-xs text-muted-foreground"
      />
    </div>
  );
}

export function TopPoolsTable({ pools, totalPoolCount }: { pools: DexLiquidityPool[]; totalPoolCount?: number }) {
  if (pools.length === 0) return null;
  const displayed = Math.min(pools.length, 5);

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-foreground">
        {totalPoolCount != null && totalPoolCount > displayed
          ? `Top ${displayed} of ${totalPoolCount} pools`
          : "Top Pools"}
      </p>
      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground">Pool</th>
              <th className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground hidden sm:table-cell">
                Chain
              </th>
              <th className="px-3 py-1.5 text-right text-xs font-medium text-muted-foreground">TVL</th>
              <th className="px-3 py-1.5 text-right text-xs font-medium text-muted-foreground hidden md:table-cell">
                Price
              </th>
              <th className="px-3 py-1.5 text-right text-xs font-medium text-muted-foreground hidden md:table-cell">
                Balance
              </th>
              <th className="px-3 py-1.5 text-right text-xs font-medium text-muted-foreground hidden sm:table-cell">
                24h Vol
              </th>
              <th className="px-3 py-1.5 text-right text-xs text-muted-foreground hidden lg:table-cell">
                Detail
              </th>
            </tr>
          </thead>
          <tbody>
            {pools.slice(0, 5).map((pool) => (
              <tr key={`${pool.chain}-${pool.symbol}-${pool.project}`} className="border-t">
                <td className="px-3 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <StressDot stress={pool.extra?.stressIndex} />
                    <span className="font-medium">{pool.symbol}</span>
                    <span className="text-xs text-muted-foreground">({pool.project})</span>
                  </div>
                  {(pool.extra?.organicFraction != null) && (
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-xs text-muted-foreground sm:hidden">{pool.chain}</span>
                      <OrganicBadge fraction={pool.extra.organicFraction} maturityDays={pool.extra.maturityDays} />
                    </div>
                  )}
                  {pool.extra?.organicFraction == null && (
                    <span className="mt-0.5 block text-xs text-muted-foreground sm:hidden">{pool.chain}</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground hidden sm:table-cell">{pool.chain}</td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums">{formatCurrency(pool.tvlUsd)}</td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums hidden md:table-cell">
                  {pool.price != null ? (
                    `$${pool.price.toFixed(4)}`
                  ) : (
                    <span className="text-muted-foreground text-xs">&mdash;</span>
                  )}
                </td>
                <td
                  className="px-3 py-1.5 text-right hidden md:table-cell"
                  title={formatBalanceDetails(pool.extra?.balanceDetails) ?? undefined}
                >
                  {pool.extra?.balanceRatio != null ? (
                    <BalanceBar ratio={pool.extra.balanceRatio} />
                  ) : (
                    <span className="text-muted-foreground text-xs">&mdash;</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums hidden sm:table-cell">
                  {formatCurrency(pool.volumeUsd1d)}
                </td>
                <td className="px-3 py-1.5 text-right text-xs text-muted-foreground hidden lg:table-cell">
                  {(() => {
                    const variantLabel = getPoolVariantLabel(pool.poolType);
                    return (
                      <div className="flex justify-end gap-1.5">
                        {pool.extra?.amplificationCoefficient != null && (
                          <span title="Curve amplification coefficient">A={pool.extra.amplificationCoefficient}</span>
                        )}
                        {pool.extra?.amplificationCoefficient == null && variantLabel && (
                          <span title="Pool variant">{variantLabel}</span>
                        )}
                        {pool.extra?.feeTier != null && (
                          <span title="Fee tier">{formatFeeTierLabel(pool.extra.feeTier)}</span>
                        )}
                        {pool.extra?.isMetaPool && <span className="opacity-60">meta</span>}
                        {pool.extra?.amplificationCoefficient == null &&
                          pool.extra?.feeTier == null &&
                          !pool.extra?.isMetaPool &&
                          !variantLabel && (
                            <span>&mdash;</span>
                          )}
                      </div>
                    );
                  })()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function TvlTrendChart({ stablecoinId }: { stablecoinId: string }) {
  const gradientId = `tvlGrad-${stablecoinId}`;
  const { data: history, isLoading } = useDexLiquidityHistory(stablecoinId, 90);
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();
  const hasOnlyUnobservedHistory = Boolean(
    history &&
      history.length > 0 &&
      history.every(
        (point) =>
          point.coverageClass === "unobserved" &&
          point.liquidityEvidenceClass === "unobserved" &&
          !point.trendworthy,
      ),
  );

  const chartData = useMemo(() => {
    if (!history || history.length < 2) return [];
    return history.map((p) => ({
      date: formatChartDate(p.date * 1000, "short"),
      tvl: p.tvl,
    }));
  }, [history]);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-foreground">TVL History (90d)</p>
        <ChartSkeleton className="h-32" />
      </div>
    );
  }

  if (hasOnlyUnobservedHistory) {
    return (
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-foreground">TVL History (90d)</p>
        <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          <p>Pharos tracked the last 90 days but found no direct-token DEX liquidity evidence for this asset.</p>
          <p className="mt-1">Related-asset liquidity is intentionally not merged into the canonical Liquidity Score.</p>
        </div>
      </div>
    );
  }

  if (chartData.length < 2) {
    return null;
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-foreground">TVL History (90d)</p>
      <div ref={chartContainerRef} className="h-32" role="figure" aria-label="TVL trend chart">
        {isChartReady ? (
          <AreaChart width={width} height={height} data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={CHART_BLUE} stopOpacity={0.3} />
                <stop offset="95%" stopColor={CHART_BLUE} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              minTickGap={24}
            />
            <YAxis
              tick={{ fontSize: 11, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => formatCurrency(v)}
              width={56}
            />
            <Tooltip
              {...RECHARTS_TOOLTIP_STYLES}
              formatter={(value) => [formatCurrency(typeof value === "number" ? value : Number(value ?? 0) || 0), "TVL"]}
            />
            <Area type="monotone" dataKey="tvl" stroke={CHART_BLUE} fill={`url(#${gradientId})`} strokeWidth={1.5} />
          </AreaChart>
        ) : (
          <ChartSkeleton className="h-full w-full" />
        )}
      </div>
    </div>
  );
}

/** 5-bar horizontal breakdown of score components */
export function ScoreBreakdown({ components }: { components: DexLiquidityData["scoreComponents"] }) {
  if (!components) return null;
  const bars = LIQUIDITY_SCORE_WEIGHTS.map((w) => ({
    label: w.label,
    value: components[w.key],
    weight: w.displayWeight,
    tooltip: w.tooltip,
  }));
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-foreground">Score Breakdown</p>
      {bars.map(({ label, value, weight, tooltip }) => (
        <div key={label} className="flex items-center gap-2 text-xs">
          <span className="w-28 sm:w-36 text-muted-foreground shrink-0 cursor-help" title={tooltip}>
            {label} <span className="opacity-60">({weight})</span>
          </span>
          <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
            <div className={`h-full rounded-full ${getDurabilityBgColor(value)}`} style={{ width: `${value}%` }} />
          </div>
          <span className="w-8 text-right font-mono tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  );
}

export function DurabilityBadge({ score }: { score: number | null }) {
  if (score == null) return null;
  const label = score >= 70 ? "Durable" : score >= 40 ? "Moderate" : "Fragile";
  return (
    <span className={`text-xs font-medium ${getDurabilityColor(score)}`}>
      {label} ({score})
    </span>
  );
}

function OrganicBadge({ fraction, maturityDays }: { fraction: number | undefined; maturityDays?: number }) {
  if (fraction == null) return null;
  // Mature pools (>1yr) with long-running reward programs aren't mercenary farming
  const mature = (maturityDays ?? 0) >= 365;
  let label: string;
  let color: string;
  if (fraction >= 0.7) {
    label = "Organic";
    color = "text-emerald-600 bg-emerald-500/10";
  } else if (fraction >= 0.3 || mature) {
    label = mature && fraction < 0.3 ? "Established" : "Mixed";
    color = "text-amber-600 bg-amber-500/10";
  } else {
    label = "Incentivized";
    color = "text-red-600 bg-red-500/10";
  }
  return <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${color}`}>{label}</span>;
}

function StressDot({ stress }: { stress: number | undefined }) {
  if (stress == null) return null;
  const color = stress <= 30 ? "bg-emerald-500" : stress <= 60 ? "bg-amber-500" : "bg-red-500";
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} title={`Stress: ${stress}/100`} />;
}
