"use client";

import { useMemo } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { Area, AreaChart } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useChartShell } from "@/hooks/use-chart-shell";
import { useStablecoinCharts } from "@/hooks/api-hooks";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { TimeRangeOption, useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives/axes";
import { computeChartYDomain } from "@/lib/chart-utils";
import { CHART_HEIGHT } from "@/lib/chart-colors";
import { PEG_CHART_COLORS } from "@shared/lib/classification";
import { formatChartDate, formatCurrency } from "@shared/lib/format";
import { PharosChartTooltip, TooltipLabel } from "@/components/pharos-chart-tooltip";

const OTHER_KEY = "peggedOther";
const OTHER_THRESHOLD = 5_000_000;
const OTHER_COLOR = PEG_CHART_COLORS.OTHER.hex;
const RANGE_OPTIONS: TimeRangeOption[] = ["7d", "30d", "90d", "1y", "all"];
const DEFAULT_RANGE: TimeRangeOption = "1y";
const FOCUSED_CHART_HEIGHT = "h-[24rem] sm:h-[30rem]";

function pegKeyToCode(key: string): string {
  return key.replace(/^pegged/, "");
}

function pegKeyToHex(key: string): string {
  if (key === OTHER_KEY) return OTHER_COLOR;
  return PEG_CHART_COLORS[pegKeyToCode(key)]?.hex ?? OTHER_COLOR;
}

function pegKeyToLabel(key: string): string {
  if (key === OTHER_KEY) return "Other";
  return PEG_CHART_COLORS[pegKeyToCode(key)]?.label ?? pegKeyToCode(key);
}

interface ChartRow extends Record<string, number> {
  ts: number;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number; color: string }>;
  label?: number;
  pegKeys: string[];
}

function CohortTooltip({ active, payload, label, pegKeys }: ChartTooltipProps) {
  if (!active || !payload?.length || !label) return null;

  const rows = [...pegKeys]
    .reverse()
    .map((key) => {
      const item = payload.find((entry) => entry.dataKey === key);
      if (!item || !item.value) return null;
      return { key, value: item.value, color: pegKeyToHex(key) };
    })
    .filter(Boolean) as Array<{ key: string; value: number; color: string }>;

  const total = rows.reduce((sum, row) => sum + row.value, 0);

  return (
    <PharosChartTooltip active={active}>
      <TooltipLabel>{formatChartDate(label, "long")}</TooltipLabel>
      {rows.map((row) => (
        <div key={row.key} className="flex items-center justify-between gap-4 text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span
              className="inline-block size-2 shrink-0 rounded-full"
              style={{ backgroundColor: row.color }}
            />
            {pegKeyToLabel(row.key)}
          </span>
          <span className="pharos-numeric text-foreground">{formatCurrency(row.value)}</span>
        </div>
      ))}
      <div className="mt-1.5 flex items-center justify-between gap-4 border-t border-border/50 pt-1.5 text-xs">
        <span className="text-muted-foreground">Total</span>
        <span className="pharos-numeric font-semibold text-foreground">{formatCurrency(total)}</span>
      </div>
    </PharosChartTooltip>
  );
}

interface AltPegCohortHistoryChartProps {
  initialRange?: TimeRangeOption;
  isFocused?: boolean;
  onOpenFocus?: (range: TimeRangeOption) => void;
  onCloseFocus?: () => void;
  onRangeChange?: (range: TimeRangeOption) => void;
}

