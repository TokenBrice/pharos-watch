"use client";

import { useMemo } from "react";
import Image from "next/image";
import { AreaChart, Area, XAxis, YAxis, Tooltip } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useDexLiquidity, useDexLiquidityHistory } from "@/hooks/api-hooks";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { formatCurrency, formatChartDate } from "@shared/lib/format";
import { RECHARTS_TOOLTIP_STYLES, CHART_BLUE } from "@/lib/chart-colors";
import { formatLiquiditySourceMix, getLiquidityCoverageBadge } from "@/lib/liquidity-coverage";
import {
  PROTOCOL_COLORS,
  PROTOCOL_LOGOS,
  EXTRA_COLORS,
  CHAIN_COLORS,
  prettifyProtocol,
  normalizeChain,
} from "@/lib/dex-constants";
import { CHAIN_META } from "@shared/lib/chains";
import { getScoreTier, TIER_TEXT, getDurabilityColor, getDurabilityBgColor } from "@/lib/severity-colors";
import { BalanceBar } from "@/components/balance-bar";
import type { DexLiquidityPool, DexLiquidityData } from "@shared/types";
import { MethodologyCardActions, MethodologyLabel } from "@/components/methodology-hint";

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

function getConcentrationLabel(hhi: number): { label: string; color: string } {
  if (hhi >= 0.5) return { label: "High", color: "text-red-700 dark:text-red-400" };
  if (hhi >= 0.25) return { label: "Medium", color: "text-amber-700 dark:text-amber-400" };
  return { label: "Low", color: "text-emerald-700 dark:text-emerald-400" };
}

