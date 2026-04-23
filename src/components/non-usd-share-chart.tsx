"use client";

import { useMemo } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { AreaChart, Area } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useChartShell } from "@/hooks/use-chart-shell";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { TimeRangeOption, useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { formatCurrency, formatChartDate, formatPercent } from "@shared/lib/format";
import { useNonUsdShare } from "@/hooks/api-hooks";
import { CHART_GREEN, CHART_AMBER, CHART_HEIGHT } from "@/lib/chart-colors";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives";
import { computeChartYDomain } from "@/lib/chart-utils";

const COMMODITY_COLOR = CHART_AMBER;
const FIAT_COLOR = CHART_GREEN;
const RANGE_OPTIONS: TimeRangeOption[] = ["7d", "30d", "90d", "1y", "all"];
const DEFAULT_RANGE: TimeRangeOption = "1y";
const FOCUSED_CHART_HEIGHT = "h-[24rem] sm:h-[30rem]";

interface SharePoint {
  ts: number;
  commodityShare: number;
  fiatNonUsdShare: number;
  commodity: number;
  fiatNonUsd: number;
  total: number;
}

interface ShareTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: SharePoint }>;
  label?: number;
}

function ShareTooltip({ active, payload, label }: ShareTooltipProps) {
  if (!payload?.length || !label) return null;
  const point = payload[0]!.payload;
  const totalShare = point.commodityShare + point.fiatNonUsdShare;
  const totalNonUsd = point.commodity + point.fiatNonUsd;
  return (
    <PharosChartTooltip active={active}>
      <TooltipLabel>{formatChartDate(label, "long")}</TooltipLabel>
      <TooltipRow color={COMMODITY_COLOR} label="Commodities" value={`${formatPercent(point.commodityShare)} · ${formatCurrency(point.commodity, 1)}`} />
      <TooltipRow color={FIAT_COLOR} label="Non-commodity non-USD" value={`${formatPercent(point.fiatNonUsdShare)} · ${formatCurrency(point.fiatNonUsd, 1)}`} />
      <div className="border-t border-border/50 mt-1.5 pt-1.5">
        <TooltipRow label="Total non-USD" value={`${formatPercent(totalShare)} · ${formatCurrency(totalNonUsd, 1)}`} bold />
      </div>
    </PharosChartTooltip>
  );
}

interface NonUsdShareChartProps {
  initialRange?: TimeRangeOption;
  isFocused?: boolean;
  onOpenFocus?: (range: TimeRangeOption) => void;
  onCloseFocus?: () => void;
  onRangeChange?: (range: TimeRangeOption) => void;
}

