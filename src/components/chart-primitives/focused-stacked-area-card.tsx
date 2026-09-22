"use client";

import { useMemo, type ReactElement, type ReactNode } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { Area, AreaChart } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useChartShell } from "@/hooks/use-chart-shell";
import { type TimeRangeOption, useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { CHART_HEIGHT } from "@/lib/chart-colors";
import { ChartAreaGradient, DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives/axes";
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

interface FocusedStackedAreaCardProps<T extends Record<keyof T, number>> {
  data: T[];
  tsKey: keyof T;
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
  yDomain: (data: T[], range: TimeRangeOption) => [number, number | "auto"];
  yTickFormatter: (value: number) => string;
  tableColumns: ReadonlyArray<ChartDataTableColumn<T>>;
  tableCaption: (rows: ReadonlyArray<T>, truncated: boolean, total: number) => string;
  cardClassName: string;
  contentClassName?: string;
  legendClassName: string;
}

export function FocusedStackedAreaCard<T extends Record<keyof T, number>>({
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
  legendClassName,
}: FocusedStackedAreaCardProps<T>) {
  const { animProps, handleAnimationEnd, chartContainerRef, isChartReady, width, height } =
    useChartShell<HTMLDivElement>();
  const { range, setRange, filteredData, options } = useTimeRangeFilter(data, tsKey, rangeOptions, {
    initialRange,
  });
  const chartHeightClass = isFocused ? focusedHeightClassName : CHART_HEIGHT;
  const domain = useMemo(() => yDomain(filteredData, range), [filteredData, range, yDomain]);

  const handleRangeChange = (nextRange: TimeRangeOption) => {
    setRange(nextRange);
    onRangeChange?.(nextRange);
  };

  if (isLoading) {
    return (
      <Card className="pharos-card-shell">
        <CardHeader>
          <CardTitle as="h2" className={titleClassName}>{loadingTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className={`${CHART_HEIGHT} w-full`} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cardClassName}>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle as="h2" className={titleClassName}>{title}</CardTitle>
          {subtitle}
          {coverageNote}
          {isFocused ? focusedNote : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <TimeRangeButtons options={options} value={range} onChange={handleRangeChange} />
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
      <CardContent className={contentClassName}>
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
                    data={filteredData}
                    margin={{ top: 5, right: 5, bottom: 20, left: 5 }}
                  >
                    <defs>
                      {series.map((item) => (
                        <ChartAreaGradient key={item.dataKey} id={item.gradientId} color={item.color} />
                      ))}
                    </defs>
                    <TimeGrid />
                    <TimeXAxis dataKey={String(tsKey)} minTickGap={72} />
                    <MonoYAxis tickFormatter={yTickFormatter} domain={domain} />
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
