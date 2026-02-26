"use client";

import { useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useDexLiquidity } from "@/hooks/use-dex-liquidity";
import { useDexLiquidityHistory } from "@/hooks/use-dex-liquidity-history";
import { formatCurrency } from "@/lib/format";
import { PROTOCOL_COLORS, EXTRA_COLORS, CHAIN_COLORS, prettifyProtocol, normalizeChain } from "@/lib/dex-constants";
import { getScoreTier, TIER_TEXT, getDurabilityColor, getDurabilityBgColor } from "@/lib/severity-colors";
import { BalanceBar } from "@/components/balance-bar";
import type { DexLiquidityPool, DexLiquidityData } from "@/lib/types";

function TrendArrow({ value }: { value: number | null }) {
  if (value == null) return null;
  const isPositive = value >= 0;
  return (
    <span className={`text-xs font-mono ${isPositive ? "text-emerald-500" : "text-red-500"}`}>
      {isPositive ? "\u2191" : "\u2193"}{Math.abs(value).toFixed(1)}%
    </span>
  );
}

function getConcentrationLabel(hhi: number): { label: string; color: string } {
  if (hhi >= 0.5) return { label: "High", color: "text-red-500" };
  if (hhi >= 0.25) return { label: "Medium", color: "text-amber-500" };
  return { label: "Low", color: "text-emerald-500" };
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
              className={`${colorFor[protocol] ?? "bg-muted-foreground"}`}
              style={{ width: `${pct}%` }}
              title={`${prettifyProtocol(protocol)}: ${formatCurrency(tvl)} (${pct.toFixed(0)}%)`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {entries.slice(0, 5).map(([protocol, tvl]) => (
          <span key={protocol} className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${colorFor[protocol] ?? "bg-muted-foreground"}`} />
            {prettifyProtocol(protocol)} {((tvl / total) * 100).toFixed(0)}%
          </span>
        ))}
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
        {entries.slice(0, 4).map(([chain, tvl]) => (
          <span key={chain} className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${CHAIN_COLORS[chain.toLowerCase()] ?? "bg-muted-foreground"}`} />
            {normalizeChain(chain)} {formatCurrency(tvl)}
          </span>
        ))}
      </div>
    </div>
  );
}

