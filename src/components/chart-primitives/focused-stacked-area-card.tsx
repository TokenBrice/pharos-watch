"use client";

import { useMemo, type ReactElement, type ReactNode } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { Area, AreaChart } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useChartShell } from "@/hooks/use-chart-shell";
import { type TimeRangeOption, useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { CHART_HEIGHT } from "@/lib/chart-colors";
import { buildAdaptiveMonthlyTicks } from "@/lib/chart-utils";
import { formatRangeTickDate } from "@/lib/chart-time-range";
import { ChartAreaGradient, DateTooltip, MonoYAxis, TimeGrid, TimeXAxis, useNiceValueAxis } from "@/components/chart-primitives/axes";
import { ScreenReaderDataTable, type ChartDataTableColumn } from "@/components/chart-primitives/data-table";

export interface StackedAreaSeries {
  dataKey: string;
  color: string;
  gradientId: string;
  stackId: string;
  legend?: ReactNode;
  legendMarkerClassName?: string;
  handleAnimationEnd?: boolean;
}

interface FocusedStackedAreaCardProps<T extends Record<K, number>, K extends keyof T> {
  data: T[];
  tsKey: K;
  isLoading: boolean;
  title: ReactNode;
  loadingTitle: ReactNode;
  titleClassName?: string;
  subtitle?: ReactNode;
  coverageNote?: ReactNode;
  focusedNote?: ReactNode;
  initialRange: TimeRangeOption;
  rangeOptions: TimeRangeOption[];
  isFocused: boolean;
  onOpenFocus?: (range: TimeRangeOption) => void;
  onCloseFocus?: () => void;
  onRangeChange?: (range: TimeRangeOption) => void;
  openFocusLabel: string;
  closeFocusLabel: string;
  focusedHeightClassName: string;
  ariaLabel: string;
  emptyMessage: string;
  series: StackedAreaSeries[];
  tooltip: ReactElement;
  /** Value-axis domain; only the top is used, since a stacked area always starts at 0. */
  yDomain: (data: T[], range: TimeRangeOption) => [number, number | "auto"];
  yTickFormatter: (value: number) => string;
  tableColumns: ReadonlyArray<ChartDataTableColumn<T>>;
  tableCaption: (rows: ReadonlyArray<T>, truncated: boolean, total: number) => string;
  cardClassName: string;
  contentClassName?: string;
  legendClassName: string;
  /**
   * `false` renders the chart as an unframed hairline band (no card around the
   * chart stage) for pages that stack evidence bands; `cardClassName` is then
   * ignored. Defaults to the framed card.
   */
  framed?: boolean;
}

/** The unframed band: a top hairline and no surface, so the chart stage is the only frame. */
const UNFRAMED_CARD_CLASS = "rounded-none border-0 border-t border-border/50 bg-transparent py-5 shadow-none";

export function FocusedStackedAreaCard<T extends Record<K, number>, K extends keyof T>({
  data,
  tsKey,
  isLoading,
  title,
  loadingTitle,
  titleClassName,
  subtitle,
  coverageNote,
  focusedNote,
  initialRange,
  rangeOptions,
  isFocused,
  onOpenFocus,
  onCloseFocus,
  onRangeChange,
  openFocusLabel,
  closeFocusLabel,
  focusedHeightClassName,
  ariaLabel,
  emptyMessage,
  series,
  tooltip,
  yDomain,
  yTickFormatter,
  tableColumns,
  tableCaption,
  cardClassName,
  contentClassName,
  framed = true,
  legendClassName,
}: FocusedStackedAreaCardProps<T, K>) {
  const { animProps, handleAnimationEnd, chartContainerRef, isChartReady, width, height } =
    useChartShell<HTMLDivElement>();
  const { range, setRange, filteredData, options } = useTimeRangeFilter(data, tsKey, rangeOptions, {
    initialRange,
  });
  const chartHeightClass = isFocused ? focusedHeightClassName : CHART_HEIGHT;
  const domain = useMemo(() => yDomain(filteredData, range), [filteredData, range, yDomain]);
  // Recharts offsets a band above a null stack member by the partial sum, so
  // the missing cohort would read as a one-bucket collapse. Once a member is
  // unavailable, every later band of that stack is a gap too; the table and
  // tooltip keep the unmodified rows and still say "Unavailable".
  const chartData = useMemo(
    () =>
      filteredData.map((row) => {
        const copy: Record<string, unknown> = { ...(row as Record<string, unknown>) };
        const brokenStacks = new Set<string>();
        for (const item of series) {
          const value = (row as Record<string, unknown>)[item.dataKey];
          if (brokenStacks.has(item.stackId)) {
            copy[item.dataKey] = null;
          } else if (typeof value !== "number" || !Number.isFinite(value)) {
            brokenStacks.add(item.stackId);
            copy[item.dataKey] = null;
          }
        }
        return copy;
      }),
    [filteredData, series],
  );
  // An open ("auto") top resolves to the nice tick above the tallest drawn stack.
  const stackHeights = useMemo(
    () =>
      chartData.map((row) => {
        const stacks = new Map<string, number>();
        for (const item of series) {
          const value = row[item.dataKey];
          if (typeof value !== "number" || !Number.isFinite(value)) continue;
          const key = item.stackId;
          stacks.set(key, (stacks.get(key) ?? 0) + value);
        }
        return stacks.size > 0 ? Math.max(...stacks.values()) : null;
      }),
    [chartData, series],
  );
  // Month-oriented labels need a matching monthly tick cadence; day-scale
  // ranges label the auto time ticks with the day.
  const xTicks = useMemo(() => {
    if (range === "7d" || range === "30d" || filteredData.length === 0) return undefined;
    const first = filteredData[0][tsKey];
    const last = filteredData[filteredData.length - 1][tsKey];
    return buildAdaptiveMonthlyTicks(first, last).filter((tick) => tick >= first);
  }, [filteredData, range, tsKey]);
  const autoAxis = useNiceValueAxis(stackHeights);
  // Stacked areas fill from zero and Recharts widens a raised floor back to 0
  // with no ticks below it, so the floor is pinned at 0 and the baseline labelled.
  const valueAxis = domain[1] === "auto" && autoAxis.domain ? autoAxis : { domain: [0, domain[1]] as [number, number | "auto"] };

  const handleRangeChange = (nextRange: TimeRangeOption) => {
    setRange(nextRange);
    onRangeChange?.(nextRange);
  };

  if (isLoading) {
    return (
      <Card className={framed ? "pharos-card-shell" : UNFRAMED_CARD_CLASS}>
        <CardHeader className={framed ? undefined : "px-0"}>
          <CardTitle as="h2" className={titleClassName}>{loadingTitle}</CardTitle>
        </CardHeader>
        <CardContent className={framed ? undefined : "px-0"}>
          <Skeleton className={`${CHART_HEIGHT} w-full`} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={framed ? cardClassName : UNFRAMED_CARD_CLASS}>
      <CardHeader className={framed ? "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between" : "flex flex-col gap-3 px-0 sm:flex-row sm:items-start sm:justify-between"}>
        <div className="space-y-1">
          <CardTitle as="h2" className={titleClassName}>{title}</CardTitle>
          {subtitle}
          {coverageNote}
          {isFocused ? focusedNote : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="w-full min-w-0 sm:w-auto">
            <TimeRangeButtons options={options} value={range} onChange={handleRangeChange} />
          </div>
          {isFocused ? (
            <button
              type="button"
              onClick={onCloseFocus}
              aria-label={closeFocusLabel}
              className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 rounded-sm py-2 text-xs text-muted-foreground hover:text-foreground sm:min-h-0 sm:py-0"
            >
              <Minimize2 className="h-3.5 w-3.5" />
              {closeFocusLabel}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onOpenFocus?.(range)}
              aria-label={openFocusLabel}
              className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 rounded-sm py-2 text-xs text-muted-foreground hover:text-foreground sm:min-h-0 sm:py-0"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              {openFocusLabel}
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent className={framed ? contentClassName : cn(contentClassName, "px-0")}>
        {filteredData.length > 0 ? (
          <>
            <div className="pharos-chart-stage">
              <div
                ref={chartContainerRef}
                className={chartHeightClass}
                role="figure"
                aria-label={ariaLabel}
              >
                <ScreenReaderDataTable data={filteredData} columns={tableColumns} caption={tableCaption} />
                {isChartReady ? (
                  <AreaChart
                    width={width}
                    height={height}
                    data={chartData}
                    margin={{ top: 5, right: 5, bottom: 20, left: 5 }}
                  >
                    <defs>
                      {series.map((item) => (
                        <ChartAreaGradient key={item.dataKey} id={item.gradientId} color={item.color} />
                      ))}
                    </defs>
                    <TimeGrid />
                    <TimeXAxis
                      dataKey={String(tsKey)}
                      ticks={xTicks}
                      minTickGap={72}
                      tickFormatter={(value) => formatRangeTickDate(Number(value), range)}
                    />
                    <MonoYAxis tickFormatter={yTickFormatter} {...valueAxis} />
                    <DateTooltip content={tooltip} />
                    {series.map((item) => (
                      <Area
                        key={item.dataKey}
                        type="monotone"
                        dataKey={item.dataKey}
                        stackId={item.stackId}
                        stroke={item.color}
                        fill={`url(#${item.gradientId})`}
                        strokeWidth={1.5}
                        onAnimationEnd={item.handleAnimationEnd ? handleAnimationEnd : undefined}
                        {...animProps}
                      />
                    ))}
                  </AreaChart>
                ) : (
                  <Skeleton className="h-full w-full" />
                )}
              </div>
            </div>
            <div className={legendClassName}>
              {series.map((item) => item.legend == null ? null : (
                <span key={item.dataKey} className="flex items-center gap-1.5">
                  <span
                    className={item.legendMarkerClassName ?? "inline-block h-2.5 w-2.5 rounded-full"}
                    style={{ backgroundColor: item.color }}
                  />
                  {item.legend}
                </span>
              ))}
            </div>
          </>
        ) : (
          <div className={`flex ${chartHeightClass} items-center justify-center text-muted-foreground`}>
            {emptyMessage}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
