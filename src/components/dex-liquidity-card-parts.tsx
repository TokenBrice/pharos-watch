"use client";

import { useMemo, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip } from "recharts";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { buildBreakdownEntries, BreakdownBar, BreakdownLegend } from "@/components/liquidity-breakdown";
import { useDexLiquidityHistory } from "@/hooks/api-hooks";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { ChartAreaGradient } from "@/components/chart-primitives/axes";
import { formatCurrency, formatChartDate, getNetColor } from "@shared/lib/format";
import { RECHARTS_TOOLTIP_STYLES, CHART_BLUE } from "@/lib/chart-colors";
import {
  PROTOCOL_COLORS,
  EXTRA_COLORS,
  chainColorClass,
  chainLogo,
  prettifyProtocol,
  normalizeChain,
  protocolLogo,
} from "@/lib/dex-display-constants";
import { getDurabilityColor, getDurabilityBgColor } from "@/lib/severity-colors";
import { BalanceBar } from "@/components/balance-bar";
import { formatFeeTierLabel, getPoolVariantLabel, formatBalanceDetails } from "@/components/dex-liquidity-card-model";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import type { DexLiquidityPool, DexLiquidityData } from "@shared/types";
import { LIQUIDITY_SCORE_WEIGHTS } from "@shared/lib/liquidity-score-weights";