export function NonUsdShareChart({
  initialRange = DEFAULT_RANGE,
  isFocused = false,
  onOpenFocus,
  onCloseFocus,
  onRangeChange,
}: NonUsdShareChartProps = {}) {
  const { data, isLoading } = useNonUsdShare();
  const { animProps, handleAnimationEnd, chartContainerRef, isChartReady, width, height } = useChartShell<HTMLDivElement>();

  const { chartData, latestShare, latestNonUsd, latestTotal } = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0)
      return { chartData: [] as SharePoint[], latestShare: 0, latestNonUsd: 0, latestTotal: 0 };

    const points: SharePoint[] = data.map((point) => ({
      ts: point.date * 1000,
      commodityShare: point.commodityShare ?? 0,
      fiatNonUsdShare: point.fiatNonUsdShare ?? 0,
      commodity: point.commodity ?? 0,
      fiatNonUsd: point.fiatNonUsd ?? 0,
      total: point.total,
    }));

    const last = points[points.length - 1]!;
    return {
      chartData: points,
      latestShare: last.commodityShare + last.fiatNonUsdShare,
      latestNonUsd: last.commodity + last.fiatNonUsd,
      latestTotal: last.total,
    };
  }, [data]);

  const coverageStartLabel = chartData[0] ? formatChartDate(chartData[0].ts, "long") : null;
  const chartHeightClass = isFocused ? FOCUSED_CHART_HEIGHT : CHART_HEIGHT;

  const { range, setRange, filteredData, options } = useTimeRangeFilter(chartData, "ts", RANGE_OPTIONS, {
    initialRange,
  });

  const handleRangeChange = (nextRange: TimeRangeOption) => {
    setRange(nextRange);
    onRangeChange?.(nextRange);
  };

  const yDomain = useMemo(
    () => computeChartYDomain(
      filteredData.map((d) => d.commodityShare + d.fiatNonUsdShare),
      range === "all",
    ),
    [range, filteredData],
  );

  if (isLoading) {
    return (
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle as="h2">Non-USD Market Share</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className={`${CHART_HEIGHT} w-full`} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle as="h2">Share Of Total Stablecoin Market Outside USD</CardTitle>
          {latestTotal > 0 && (
            <p className="text-sm text-muted-foreground">
              Current share: {formatPercent(latestShare)} of total stablecoin market &middot; current outside-USD
              segment size: {formatCurrency(latestNonUsd, 1)}
            </p>
          )}
          {coverageStartLabel ? (
            <p className="text-xs text-muted-foreground">
              Coverage starts {coverageStartLabel}. Built from supply-history snapshots: daily over the last 90d, then
              weekly to 2y, then monthly across the loaded 5y history window. The non-commodity bucket includes
              currency-linked plus other non-commodity pegs.
            </p>
          ) : null}
          {isFocused ? (
            <p className="text-xs text-muted-foreground">
              Focused view &middot; shareable URL &middot; this chart measures share, not cohort dollar market cap.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <TimeRangeButtons options={options} value={range} onChange={handleRangeChange} />
          {isFocused ? (
            <button
              type="button"
              onClick={onCloseFocus}
              aria-label="Return share chart to overview"
              className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground"
            >
              <Minimize2 className="h-3.5 w-3.5" />
              Return share chart to overview
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onOpenFocus?.(range)}
              aria-label="Open large share chart"
              className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              Open large share chart
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {filteredData.length > 0 ? (
          <>
            <div
              ref={chartContainerRef}
              className={chartHeightClass}
              role="figure"
              aria-label={`Share of total stablecoin market outside USD chart showing ${formatPercent(latestShare)} current share`}
            >
              {isChartReady ? (
                <AreaChart
                  width={width}
                  height={height}
                  data={filteredData}
                  margin={{ top: 5, right: 5, bottom: 20, left: 5 }}
                >
                  <defs>
                    <linearGradient id="commodityShareGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COMMODITY_COLOR} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={COMMODITY_COLOR} stopOpacity={0.05} />
                    </linearGradient>
                    <linearGradient id="fiatNonUsdShareGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={FIAT_COLOR} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={FIAT_COLOR} stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <TimeGrid />
                  <TimeXAxis dataKey="ts" minTickGap={72} />
                  <MonoYAxis
                    tickFormatter={(val: number) => formatPercent(val, 1)}
                    domain={yDomain}
                  />
                  <DateTooltip content={<ShareTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="commodityShare"
                    stackId="1"
                    stroke={COMMODITY_COLOR}
                    fill="url(#commodityShareGrad)"
                    strokeWidth={1.5}
                    onAnimationEnd={handleAnimationEnd}
                    {...animProps}
                  />
                  <Area
                    type="monotone"
                    dataKey="fiatNonUsdShare"
                    stackId="1"
                    stroke={FIAT_COLOR}
                    fill="url(#fiatNonUsdShareGrad)"
                    strokeWidth={1.5}
                    {...animProps}
                  />
                </AreaChart>
              ) : (
                <Skeleton className="h-full w-full" />
              )}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: COMMODITY_COLOR }} />
                Commodities (gold, silver)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: FIAT_COLOR }} />
                Non-commodity non-USD
              </span>
            </div>
          </>
        ) : (
          <div className={`flex ${chartHeightClass} items-center justify-center text-muted-foreground`}>
            No market share data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