function TopPoolsTable({ pools }: { pools: DexLiquidityPool[] }) {
  if (pools.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Top Pools</p>
      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground">Pool</th>
              <th className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground hidden sm:table-cell">Chain</th>
              <th className="px-3 py-1.5 text-right text-xs font-medium text-muted-foreground">TVL</th>
              <th className="px-3 py-1.5 text-right text-xs font-medium text-muted-foreground hidden md:table-cell">Balance</th>
              <th className="px-3 py-1.5 text-right text-xs font-medium text-muted-foreground hidden sm:table-cell">24h Vol</th>
              <th className="px-3 py-1.5 text-right text-xs font-medium text-muted-foreground hidden lg:table-cell">Detail</th>
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
                <td className="px-3 py-1.5 text-right font-mono tabular-nums hidden sm:table-cell">{formatCurrency(pool.volumeUsd1d)}</td>
                <td className="px-3 py-1.5 text-right text-xs text-muted-foreground hidden lg:table-cell">
                  {pool.extra?.amplificationCoefficient != null && (
                    <span title="Curve amplification coefficient">A={pool.extra.amplificationCoefficient}</span>
                  )}
                  {pool.extra?.feeTier != null && (
                    <span title="Fee tier">{pool.extra.feeTier}bp</span>
                  )}
                  {pool.extra?.isMetaPool && (
                    <span className="ml-1 text-[10px] opacity-60">meta</span>
                  )}
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

  const chartData = useMemo(() => {
    if (!history || history.length < 2) return [];
    return history.map((p) => ({
      date: new Date(p.date * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
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
      <div className="h-32" role="figure" aria-label="TVL trend chart">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
            <defs>
              <linearGradient id="tvlGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-blue-500, #3b82f6)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--color-blue-500, #3b82f6)" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 10, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => formatCurrency(v)}
              width={60}
            />
            <Tooltip
              contentStyle={{ fontSize: 12, backgroundColor: "var(--color-card)", border: "1px solid var(--color-border)", color: "var(--color-card-foreground)" }}
              labelStyle={{ color: "var(--color-card-foreground)" }}
              formatter={(value: number | undefined) => [formatCurrency(value ?? 0), "TVL"]}
            />
            <Area
              type="monotone"
              dataKey="tvl"
              stroke="var(--color-blue-500, #3b82f6)"
              fill="url(#tvlGradient)"
              strokeWidth={1.5}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** 6-bar horizontal breakdown of score components */
function ScoreBreakdown({ components }: {
  components: DexLiquidityData["scoreComponents"];
}) {
  if (!components) return null;
  const bars = [
    { label: "TVL Depth", value: components.tvlDepth, weight: "30%", tooltip: "Total value locked in DEX pools, quality-adjusted" },
    { label: "Volume", value: components.volumeActivity, weight: "20%", tooltip: "Trading volume relative to pool TVL" },
    { label: "Pool Quality", value: components.poolQuality, weight: "20%", tooltip: "Mechanism quality \u00d7 balance health \u00d7 pair quality" },
    { label: "Durability", value: components.durability, weight: "15%", tooltip: "Organic fees, TVL stability, volume consistency, maturity" },
    { label: "Diversity", value: components.pairDiversity, weight: "7.5%", tooltip: "Number of distinct liquidity pools" },
    { label: "Cross-chain", value: components.crossChain, weight: "7.5%", tooltip: "Number of chains with active pools" },
  ];
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Score Breakdown</p>
      {bars.map(({ label, value, weight, tooltip }) => (
        <div key={label} className="flex items-center gap-2 text-xs">
          <span className="w-24 text-muted-foreground shrink-0 cursor-help" title={tooltip}>{label} <span className="opacity-60">({weight})</span></span>
          <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full ${getDurabilityBgColor(value)}`}
              style={{ width: `${value}%` }}
            />
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
  return <span className={`text-xs font-medium ${getDurabilityColor(score)}`}>{label} ({score})</span>;
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
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${color}`}>
      {label}
    </span>
  );
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
  if (!liq || (liq.liquidityScore === 0 && liq.poolCount === 0)) return null;

  const score = liq.liquidityScore ?? 0;
  const tier = getScoreTier(score);

  return (
    <Card className="rounded-xl border-l-[3px] border-l-cyan-500">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle as="h2" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            DEX Liquidity
          </CardTitle>
          <div className={`text-2xl font-bold font-mono ${TIER_TEXT[tier]}`}>
            {score}<span className="text-sm text-muted-foreground">/100</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          <div>
            <p className="text-xs text-muted-foreground">Total AMM Liquidity TVL</p>
            <p className="text-lg font-extrabold font-mono tabular-nums">
              {formatCurrency(liq.totalTvlUsd)}
            </p>
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
              <div className="text-[10px] text-muted-foreground mt-0.5">
                Effective: {formatCurrency(liq.effectiveTvlUsd)}
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
            {liq.concentrationHhi != null && (() => {
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
                <span className={`font-mono tabular-nums ${
                  liq.organicFraction >= 0.8 ? "text-emerald-500" : liq.organicFraction >= 0.5 ? "text-amber-500" : "text-red-500"
                }`}>{Math.round(liq.organicFraction * 100)}%</span>
              </div>
            )}
          </div>
        )}

        {/* DEX-Implied Price */}
        {liq.dexPriceUsd != null && (
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">DEX-Implied Price</p>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="text-lg font-extrabold font-mono tabular-nums">
                ${liq.dexPriceUsd.toFixed(4)}
              </span>
              {liq.dexDeviationBps != null && (
                <span className={`text-sm font-mono ${
                  Math.abs(liq.dexDeviationBps) >= 50 ? "text-amber-500" : "text-muted-foreground"
                }`}>
                  {liq.dexDeviationBps >= 0 ? "+" : ""}{liq.dexDeviationBps}bps vs primary
                </span>
              )}
              {liq.priceSourceCount != null && (
                <span className="text-xs text-muted-foreground">
                  {(() => {
                    const protocols = liq.priceSources && liq.priceSources.length > 0
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

        <ScoreBreakdown components={liq.scoreComponents} />

        <TvlTrendChart stablecoinId={stablecoinId} />

        <TopPoolsTable pools={liq.topPools} />
      </CardContent>
    </Card>
  );
}