export function TrendArrow({ value }: { value: number | null }) {
  if (value == null) return null;
  if (Math.abs(value) < 0.05) return null;
  const isPositive = value >= 0;
  return (
    <span className={`text-xs font-mono ${getNetColor(value, { positiveInclusiveZero: true })}`}>
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
  const protocols =
    priceSources && priceSources.length > 0
      ? [...new Set(priceSources.map((s) => prettifyProtocol(s.protocol)))]
      : null;
  const summary = `from ${count} ${count === 1 ? "pool" : "pools"}`;
  const tvlSuffix = tvl != null ? ` (${formatCurrency(tvl)} TVL)` : "";

  if (!protocols || protocols.length <= 5) {
    const protocolLabel = protocols ? protocols.join(" / ") : "DEX";
    return (
      <span className="text-xs text-muted-foreground">
        from {count} {protocolLabel} {count === 1 ? "pool" : "pools"}
        {tvlSuffix}
      </span>
    );
  }

  return (
    <span className="text-xs text-muted-foreground">
      {summary}
      {tvlSuffix}{" "}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="pharos-focus-ring rounded-sm text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
      >
        {expanded ? "hide sources" : "show all"}
      </button>
      {expanded && <span className="mt-1 block leading-relaxed">{protocols.join(" / ")}</span>}
    </span>
  );
}

type BreakdownSectionEntries = ReturnType<typeof buildBreakdownEntries>["entries"];
type BreakdownLegendValueFormatter = Parameters<typeof BreakdownLegend>[0]["valueFormatter"];

function BreakdownSection({
  title,
  entries,
  total,
  legendLogoClassName,
  legendValueFormatter,
}: {
  title: string;
  entries: BreakdownSectionEntries;
  total: number;
  legendLogoClassName?: string;
  legendValueFormatter: BreakdownLegendValueFormatter;
}) {
  return (
    <div className="space-y-2">
      <p className="pharos-kicker">{title}</p>
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
        logoClassName={legendLogoClassName}
        logoSize={14}
        valueFormatter={legendValueFormatter}
        nameClassName="text-xs text-muted-foreground"
        valueClassName="text-xs text-muted-foreground"
      />
    </div>
  );
}

export function ProtocolBar({ protocolTvl }: { protocolTvl: Record<string, number> }) {
  const { entries, total } = buildBreakdownEntries(protocolTvl, {
    labelForKey: prettifyProtocol,
    colorForKey: (protocol, index) => PROTOCOL_COLORS[protocol] ?? EXTRA_COLORS[index % EXTRA_COLORS.length],
    logoForKey: protocolLogo,
  });
  if (total === 0) return null;

  return (
    <BreakdownSection
      title="Protocol Breakdown"
      entries={entries}
      total={total}
      legendValueFormatter={(_, percent) => `${percent.toFixed(0)}%`}
    />
  );
}

export function ChainBar({ chainTvl }: { chainTvl: Record<string, number> }) {
  const { entries, total } = buildBreakdownEntries(chainTvl, {
    labelForKey: normalizeChain,
    colorForKey: chainColorClass,
    logoForKey: chainLogo,
  });
  if (total === 0 || entries.length <= 1) return null;

  return (
    <BreakdownSection
      title="Chain Breakdown"
      entries={entries}
      total={total}
      legendLogoClassName="h-3.5 w-3.5 rounded-full object-contain shrink-0"
      legendValueFormatter={(entry) => formatCurrency(entry.value)}
    />
  );
}

export function TopPoolsTable({ pools, totalPoolCount }: { pools: DexLiquidityPool[]; totalPoolCount?: number }) {
  if (pools.length === 0) return null;
  const displayed = Math.min(pools.length, 5);

  return (
    <div className="space-y-2">
      <p className="pharos-kicker">
        {totalPoolCount != null && totalPoolCount > displayed
          ? `Top ${displayed} of ${totalPoolCount} pools`
          : "Top Pools"}
      </p>
      <TableFrame
        tableId="dex-liquidity-top-pools"
        testId="dex-liquidity-top-pools-table"
        chrome="embedded"
        density="compact"
        tableClassName="text-sm"
        tableProps={{ "aria-label": "Top DEX liquidity pools" }}
        viewportProps={{ mobileScrollHint: false, compactBottomPadding: false }}
      >
        <TableHeader className="bg-muted/50">
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className="h-auto px-3 py-1.5 text-left text-xs font-medium text-muted-foreground">
              Pool
            </TableHead>
            <TableHead
              scope="col"
              className="hidden h-auto px-3 py-1.5 text-left text-xs font-medium text-muted-foreground sm:table-cell"
            >
              Chain
            </TableHead>
            <TableHead scope="col" className="h-auto px-3 py-1.5 text-right text-xs font-medium text-muted-foreground">
              TVL
            </TableHead>
            <TableHead
              scope="col"
              className="hidden h-auto px-3 py-1.5 text-right text-xs font-medium text-muted-foreground md:table-cell"
            >
              Price
            </TableHead>
            <TableHead
              scope="col"
              className="hidden h-auto px-3 py-1.5 text-right text-xs font-medium text-muted-foreground md:table-cell"
            >
              Balance
            </TableHead>
            <TableHead
              scope="col"
              className="hidden h-auto px-3 py-1.5 text-right text-xs font-medium text-muted-foreground sm:table-cell"
            >
              24h Vol
            </TableHead>
            <TableHead
              scope="col"
              className="hidden h-auto px-3 py-1.5 text-right text-xs text-muted-foreground lg:table-cell"
            >
              Detail
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pools.slice(0, 5).map((pool, index) => (
            <TableRow key={`${pool.chain}-${pool.symbol}-${pool.project}-${index}`} className="border-t">
              <TableCell className="px-3 py-1.5">
                <div className="flex items-center gap-1.5">
                  <StressDot stress={pool.extra?.stressIndex} />
                  <span className="font-medium">{pool.symbol}</span>
                  <span className="text-xs text-muted-foreground">({pool.project})</span>
                </div>
                {pool.extra?.organicFraction != null && (
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-xs text-muted-foreground sm:hidden">{pool.chain}</span>
                    <OrganicBadge fraction={pool.extra.organicFraction} maturityDays={pool.extra.maturityDays} />
                  </div>
                )}
                {pool.extra?.organicFraction == null && (
                  <span className="mt-0.5 block text-xs text-muted-foreground sm:hidden">{pool.chain}</span>
                )}
              </TableCell>
              <TableCell className="hidden px-3 py-1.5 text-muted-foreground sm:table-cell">{pool.chain}</TableCell>
              <TableCell className="px-3 py-1.5 text-right font-mono tabular-nums">
                {formatCurrency(pool.tvlUsd)}
              </TableCell>
              <TableCell className="hidden px-3 py-1.5 text-right font-mono tabular-nums md:table-cell">
                {pool.price != null ? (
                  `$${pool.price.toFixed(4)}`
                ) : (
                  <span className="text-muted-foreground text-xs">&mdash;</span>
                )}
              </TableCell>
              <TableCell
                className="hidden px-3 py-1.5 text-right md:table-cell"
                title={formatBalanceDetails(pool.extra?.balanceDetails) ?? undefined}
              >
                {pool.extra?.balanceRatio != null ? (
                  <BalanceBar ratio={pool.extra.balanceRatio} />
                ) : (
                  <span className="text-muted-foreground text-xs">&mdash;</span>
                )}
              </TableCell>
              <TableCell className="hidden px-3 py-1.5 text-right font-mono tabular-nums sm:table-cell">
                {formatCurrency(pool.volumeUsd1d)}
              </TableCell>
              <TableCell className="hidden px-3 py-1.5 text-right text-xs text-muted-foreground lg:table-cell">
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
                        !variantLabel && <span>&mdash;</span>}
                    </div>
                  );
                })()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </TableFrame>
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
        point.coverageClass === "unobserved" && point.liquidityEvidenceClass === "unobserved" && !point.trendworthy,
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
        <p className="pharos-kicker">TVL History (90d)</p>
        <ChartSkeleton className="h-32" />
      </div>
    );
  }

  if (hasOnlyUnobservedHistory) {
    return (
      <div className="space-y-2">
        <p className="pharos-kicker">TVL History (90d)</p>
        <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          <p>Pharos tracked the last 90 days but found no direct-token DEX liquidity evidence for this asset.</p>
          <p className="mt-1">
            Related-asset liquidity is intentionally not merged into the canonical Liquidity Score.
          </p>
        </div>
      </div>
    );
  }

  if (chartData.length < 2) {
    return null;
  }

  return (
    <div className="space-y-2">
      <p className="pharos-kicker">TVL History (90d)</p>
      <div ref={chartContainerRef} className="h-32" role="figure" aria-label="TVL trend chart">
        {isChartReady ? (
          <AreaChart width={width} height={height} data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
            <defs>
              <ChartAreaGradient id={gradientId} color={CHART_BLUE} />
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
              formatter={(value) => [
                formatCurrency(typeof value === "number" ? value : Number(value ?? 0) || 0),
                "TVL",
              ]}
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
      <p className="pharos-kicker">Score Breakdown</p>
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
