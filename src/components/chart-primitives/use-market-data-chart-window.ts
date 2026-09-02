"use client";

import { useMemo } from "react";
import { useChartAnnotations } from "@/hooks/use-chart-annotations";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { useTimeRangeFilter, type TimeRangeOption } from "@/hooks/use-time-range-filter";
import { buildAdaptiveMonthlyTicks } from "@/lib/chart-utils";
import { usePlotInsets, type ChartMargin } from "@/components/chart-primitives/axes";
import { useChartSyncHandlers, useMarketDataChartSync } from "@/components/chart-primitives/sync";

export interface MarketDataTimePoint {
  ts: number;
}

export function useMarketDataChartFrame<T extends MarketDataTimePoint>({
  chartData, controlledRange, stablecoinId,
}: {
  chartData: T[]; controlledRange?: TimeRangeOption; stablecoinId: string;
}) {
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();
  const { range, setRange, filteredData, options } = useTimeRangeFilter(chartData, "ts", undefined, {
    externalRange: controlledRange,
  });
  const margin = useMemo(() => ({ top: 5, right: 12, bottom: range === "all" ? 32 : 20, left: 5 }), [range]);
  const chartWindow = useMarketDataChartWindow({ filteredData, margin, range, stablecoinId });
  const crosshair = chartWindow.sync
    ? {
        hoveredTs: chartWindow.sync.hoveredTs, domain: chartWindow.xDomain,
        plotInsetLeft: chartWindow.plotInsetLeft, plotInsetRight: chartWindow.plotInsetRight,
        plotInsetTop: chartWindow.plotInsetTop, plotInsetBottom: chartWindow.plotInsetBottom,
      }
    : null;

  return {
    chartContainerRef, crosshair, filteredData, height, isChartReady, margin, options, range, setRange, width,
    ...chartWindow,
  };
}

export function useMarketDataChartWindow<T extends MarketDataTimePoint>({
  filteredData,
  margin,
  range,
  stablecoinId,
}: {
  filteredData: T[];
  margin: ChartMargin;
  range: TimeRangeOption;
  stablecoinId: string;
}) {
  const sync = useMarketDataChartSync();
  const brushedRange = sync?.brushedRange ?? null;

  const visibleData = useMemo(() => {
    if (!brushedRange) return filteredData;
    const [lo, hi] = brushedRange;
    return filteredData.filter((d) => d.ts >= lo && d.ts <= hi);
  }, [filteredData, brushedRange]);

  const fromMs = visibleData[0]?.ts ?? null;
  const toMs = visibleData[visibleData.length - 1]?.ts ?? null;
  const { data: annotations } = useChartAnnotations(stablecoinId, fromMs, toMs);

  const xTicks = useMemo(() => {
    // Month-oriented labels need a matching monthly tick cadence. Letting
    // Recharts auto-generate ticks for 90d/1y produces several identical
    // "May '26"-style labels within one month, which then collide in the
    // side-by-side detail layout.
    if ((range === "7d" || range === "30d") || visibleData.length === 0) return undefined;
    const first = visibleData[0].ts;
    const last = visibleData[visibleData.length - 1].ts;
    return buildAdaptiveMonthlyTicks(first, last);
  }, [range, visibleData]);

  const xDomain = useMemo<readonly [number, number] | null>(() => {
    if (visibleData.length === 0) return null;
    return [visibleData[0].ts, visibleData[visibleData.length - 1].ts];
  }, [visibleData]);

  const plotInsets = usePlotInsets(margin);
  const syncHandlers = useChartSyncHandlers(sync);

  return {
    annotations,
    brushedRange,
    sync,
    visibleData,
    xDomain,
    xTicks,
    ...plotInsets,
    ...syncHandlers,
  };
}
