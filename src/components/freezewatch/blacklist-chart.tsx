"use client";

import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { QueryStateNotice } from "@/components/query-state-notice";
import { formatCurrency } from "@shared/lib/format";
import { formatCurrencyTick } from "@/lib/chart-ticks";
import { resolveQueryViewState } from "@/lib/query-view-state";
import { BLACKLIST_CHART_COLORS } from "@shared/lib/classification";
import { CHART_SLATE } from "@/lib/chart-colors";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import { ChartLegendChip } from "@/components/chart-primitives/legend";
import {
  QuarterlyStackedBarChart,
  type QuarterlyStackedBarSeries,
} from "@/components/chart-primitives/quarterly-stacked-bar-chart";
import type { BlacklistSummaryResponse, BlacklistStablecoin } from "@shared/types/blacklist";
import { BLACKLIST_STABLECOINS } from "@shared/types/blacklist";

const CHART_HEIGHT = "h-[220px] sm:h-[280px]";
const MAX_BLACKLIST_CHART_COINS = 5;
const BLACKLIST_CHART_OTHER_KEY = "Other" as const;

interface BlacklistChartProps {
  chart: BlacklistSummaryResponse["chart"] | undefined;
  isLoading: boolean;
  error?: unknown;
  onRetry?: () => void;
}

type BlacklistTooltipEntry = {
  dataKey: string;
  value: number;
  color: string;
};

type BlacklistChartInputRow = BlacklistSummaryResponse["chart"][number] &
  Partial<Record<BlacklistStablecoin, number>>;

export type BlacklistChartSeriesKey = BlacklistStablecoin | typeof BLACKLIST_CHART_OTHER_KEY;

export function getBlacklistTooltipSummary(payload?: ReadonlyArray<BlacklistTooltipEntry>) {
  const rows = (payload ?? []).filter((p) => p.dataKey !== "total" && p.value > 0);
  const total = payload?.find((p) => p.dataKey === "total")?.value ?? rows.reduce((sum, p) => sum + p.value, 0);

  return { rows, total };
}

export function getBlacklistChartCoins(
  chartData: ReadonlyArray<BlacklistChartInputRow>,
): BlacklistStablecoin[] {
  return BLACKLIST_STABLECOINS.filter((coin) => chartData.some((point) => (point[coin] ?? 0) > 0));
}

/**
 * Ranks active chart coins by cumulative frozen value, keeps the top 5 as
 * individual stacked series, and folds any remaining coins into a single
 * "Other" bucket so the legend stays scannable.
 */
export function buildBlacklistChartModel(
  chartData: ReadonlyArray<BlacklistChartInputRow>,
): {
  topCoins: BlacklistStablecoin[];
  otherCoins: BlacklistStablecoin[];
  seriesKeys: BlacklistChartSeriesKey[];
  rows: Array<Record<string, string | number>>;
} {
  const activeCoins = getBlacklistChartCoins(chartData);
  const orderIndex = new Map(BLACKLIST_STABLECOINS.map((coin, index) => [coin, index] as const));
  const totalsByCoin = new Map<BlacklistStablecoin, number>();

  for (const coin of activeCoins) {
    let sum = 0;
    for (const point of chartData) {
      sum += point[coin] ?? 0;
    }
    totalsByCoin.set(coin, sum);
  }

  const ranked = [...activeCoins].sort((a, b) => {
    const diff = (totalsByCoin.get(b) ?? 0) - (totalsByCoin.get(a) ?? 0);
    if (diff !== 0) return diff;
    return (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0);
  });

  const topCoins = ranked.slice(0, MAX_BLACKLIST_CHART_COINS);
  const otherCoins = ranked.slice(MAX_BLACKLIST_CHART_COINS);
  const seriesKeys: BlacklistChartSeriesKey[] =
    otherCoins.length > 0 ? [...topCoins, BLACKLIST_CHART_OTHER_KEY] : topCoins;

  const rows = chartData.map((point) => {
    const row: Record<string, string | number> = {
      quarter: point.quarter,
      total: point.total,
    };
    for (const coin of topCoins) {
      row[coin] = point[coin] ?? 0;
    }
    if (otherCoins.length > 0) {
      row[BLACKLIST_CHART_OTHER_KEY] = otherCoins.reduce((sum, coin) => sum + (point[coin] ?? 0), 0);
    }
    return row;
  });

  return { topCoins, otherCoins, seriesKeys, rows };
}