export function AltPegCohortHistoryChart({
  initialRange = DEFAULT_RANGE,
  isFocused = false,
  onOpenFocus,
  onCloseFocus,
  onRangeChange,
}: AltPegCohortHistoryChartProps = {}) {
  const { data, isLoading } = useStablecoinCharts();
  const { animProps, handleAnimationEnd, chartContainerRef, isChartReady, width, height } =
    useChartShell<HTMLDivElement>();

  const { chartData, pegKeys, totalNonUsd, pegCount, otherLabels } = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) {
      return {
        chartData: [] as ChartRow[],
        pegKeys: [] as string[],
        totalNonUsd: 0,
        pegCount: 0,
        otherLabels: [] as string[],
      };
    }

    const keySet = new Set<string>();
    for (const point of data) {
      for (const key of Object.keys(point.totalCirculatingUSD)) {
        if (key !== "peggedUSD") keySet.add(key);
      }
    }

    const latest = data[data.length - 1]?.totalCirculatingUSD ?? {};
    const sorted = [...keySet].sort((left, right) => (latest[right] ?? 0) - (latest[left] ?? 0));
    const majorKeys: string[] = [];
    const minorKeys: string[] = [];

    for (const key of sorted) {
      if ((latest[key] ?? 0) >= OTHER_THRESHOLD) {
        majorKeys.push(key);
      } else {
        minorKeys.push(key);
      }
    }

    const hasOther = minorKeys.length > 0;
    const displayKeys = hasOther ? [...majorKeys, OTHER_KEY] : majorKeys;

    const points = data.map((point) => {
      const row: ChartRow = { ts: point.date * 1000 };
      for (const key of majorKeys) {
        row[key] = point.totalCirculatingUSD[key] ?? 0;
      }
      if (hasOther) {
        row[OTHER_KEY] = minorKeys.reduce(
          (sum, key) => sum + (point.totalCirculatingUSD[key] ?? 0),
          0,
        );
      }
      return row;
    });

    const total = sorted.reduce((sum, key) => sum + (latest[key] ?? 0), 0);

    return {
      chartData: points,
      pegKeys: displayKeys,
      totalNonUsd: total,
      pegCount: sorted.length,
      otherLabels: minorKeys.map((key) => pegKeyToLabel(key)),
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
    () =>
      computeChartYDomain(
        filteredData.map((row) => pegKeys.reduce((sum, key) => sum + (row[key] ?? 0), 0)),
        range === "all",
      ),
    [filteredData, pegKeys, range],
  );

  if (isLoading) {
    return (
      <Card className="pharos-card-shell">
        <CardHeader>
          <CardTitle as="h2" className="pharos-section-title">
            Alt-Peg Cohort Growth
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className={`${CHART_HEIGHT} w-full`} />
        </CardContent>
      </Card>
    );
  }

  const latestPoint = chartData[chartData.length - 1];
  const legendKeys = latestPoint ? pegKeys.filter((key) => (latestPoint[key] ?? 0) > 0) : pegKeys;

  return (
    <Card className="pharos-card-shell animate-in fade-in duration-200 motion-reduce:animate-none">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle as="h2" className="pharos-section-title">
            Alt-Peg Market Cap By Cohort
          </CardTitle>
          <p className="pharos-meta">
            {legendKeys.length} currently visible cohorts in this feed &middot; current alt-peg market cap:{" "}
            {formatCurrency(totalNonUsd, 1)}.
          </p>
          {coverageStartLabel ? (
            <p className="text-xs text-muted-foreground">
              Coverage starts {coverageStartLabel}. This uses the legacy provider-wide stablecoin-charts cohort feed;
              its live core-universe tail is withheld during the aggregate-policy transition to avoid a false drop.
              Cohorts below the current ${OTHER_THRESHOLD.toLocaleString("en-US")} latest-point threshold roll into
              Other.
            </p>
          ) : null}
          {isFocused ? (
            <p className="text-xs text-muted-foreground">
              Focused view &middot; shareable URL &middot; this chart measures cohort dollar market cap, not share of
              the total stablecoin market.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <TimeRangeButtons options={options} value={range} onChange={handleRangeChange} />
          {isFocused ? (
            <button
              type="button"
              onClick={onCloseFocus}
              aria-label="Return cohort chart to overview"
              className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 rounded-sm py-2 text-xs text-muted-foreground hover:text-foreground sm:min-h-0 sm:py-0"
            >
              <Minimize2 className="h-3.5 w-3.5" />
              Return cohort chart to overview
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onOpenFocus?.(range)}
              aria-label="Open large cohort chart"
              className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 rounded-sm py-2 text-xs text-muted-foreground hover:text-foreground sm:min-h-0 sm:py-0"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              Open large cohort chart
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {filteredData.length > 0 ? (
          <>
            <div className="pharos-chart-stage">
              <div
                ref={chartContainerRef}
                className={chartHeightClass}
                role="figure"
                aria-label={`Alt-peg market-cap-by-cohort chart covering ${pegCount} peg currencies`}
              >
                {isChartReady ? (
                  <AreaChart
                  width={width}
                  height={height}
                  data={filteredData}
                  margin={{ top: 5, right: 5, bottom: 20, left: 5 }}
                >
                  <defs>
                    {pegKeys.map((key) => {
                      const hex = pegKeyToHex(key);
                      return (
                        <linearGradient
                          key={key}
                          id={`altPegGrad-${pegKeyToCode(key)}`}
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop offset="5%" stopColor={hex} stopOpacity={0.3} />
                          <stop offset="95%" stopColor={hex} stopOpacity={0.05} />
                        </linearGradient>
                      );
                    })}
                  </defs>
                  <TimeGrid />
                  <TimeXAxis dataKey="ts" minTickGap={72} />
                  <MonoYAxis
                    tickFormatter={(value: number) => formatCurrency(value, 0)}
                    domain={yDomain}
                  />
                  <DateTooltip content={<CohortTooltip pegKeys={pegKeys} />} />
                  {pegKeys.map((key) => (
                    <Area
                      key={key}
                      type="monotone"
                      dataKey={key}
                      stackId="alt-pegs"
                      stroke={pegKeyToHex(key)}
                      fill={`url(#altPegGrad-${pegKeyToCode(key)})`}
                      strokeWidth={1.5}
                      onAnimationEnd={handleAnimationEnd}
                      {...animProps}
                    />
                  ))}
                </AreaChart>
              ) : (
                <Skeleton className="h-full w-full" />
              )}
              </div>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
              {legendKeys.map((key) => (
                <span key={key} className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: pegKeyToHex(key) }}
                  />
                  {pegKeyToLabel(key)}
                  {key === OTHER_KEY && otherLabels.length > 0 ? (
                    <span className="text-muted-foreground/70">({otherLabels.join(", ")})</span>
                  ) : null}
                </span>
              ))}
            </div>
          </>
        ) : (
          <div className={`flex ${chartHeightClass} items-center justify-center text-muted-foreground`}>
            No cohort-growth data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
