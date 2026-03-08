"use client";

import { useMemo } from "react";
import { AreaChart, Area } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter, type TimeRangeOption } from "@/hooks/use-time-range-filter";
import { formatCurrency, formatChartDate } from "@shared/lib/format";
import { CHART_BLUE } from "@/lib/chart-colors";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives";
import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";
import { DAY_MS } from "@/lib/constants";

function McapXTick({
  x,
  y,
  payload,
  range,
}: {
  x?: number;
  y?: number;
  payload?: { value: number };
  range: TimeRangeOption;
}) {
  if (x === undefined || y === undefined || !payload) return null;
  const d = new Date(payload.value);
  const isJan = d.getMonth() === 0;

  if (range === "all") {
    const month = d.toLocaleDateString("en-US", { month: "short" });
    return (
      <g transform={`translate(${x},${y})`}>
        <text
          x={0}
          y={0}
          dy={12}
          textAnchor="middle"
          fontSize={11}
          fontFamily="var(--font-mono, monospace)"
          fill={isJan ? "var(--color-foreground)" : "var(--color-muted-foreground)"}
          fontWeight={isJan ? 600 : 400}
        >
          {month}
        </text>
        {isJan && (
          <text
            x={0}
            y={0}
            dy={23}
            textAnchor="middle"
            fontSize={10}
            fontFamily="var(--font-mono, monospace)"
            fill="var(--color-muted-foreground)"
          >
            {d.getFullYear()}
          </text>
        )}
      </g>
    );
  }

  const label =
    range === "7d" || range === "30d"
      ? formatChartDate(payload.value, "short")
      : formatChartDate(payload.value, "compact");

  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={0}
        dy={12}
        textAnchor="middle"
        fontSize={12}
        fontFamily="var(--font-mono, monospace)"
        fill="var(--color-muted-foreground)"
      >
        {label}
      </text>
    </g>
  );
}

interface McapChartProps {
  data: SupplyHistoryPoint[];
  isLoading?: boolean;
}

export function McapChart({ data, isLoading }: McapChartProps) {
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();
  const chartData = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];

    return data
      .filter((d) => d.circulatingUsd > 0)
      .map((d) => ({
        ts: d.date * 1000,
        mcap: d.circulatingUsd,
      }));
  }, [data]);

  const { range, setRange, filteredData, options } = useTimeRangeFilter(chartData, "ts");

  // Compute explicit monthly ticks for "all" range with adaptive spacing.
  // Cursor always snaps to the first January on or after the data start,
  // so year boundaries always fall on a tick regardless of step size.
  const xTicks = useMemo(() => {
    if (range !== "all" || filteredData.length === 0) return undefined;
    const first = filteredData[0].ts;
    const last = filteredData[filteredData.length - 1].ts;
    const spanDays = (last - first) / DAY_MS;

    let step = 1;
    if (spanDays > 4 * 365) step = 6;
    else if (spanDays > 2 * 365) step = 3;
    else if (spanDays > 365) step = 2;

    const ticks: number[] = [];
    const d = new Date(first);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    // For multi-year spans (step > 1), snap to the first January so year
    // boundaries always land on a tick. For < 1 year, start from the first
    // data month so the whole range gets labels.
    if (step > 1 && d.getMonth() !== 0) {
      d.setFullYear(d.getFullYear() + 1, 0, 1);
    }
    while (d.getTime() <= last) {
      ticks.push(d.getTime());
      d.setMonth(d.getMonth() + step);
    }
    return ticks;
  }, [range, filteredData]);

  const yDomain = useMemo((): [number, number | string] => {
    if (range === "all" || filteredData.length === 0) return [0, "auto"];
    const values = filteredData.map((d) => d.mcap);
    const min = values.reduce((m, v) => Math.min(m, v), Infinity);
    const max = values.reduce((m, v) => Math.max(m, v), -Infinity);
    const padding = (max - min) * 0.15 || max * 0.05;
    return [Math.max(0, min - padding), max + padding];
  }, [range, filteredData]);

  return (
    <Card className="rounded-xl border-l-[3px] border-l-blue-500 animate-in fade-in duration-300">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle as="h2">Market Cap</CardTitle>
        <TimeRangeButtons options={options} value={range} onChange={setRange} />
      </CardHeader>
      <CardContent>
        {filteredData.length > 0 ? (
          <div
            ref={chartContainerRef}
            className="h-[250px] sm:h-[350px]"
            role="figure"
            aria-label={`Market cap chart showing ${filteredData.length} data points`}
          >
            {isChartReady ? (
              <AreaChart
                width={width}
                height={height}
                data={filteredData}
                margin={{ top: 5, right: 5, bottom: range === "all" ? 32 : 20, left: 5 }}
              >
                <defs>
                  <linearGradient id="mcapGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={CHART_BLUE} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={CHART_BLUE} stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <TimeGrid />
                <TimeXAxis
                  dataKey="ts"
                  ticks={xTicks}
                  interval={range === "all" ? 0 : "preserveStartEnd"}
                  tick={<McapXTick range={range} />}
                  height={range === "all" ? 44 : 30}
                />
                <MonoYAxis
                  tickFormatter={(val: number) => formatCurrency(val)}
                  domain={yDomain}
                />
                <DateTooltip
                  formatter={(value) => [formatCurrency(Number(value)), "Market Cap"]}
                />
                <Area type="monotone" dataKey="mcap" stroke={CHART_BLUE} fill="url(#mcapGradient)" strokeWidth={2} />
              </AreaChart>
            ) : (
              <ChartSkeleton className="h-full w-full" />
            )}
          </div>
        ) : isLoading ? (
          <ChartSkeleton className="h-[250px] sm:h-[350px]" />
        ) : (
          <div className="flex h-[250px] sm:h-[350px] items-center justify-center text-muted-foreground">
            No market cap data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
