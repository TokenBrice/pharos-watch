"use client";

import { useMemo, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip } from "recharts";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartSkeleton } from "@/components/chart-skeleton";
import {
  buildBreakdownEntries,
  BreakdownBar,
  BreakdownLegend,
} from "@/components/liquidity-breakdown";
import { useDexLiquidity, useDexLiquidityHistory } from "@/hooks/api-hooks";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { formatCurrency, formatChartDate, formatPercentFromRatio } from "@shared/lib/format";
import { RECHARTS_TOOLTIP_STYLES, CHART_BLUE } from "@/lib/chart-colors";
import { formatLiquiditySourceMix, getLiquidityCoverageBadge } from "@/lib/liquidity-coverage";
import {
  PROTOCOL_COLORS,
  PROTOCOL_LOGOS,
  EXTRA_COLORS,
  CHAIN_COLORS,
  prettifyProtocol,
  normalizeChain,
} from "@/lib/dex-display-constants";
import { CHAIN_META } from "@shared/lib/chains";
import { getScoreTier, TIER_TEXT, getDurabilityColor, getDurabilityBgColor, ratioQualityColor } from "@/lib/severity-colors";
import { BalanceBar } from "@/components/balance-bar";
import {
  getConcentrationLabel,
  formatFeeTierLabel,
  getPoolVariantLabel,
  formatBalanceDetails,
  getLiquidityEvidenceLabel,
} from "@/components/dex-liquidity-card-model";
import type { DexLiquidityPool, DexLiquidityData } from "@shared/types";
import { MethodologyCardActions, MethodologyLabel } from "@/components/methodology-hint";
import { LIQUIDITY_SCORE_WEIGHTS } from "@shared/lib/liquidity-score-weights";