function ProtocolBar({ protocolTvl }: { protocolTvl: Record<string, number> }) {
  const entries = Object.entries(protocolTvl).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (total === 0) return null;

  // Pre-compute color for each protocol in display order
  let extraIdx = 0;
  const colorFor: Record<string, string> = {};
  for (const [protocol] of entries) {
    colorFor[protocol] = PROTOCOL_COLORS[protocol] ?? EXTRA_COLORS[extraIdx++ % EXTRA_COLORS.length];
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Protocol Breakdown</p>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
        {entries.map(([protocol, tvl]) => {
          const pct = (tvl / total) * 100;
          if (pct < 1) return null;
          return (
            <div
              key={protocol}
              className={colorFor[protocol] ?? "bg-muted-foreground"}
              style={{ width: `${pct}%` }}
              title={`${prettifyProtocol(protocol)}: ${formatCurrency(tvl)} (${pct.toFixed(0)}%)`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {entries
          .filter(([, tvl]) => (tvl / total) * 100 >= 1)
          .map(([protocol, tvl]) => {
            const logo = PROTOCOL_LOGOS[protocol];
            return (
              <span key={protocol} className="flex items-center gap-1.5">
                <span
                  className={`inline-block h-2.5 w-2.5 rounded-sm shrink-0 ${colorFor[protocol] ?? "bg-muted-foreground"}`}
                />
                {logo && <Image src={logo} alt="" width={14} height={14} className="rounded-full shrink-0" />}
                {prettifyProtocol(protocol)} {((tvl / total) * 100).toFixed(0)}%
              </span>
            );
          })}
      </div>
    </div>
  );
}

function ChainBar({ chainTvl }: { chainTvl: Record<string, number> }) {
  const entries = Object.entries(chainTvl).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (total === 0 || entries.length <= 1) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Chain Breakdown</p>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
        {entries.map(([chain, tvl]) => {
          const pct = (tvl / total) * 100;
          if (pct < 1) return null;
          const displayName = normalizeChain(chain);
          return (
            <div
              key={chain}
              className={CHAIN_COLORS[chain.toLowerCase()] ?? "bg-muted-foreground"}
              style={{ width: `${pct}%` }}
              title={`${displayName}: ${formatCurrency(tvl)} (${pct.toFixed(0)}%)`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {entries
          .filter(([, tvl]) => (tvl / total) * 100 >= 1)
          .map(([chain, tvl]) => {
            const meta = CHAIN_META[chain.toLowerCase()];
            return (
              <span key={chain} className="flex items-center gap-1.5">
                <span
                  className={`inline-block h-2.5 w-2.5 rounded-sm shrink-0 ${CHAIN_COLORS[chain.toLowerCase()] ?? "bg-muted-foreground"}`}
                />
                {meta?.logoPath && (
                  <Image
                    src={meta.logoPath}
                    alt=""
                    width={14}
                    height={14}
                    className={`h-3.5 w-3.5 rounded-full object-contain shrink-0${meta.darkInvert ? " dark:invert" : ""}`}
                  />
                )}
                {normalizeChain(chain)} {formatCurrency(tvl)}
              </span>
            );
          })}
      </div>
    </div>
  );
}

function TopPoolsTable({ pools, totalPoolCount }: { pools: DexLiquidityPool[]; totalPoolCount?: number }) {
  if (pools.length === 0) return null;
  const displayed = pools.slice(0, 5).length;

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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
            {pools.slice(0, 5).map((pool, i) => (
              <tr key={i} className="border-t">
                <td className="px-3 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <StressDot stress={pool.extra?.stressIndex} />
                    <span className="font-medium">{pool.symbol}</span>
                    <span className="text-xs text-muted-foreground">({pool.project})</span>
                  </div>
                  {pool.extra?.organicFraction != null && (
                    <div className="mt-0.5">
                      <OrganicBadge fraction={pool.extra.organicFraction} maturityDays={pool.extra.maturityDays} />
                    </div>
                  )}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground hidden sm:table-cell">{pool.chain}</td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums">{formatCurrency(pool.tvlUsd)}</td>
                <td className="px-3 py-1.5 text-right hidden md:table-cell">
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
                  {pool.extra?.amplificationCoefficient != null && (
                    <span title="Curve amplification coefficient">A={pool.extra.amplificationCoefficient}</span>
                  )}
                  {pool.extra?.feeTier != null && <span title="Fee tier">{pool.extra.feeTier}bp</span>}
                  {pool.extra?.isMetaPool && <span className="ml-1 text-xs opacity-60">meta</span>}
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
  const { data: history, isLoading } = useDexLiquidityHistory(stablecoinId, 90);
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();

  const chartData = useMemo(() => {
    if (!history || history.length < 2) return [];
    return history.map((p) => ({
      date: formatChartDate(p.date * 1000, "short"),
      tvl: p.tvl,
    }));
  }, [history]);

  if (chartData.length < 2) {
    if (isLoading) {
      return (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">TVL History (90d)</p>
          <ChartSkeleton className="h-32" />
        </div>
      );
    }
    return null;
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">TVL History (90d)</p>
      <div ref={chartContainerRef} className="h-32" role="figure" aria-label="TVL trend chart">
        {isChartReady ? (
          <AreaChart width={width} height={height} data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
            <defs>
              <linearGradient id="tvlGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={CHART_BLUE} stopOpacity={0.3} />
                <stop offset="95%" stopColor={CHART_BLUE} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => formatCurrency(v)}
              width={60}
            />
            <Tooltip
              {...RECHARTS_TOOLTIP_STYLES}
              formatter={(value) => [formatCurrency(typeof value === "number" ? value : Number(value ?? 0) || 0), "TVL"]}
            />
            <Area type="monotone" dataKey="tvl" stroke={CHART_BLUE} fill="url(#tvlGradient)" strokeWidth={1.5} />
          </AreaChart>
        ) : (
          <ChartSkeleton className="h-full w-full" />
        )}
      </div>
    </div>
  );
}

/** 6-bar horizontal breakdown of score components */
function ScoreBreakdown({ components }: { components: DexLiquidityData["scoreComponents"] }) {
  if (!components) return null;
  const bars = [
    {
      label: "TVL Depth",
      value: components.tvlDepth,
      weight: "35%",
      tooltip: "Log-scale effective TVL (quality-adjusted, metapool-deduped)",
    },
    {
      label: "Volume",
      value: components.volumeActivity,
      weight: "20%",
      tooltip: "Log-scale volume/TVL ratio",
    },
    {
      label: "Pool Quality",
      value: components.poolQuality,
      weight: "22.5%",
      tooltip: "Mechanism quality \u00d7 balance health \u00d7 pair quality",
    },
    {
      label: "Durability",
      value: components.durability,
      weight: "15%",
      tooltip: "TVL stability, volume consistency, maturity, organic fees",
    },
    {
      label: "Diversity",
      value: components.pairDiversity,
      weight: "7.5%",
      tooltip: "Number of distinct liquidity pools",
    },
  ];
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Score Breakdown</p>
      {bars.map(({ label, value, weight, tooltip }) => (
        <div key={label} className="flex items-center gap-2 text-xs">
          <span className="w-24 text-muted-foreground shrink-0 cursor-help" title={tooltip}>
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
      <Card className="rounded-xl border-l-[3px] border-l-cyan-500">
        <CardHeader className="pb-2">
          <Skeleton className="h-3 w-36" />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const liq = liquidityMap?.[stablecoinId];
  if (!liq) return null;

  const score = liq.liquidityScore ?? 0;
  const tier = getScoreTier(score);
  const coverageBadge = getLiquidityCoverageBadge(liq.coverageClass);
  const isRated = liq.liquidityScore != null;

  return (
    <Card className="rounded-xl border-l-[3px] border-l-cyan-500 animate-in fade-in duration-300">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>
              <MethodologyLabel topic="liquidityScore">DEX Liquidity</MethodologyLabel>
            </CardTitle>
            <Badge
              variant="outline"
              className={`text-[10px] ${coverageBadge.className}`}
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
      <CardContent className="space-y-4">
        {!isRated && (
          <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
            No observed DEX liquidity in the current pipeline. This asset is tracked, but it is currently unrated for
            Liquidity Score.
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          <div>
            <p className="text-xs text-muted-foreground">Total AMM Liquidity TVL</p>
            <p className="text-lg font-extrabold font-mono tabular-nums">{formatCurrency(liq.totalTvlUsd)}</p>
            {(liq.tvlChange24h != null || liq.tvlChange7d != null) && (
              <div className="flex gap-2 mt-0.5">
                {liq.tvlChange24h != null && (
                  <span className="text-xs text-muted-foreground">
                    24h <TrendArrow value={liq.tvlChange24h} />
                  </span>
                )}
                {liq.tvlChange7d != null && (
                  <span className="text-xs text-muted-foreground">
                    7d <TrendArrow value={liq.tvlChange7d} />
                  </span>
                )}
              </div>
            )}
            {liq.effectiveTvlUsd > 0 && liq.effectiveTvlUsd !== liq.totalTvlUsd && (
              <div className="text-xs text-muted-foreground mt-0.5">
                <span className="inline-flex items-center gap-1">
                  <MethodologyLabel topic="effectiveTvl">Effective</MethodologyLabel>: {formatCurrency(liq.effectiveTvlUsd)}
                </span>
              </div>
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

        {/* Concentration & Stability indicators */}
        {(liq.concentrationHhi != null || liq.depthStability != null) && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            {liq.concentrationHhi != null &&
              (() => {
                const { label, color } = getConcentrationLabel(liq.concentrationHhi);
                return (
                  <span className="text-muted-foreground">
                    Concentration: <span className={`font-medium ${color}`}>{label}</span>
                    <span className="text-xs ml-1 font-mono">({(liq.concentrationHhi * 100).toFixed(0)}%)</span>
                  </span>
                );
              })()}
            {liq.depthStability != null && (
              <span className="text-muted-foreground">
                Depth Stability: <span className="font-medium font-mono">{(liq.depthStability * 100).toFixed(0)}%</span>
              </span>
            )}
          </div>
        )}

        {/* Durability, balance, organic indicators */}
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
                  className={`font-mono tabular-nums ${
                    liq.organicFraction >= 0.8
                      ? "text-emerald-700 dark:text-emerald-400"
                      : liq.organicFraction >= 0.5
                        ? "text-amber-700 dark:text-amber-400"
                        : "text-red-700 dark:text-red-400"
                  }`}
                >
                  {Math.round(liq.organicFraction * 100)}%
                </span>
              </div>
            )}
          </div>
        )}

        {/* DEX-Implied Price */}
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
                <span className="text-xs text-muted-foreground">
                  {(() => {
                    const protocols =
                      liq.priceSources && liq.priceSources.length > 0
                        ? [...new Set(liq.priceSources.map((s) => prettifyProtocol(s.protocol)))]
                        : null;
                    const protocolLabel = protocols ? protocols.join(" / ") : "DEX";
                    return `from ${liq.priceSourceCount} ${protocolLabel} ${liq.priceSourceCount === 1 ? "pool" : "pools"}`;
                  })()}
                  {liq.priceSourceTvl != null && ` (${formatCurrency(liq.priceSourceTvl)} TVL)`}
                </span>
              )}
            </div>
          </div>
        )}

        <ProtocolBar protocolTvl={liq.protocolTvl} />

        <ChainBar chainTvl={liq.chainTvl} />

        {isRated && <ScoreBreakdown components={liq.scoreComponents} />}

        {isRated && <TvlTrendChart stablecoinId={stablecoinId} />}

        {liq.topPools.length > 0 && <TopPoolsTable pools={liq.topPools} totalPoolCount={liq.poolCount} />}

        <MethodologyCardActions topic="liquidityScore" />
      </CardContent>
    </Card>
  );
}
