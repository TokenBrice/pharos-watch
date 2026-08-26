"use client";

import { useMemo } from "react";
import { Line } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@shared/lib/format";
import { BLACKLIST_CHART_COLORS } from "@shared/lib/classification";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import { ChartLegendChip } from "@/components/chart-primitives/axes";
import {
  QuarterlyStackedBarChart,
  type QuarterlyStackedBarSeries,
} from "@/components/chart-primitives/quarterly-stacked-bar-chart";
import type { BlacklistSummaryResponse, BlacklistStablecoin } from "@shared/types";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";

const CHART_HEIGHT = "h-[220px] sm:h-[280px]";

interface BlacklistChartProps {
  chart: BlacklistSummaryResponse["chart"] | undefined;
  isLoading: boolean;
}

type BlacklistTooltipEntry = {
  dataKey: string;
  value: number;
  color: string;
};

export function getBlacklistTooltipSummary(payload?: ReadonlyArray<BlacklistTooltipEntry>) {
  const rows = (payload ?? []).filter((p) => p.dataKey !== "total" && p.value > 0);
  const total = payload?.find((p) => p.dataKey === "total")?.value ?? rows.reduce((sum, p) => sum + p.value, 0);

  return { rows, total };
}

export function getBlacklistChartCoins(
  chartData: ReadonlyArray<BlacklistSummaryResponse["chart"][number] & Partial<Record<BlacklistStablecoin, number>>>,
): BlacklistStablecoin[] {
  return BLACKLIST_STABLECOINS.filter((coin) => chartData.some((point) => (point[coin] ?? 0) > 0));
}

export function BlacklistChart({ chart, isLoading }: BlacklistChartProps) {
  const chartData = useMemo(() => chart ?? [], [chart]);

  const peakQuarters = useMemo(() => {
    return [...chartData]
      .filter((point) => point.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 2);
  }, [chartData]);
  const chartCoins = useMemo(() => getBlacklistChartCoins(chartData), [chartData]);
  const chartSeries: QuarterlyStackedBarSeries[] = chartCoins.map((coin, i) => ({
    dataKey: coin,
    color: BLACKLIST_CHART_COLORS[coin],
    fillOpacity: i === 0 ? 0.75 : 0.62,
    radius: i === chartCoins.length - 1 ? [3, 3, 0, 0] : undefined,
  }));

  if (isLoading) {
    return (
      <section className="pharos-card-shell overflow-hidden rounded-xl">
        <div className="space-y-2 border-b border-border/50 p-5 sm:p-6">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-72 mt-1" />
        </div>
        <div className="p-5 sm:p-6">
          <Skeleton className={`${CHART_HEIGHT} w-full`} />
        </div>
      </section>
    );
  }

  return (
    <section className="pharos-card-shell overflow-hidden rounded-xl animate-in fade-in duration-300">
      <div className="space-y-2 border-b border-border/50 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="pharos-kicker">Tracked Frozen Total by Quarter</h2>
            <p className="text-sm text-muted-foreground">
              Quarterly spread of the tracked freeze ledger, attributed to each address&apos;s latest recorded freeze
              quarter.
            </p>
          </div>
          {peakQuarters.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {peakQuarters.map((quarter) => (
                <span
                  key={quarter.quarter}
                  className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-xs text-muted-foreground"
                >
                  <span className="font-medium text-foreground">{quarter.quarter}</span>
                  <span className="pharos-numeric">{formatCurrency(quarter.total, 0)}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Bars stack only tracked USD balances, so the quarterly totals roll up to the public freeze-ledger total.
        </p>
      </div>
      <div className="p-5 sm:p-6">
        {chartData.length > 0 ? (
          <>
            <div className="mb-3 flex flex-wrap gap-2">
              {chartCoins.map((coin) => (
                <ChartLegendChip
                  key={coin}
                  markerClassName="inline-block h-2.5 w-2.5 rounded-sm"
                  markerStyle={{ backgroundColor: BLACKLIST_CHART_COLORS[coin] }}
                >
                  {coin}
                </ChartLegendChip>
              ))}
              <ChartLegendChip markerClassName="inline-block h-2.5 w-2.5 rounded-sm bg-foreground/45">
                Total
              </ChartLegendChip>
            </div>
            <div className="pharos-chart-stage">
              <QuarterlyStackedBarChart
                data={chartData}
                series={chartSeries}
                yAxis={{ tickFormatter: (val: number) => formatCurrency(val, 0), width: 62 }}
                tooltipContent={<BlacklistTooltip />}
                ariaLabel={`Tracked frozen total stacked bar chart showing ${chartData.length} quarters of freeze-ledger balances by stablecoin issuer`}
                height={CHART_HEIGHT}
              >
                <Line
                  type="monotone"
                  dataKey="total"
                  stroke="var(--color-foreground)"
                  strokeOpacity={0.45}
                  strokeWidth={1.5}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                />
              </QuarterlyStackedBarChart>
            </div>
          </>
        ) : (
          <div
            className={`pharos-chart-stage flex ${CHART_HEIGHT} items-center justify-center text-muted-foreground`}
          >
            No freeze events recorded yet.
          </div>
        )}
      </div>
    </section>
  );
}

function BlacklistTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<BlacklistTooltipEntry>;
  label?: string;
}) {
  if (!active || !payload) return null;
  const { rows, total } = getBlacklistTooltipSummary(payload);
  if (!rows.length && total <= 0) return null;

  return (
    <PharosChartTooltip active={active}>
      <TooltipLabel>{label}</TooltipLabel>
      {rows.map((p) => (
        <TooltipRow key={p.dataKey} color={p.color} label={p.dataKey} value={formatCurrency(p.value)} />
      ))}
      {total > 0 && (
        <div className="border-t border-border/50 mt-1.5 pt-1.5">
          <TooltipRow label="Total" value={formatCurrency(total)} bold />
        </div>
      )}
    </PharosChartTooltip>
  );
}