function TrendArrow({ value }: { value: number | null }) {
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

function PoolSourceLabel({
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

function ProtocolBar({ protocolTvl }: { protocolTvl: Record<string, number> }) {
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

function ChainBar({ chainTvl }: { chainTvl: Record<string, number> }) {
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

function TopPoolsTable({ pools, totalPoolCount }: { pools: DexLiquidityPool[]; totalPoolCount?: number }) {
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
              <th className="px-3 py-1.5 text-right text-xs font-medium text-muted-foreground hidden lg:table-cell">
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

function TvlTrendChart({ stablecoinId }: { stablecoinId: string }) {
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
function ScoreBreakdown({ components }: { components: DexLiquidityData["scoreComponents"] }) {
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

function DurabilityBadge({ score }: { score: number | null }) {
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

export function DexLiquidityCard({ stablecoinId }: { stablecoinId: string }) {
  const { data: liquidityMap, isLoading } = useDexLiquidity();

  if (isLoading) {
    return (
      <Card className="rounded-xl">
        <CardHeader className="pb-2">
          <Skeleton className="h-3 w-36" />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
            <Skeleton className="col-span-2 h-16" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const liq = liquidityMap?.[stablecoinId];
  if (!liq) {
    return (
      <Card className="rounded-xl">
        <CardHeader className="pb-2">
          <DetailSectionTitle>
            <MethodologyLabel topic="liquidityScore">DEX Liquidity</MethodologyLabel>
          </DetailSectionTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No DEX liquidity data available for this stablecoin.
          </p>
        </CardContent>
      </Card>
    );
  }

  const score = liq.liquidityScore ?? 0;
  const tier = getScoreTier(score);
  const coverageBadge = getLiquidityCoverageBadge(liq.coverageClass ?? "unobserved");
  const isRated = liq.liquidityScore != null;
  const evidenceLabel = getLiquidityEvidenceLabel(liq);
  const hasTvlChange24h = liq.tvlChange24h != null && Math.abs(liq.tvlChange24h) >= 0.05;
  const hasTvlChange7d = liq.tvlChange7d != null && Math.abs(liq.tvlChange7d) >= 0.05;

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <DetailSectionTitle>
              <MethodologyLabel topic="liquidityScore">DEX Liquidity</MethodologyLabel>
            </DetailSectionTitle>
            <Badge
              variant="outline"
              className={`text-[11px] ${coverageBadge.className}`}
              title={formatLiquiditySourceMix(liq.sourceMix)}
            >
              {coverageBadge.label}
            </Badge>
          </div>
          {isRated ? (
            <div className={`text-2xl font-extrabold font-mono tabular-nums ${TIER_TEXT[tier]}`}>
              {score}
              <span className="text-sm text-muted-foreground">/100</span>
            </div>
          ) : (
            <div className="text-xl font-semibold text-muted-foreground">NR</div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {!isRated && (
          <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
            <p>No observed direct DEX market for this token in the current pipeline.</p>
            <p className="mt-1">Liquidity Score stays unrated until Pharos sees exact-token pool evidence.</p>
          </div>
        )}

        {/* ── Zone 1: Health Summary ── */}
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
            <div className="col-span-2 min-w-0 space-y-1 sm:col-span-2 lg:col-span-2">
              <p className="text-xs font-medium text-muted-foreground">
                <MethodologyLabel topic="effectiveTvl">Effective Liquidity</MethodologyLabel>
              </p>
              <p className="text-xl font-extrabold font-mono tabular-nums sm:text-2xl">{formatCurrency(liq.effectiveTvlUsd)}</p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span>
                  <span className="sm:hidden">AMM TVL</span>
                  <span className="hidden sm:inline">Total AMM Liquidity TVL</span>
                  {": "}
                  <span className="font-mono tabular-nums text-foreground/90">{formatCurrency(liq.totalTvlUsd)}</span>
                </span>
                {(hasTvlChange24h || hasTvlChange7d) && (
                  <span className="flex flex-wrap gap-x-2 gap-y-0.5">
                    {hasTvlChange24h && (
                      <span>
                        24h <TrendArrow value={liq.tvlChange24h} />
                      </span>
                    )}
                    {hasTvlChange7d && (
                      <span>
                        7d <TrendArrow value={liq.tvlChange7d} />
                      </span>
                    )}
                  </span>
                )}
              </div>
              {evidenceLabel && (
                <div className="text-xs text-muted-foreground mt-0.5">{evidenceLabel}</div>
              )}
            </div>
            <div>
              <p className="text-xs text-muted-foreground">24h Volume</p>
              <p className="text-lg font-extrabold font-mono tabular-nums">{formatCurrency(liq.totalVolume24hUsd)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">7d Volume</p>
              <p className="text-lg font-extrabold font-mono tabular-nums">{formatCurrency(liq.totalVolume7dUsd)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Pools</p>
              <p className="text-lg font-extrabold font-mono tabular-nums">{liq.poolCount}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Chains</p>
              <p className="text-lg font-extrabold font-mono tabular-nums">{liq.chainCount}</p>
            </div>
          </div>

          {/* Health indicators — grouped into a cohesive block */}
          {(liq.concentrationHhi != null || liq.depthStability != null ||
            liq.durabilityScore != null || liq.weightedBalanceRatio != null || liq.organicFraction != null) && (
            <div className="rounded-lg bg-muted/20 px-3 py-2.5 space-y-1.5">
              {(liq.concentrationHhi != null || liq.depthStability != null) && (
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                  {liq.concentrationHhi != null &&
                    (() => {
                      const { label, color } = getConcentrationLabel(liq.concentrationHhi);
                      return (
                        <span className="text-muted-foreground">
                          Concentration: <span className={`font-medium ${color}`}>{label}</span>
                          <span className="text-xs ml-1 font-mono">({formatPercentFromRatio(liq.concentrationHhi, 0)})</span>
                        </span>
                      );
                    })()}
                  {liq.depthStability != null && (
                    <span className="text-muted-foreground">
                      Depth Stability: <span className="font-medium font-mono">{formatPercentFromRatio(liq.depthStability, 0)}</span>
                    </span>
                  )}
                </div>
              )}
              {(liq.durabilityScore != null || liq.weightedBalanceRatio != null || liq.organicFraction != null) && (
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                  {liq.durabilityScore != null && (
                    <div>
                      <span className="text-muted-foreground">Durability: </span>
                      <DurabilityBadge score={liq.durabilityScore} />
                    </div>
                  )}
                  {liq.weightedBalanceRatio != null && (
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">Pool Balance: </span>
                      <BalanceBar ratio={liq.weightedBalanceRatio} />
                    </div>
                  )}
                  {liq.organicFraction != null && (
                    <div>
                      <span className="text-muted-foreground">Organic: </span>
                      <span
                        className={`font-mono tabular-nums ${ratioQualityColor(liq.organicFraction)}`}
                      >
                        {formatPercentFromRatio(liq.organicFraction, 0)}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* DEX-Implied Price — anchors the bottom of the summary zone */}
          {liq.dexPriceUsd != null && (
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">DEX-Implied Price</p>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="text-lg font-extrabold font-mono tabular-nums">${liq.dexPriceUsd.toFixed(4)}</span>
                {liq.dexDeviationBps != null && (
                  <span
                    className={`text-sm font-mono ${
                      Math.abs(liq.dexDeviationBps) >= 50 ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"
                    }`}
                  >
                    {liq.dexDeviationBps >= 0 ? "+" : ""}
                    {liq.dexDeviationBps}bps vs primary
                  </span>
                )}
                {liq.priceSourceCount != null && (
                  <PoolSourceLabel
                    count={liq.priceSourceCount}
                    tvl={liq.priceSourceTvl ?? null}
                    priceSources={liq.priceSources ?? null}
                  />
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Zone 2: Market Structure ── */}
        <div className="space-y-4">
          <ProtocolBar protocolTvl={liq.protocolTvl} />

          <ChainBar chainTvl={liq.chainTvl} />

          {isRated && <ScoreBreakdown components={liq.scoreComponents} />}

          <TvlTrendChart stablecoinId={stablecoinId} />

          {liq.topPools.length > 0 && <TopPoolsTable pools={liq.topPools} totalPoolCount={liq.poolCount} />}
        </div>

        <MethodologyCardActions topic="liquidityScore" />
      </CardContent>
    </Card>
  );
}