function seriesColor(key: BlacklistChartSeriesKey): string {
  if (key === BLACKLIST_CHART_OTHER_KEY) return CHART_SLATE;
  return BLACKLIST_CHART_COLORS[key];
}

export function BlacklistChart({ chart, isLoading, error, onRetry }: BlacklistChartProps) {
  const chartData = useMemo(() => chart ?? [], [chart]);
  // A failed summary read must not render the successful-empty-ledger copy.
  const unavailable =
    resolveQueryViewState({ hasData: chart != null, isLoading, error }) === "unavailable";

  const peakQuarters = useMemo(() => {
    return [...chartData]
      .filter((point) => point.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 2);
  }, [chartData]);

  const { seriesKeys, otherCoins, rows } = useMemo(
    () => buildBlacklistChartModel(chartData),
    [chartData],
  );

  const chartSeries: QuarterlyStackedBarSeries[] = useMemo(
    () =>
      seriesKeys.map((key, index) => ({
        dataKey: key,
        color: seriesColor(key),
        fillOpacity: index === 0 ? 0.78 : key === BLACKLIST_CHART_OTHER_KEY ? 0.55 : 0.66,
        radius: index === seriesKeys.length - 1 ? [3, 3, 0, 0] : undefined,
      })),
    [seriesKeys],
  );

  if (isLoading) {
    return (
      <section className="pharos-card-shell overflow-hidden rounded-xl">
        <div className="space-y-2 border-b border-border/50 p-5 sm:p-6">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="mt-1 h-4 w-72" />
        </div>
        <div className="p-5 sm:p-6">
          <ChartSkeleton variant="bars" className={`${CHART_HEIGHT} w-full`} />
        </div>
      </section>
    );
  }

  return (
    <section className="pharos-card-shell overflow-hidden rounded-xl animate-in fade-in duration-300">
      <div className="space-y-2 border-b border-border/50 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="pharos-label">Tracked frozen total by quarter</h2>
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
          Bars stack tracked USD balances by issuer so bar height reflects the quarterly rollup total.
        </p>
      </div>
      <div className="p-5 sm:p-6">
        {unavailable ? (
          <QueryStateNotice state="unavailable" label="Freeze ledger chart" onRetry={onRetry} />
        ) : chartData.length > 0 ? (
          <>
            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5" data-testid="blacklist-chart-legend">
              {seriesKeys.map((key) => (
                <ChartLegendChip
                  key={key}
                  markerClassName="inline-block h-2.5 w-2.5 rounded-sm"
                  markerStyle={{ backgroundColor: seriesColor(key) }}
                >
                  {key === BLACKLIST_CHART_OTHER_KEY ? `Other (${otherCoins.length})` : key}
                </ChartLegendChip>
              ))}
            </div>
            <div className="pharos-chart-stage">
              <QuarterlyStackedBarChart
                data={rows}
                series={chartSeries}
                yAxis={{ tickFormatter: formatCurrencyTick, width: 62 }}
                tooltipContent={<BlacklistTooltip />}
                ariaLabel={`Tracked frozen total stacked bar chart showing ${chartData.length} quarters of freeze-ledger balances by stablecoin issuer`}
                height={CHART_HEIGHT}
              />
            </div>
          </>
        ) : (
          <div
            className={`pharos-chart-stage flex ${CHART_HEIGHT} items-center justify-center text-muted-foreground`}
          >
            No valued freeze-ledger snapshots to chart.
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
        <div className="mt-1.5 border-t border-border/50 pt-1.5">
          <TooltipRow label="Total" value={formatCurrency(total)} bold />
        </div>
      )}
    </PharosChartTooltip>
  );
}
