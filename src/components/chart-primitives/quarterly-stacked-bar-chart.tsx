"use client";

import type { ComponentProps, ReactElement, ReactNode } from "react";
import { Bar, ComposedChart, Tooltip } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { CategoricalXAxis, TimeGrid, MonoYAxis } from "@/components/chart-primitives/axes";

export interface QuarterlyStackedBarSeries {
  dataKey: string;
  color: string;
  fillOpacity: number;
  radius?: ComponentProps<typeof Bar>["radius"];
}

interface QuarterlyStackedBarChartProps<T extends object> {
  data: T[];
  series: ReadonlyArray<QuarterlyStackedBarSeries>;
  yAxis: ComponentProps<typeof MonoYAxis>;
  tooltipContent: ReactElement;
  ariaLabel: string;
  height: string;
  children?: ReactNode;
}

export function QuarterlyStackedBarChart<T extends object>({
  data,
  series,
  yAxis,
  tooltipContent,
  ariaLabel,
  height,
  children,
}: QuarterlyStackedBarChartProps<T>) {
  const { ref, ready, width, height: measuredHeight } = useChartContainerReady<HTMLDivElement>();

  return (
    <div ref={ref} className={height} role="figure" aria-label={ariaLabel}>
      {ready ? (
        <ComposedChart
          width={width}
          height={measuredHeight}
          data={data}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        >
          <TimeGrid strokeDasharray="3 3" />
          <CategoricalXAxis
            dataKey="quarter"
            tick={{
              fontSize: 11,
              fontFamily: "var(--font-mono, monospace)",
              fill: "var(--color-muted-foreground)",
            }}
            angle={-35}
            textAnchor="end"
            height={52}
            interval={Math.max(0, Math.floor(data.length / 8) - 1)}
          />
          <MonoYAxis
            tick={{
              fontSize: 11,
              fontFamily: "var(--font-mono, monospace)",
              fill: "var(--color-muted-foreground)",
            }}
            {...yAxis}
          />
          <Tooltip content={tooltipContent} cursor={{ fill: "currentColor", opacity: 0.05 }} />
          {series.map(({ dataKey, color, fillOpacity, radius }) => (
            <Bar
              key={dataKey}
              dataKey={dataKey}
              stackId="a"
              fill={color}
              fillOpacity={fillOpacity}
              {...(radius === undefined ? {} : { radius })}
            />
          ))}
          {children}
        </ComposedChart>
      ) : (
        <Skeleton className="h-full w-full" />
      )}
    </div>
  );
}
