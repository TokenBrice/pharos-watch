"use client";

import type { ReactNode } from "react";
import { AreaChart, LineChart } from "recharts";
import { TimeGrid, TimeXAxis } from "@/components/chart-primitives/axes";
import type { ChartDataTableColumn } from "@/components/chart-primitives/data-table";
import { ChartFigure } from "@/components/chart-primitives/figure";
import { MarketDataXTick } from "@/components/chart-primitives/market-data-x-tick";
import { ChartCardShell } from "@/components/chart-primitives/shell";
import { CHART_HEIGHT } from "@/lib/chart-colors";
import { useMarketDataChartFrame, type MarketDataTimePoint } from "./use-market-data-chart-window";

type MarketDataChartFigureProps<T extends MarketDataTimePoint> = {
  cardClassName?: string; chartData?: T[]; children: ReactNode; columns: ReadonlyArray<ChartDataTableColumn<T>>;
  embedded?: boolean; emptyMessage: string; frame: ReturnType<typeof useMarketDataChartFrame<T>>; header: ReactNode;
  beforeAxes?: ReactNode; label: string; variant: "area" | "line";
};

export function MarketDataChartFigure<T extends MarketDataTimePoint>({
  cardClassName, chartData, children, columns, embedded = false, emptyMessage, frame, header,
  beforeAxes, label, variant,
}: MarketDataChartFigureProps<T>) {
  const { chartContainerRef, crosshair, isChartReady, range, visibleData, xTicks } = frame;
  const RechartsChart = variant === "area" ? AreaChart : LineChart;
  const framedChart = (
    <RechartsChart
      width={frame.width} height={frame.height} data={chartData ?? visibleData} margin={frame.margin}
      onMouseMove={frame.handleMouseMove} onMouseLeave={frame.handleMouseLeave}
    >
      {beforeAxes}
      <TimeGrid />
      <TimeXAxis dataKey="ts" ticks={xTicks} interval={range === "all" ? 0 : "preserveStartEnd"}
        tick={<MarketDataXTick range={range} />} height={range === "all" ? 44 : 30} />
      {children}
    </RechartsChart>
  );

  const body = (
    <ChartFigure
      data={visibleData} columns={columns}
      caption={(rows, truncated, total) => truncated
        ? `${label} history — most recent ${rows.length} of ${total} data points`
        : `${label} history — ${total} data points`}
      ariaLabel={`${label} chart showing ${visibleData.length} data points`} emptyMessage={emptyMessage}
      heightClassName={CHART_HEIGHT} containerRef={chartContainerRef} isReady={isChartReady}
      crosshair={crosshair} renderChart={() => framedChart}
    />
  );

  return <ChartCardShell embedded={embedded} className={cardClassName} header={header} body={body} />;
}
