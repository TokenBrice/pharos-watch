"use client";

import { useMemo } from "react";
import { LineChart, Line, ReferenceLine } from "recharts";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter, type TimeRangeOption } from "@/hooks/use-time-range-filter";
import { formatChartDate } from "@shared/lib/format";
import { CHART_BLUE, CHART_SLATE } from "@/lib/chart-colors";
import { ChartSkeleton } from "@/components/chart-skeleton";
import {
  ChartAnnotationLines,
  DateTooltip,
  MonoYAxis,
  TimeGrid,
  TimeXAxis,
} from "@/components/chart-primitives";
import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";
import { useChartAnnotations } from "@/hooks/use-chart-annotations";
import { DAY_MS } from "@/lib/constants";

function PegXTick({
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

function formatPriceTick(value: number): string {
  return `$${value.toFixed(value >= 10 ? 2 : 4)}`;
}

function formatTooltip(value: number): [string, string] {
  const deviationBps = Math.round((value - 1) * 10000);
  const sign = deviationBps > 0 ? "+" : "";
  return [`$${value.toFixed(6)} (${sign}${deviationBps} bps)`, "Price"];
}

interface PegDeviationChartProps {
  data: SupplyHistoryPoint[];
  pegCurrency?: string | null;
  stablecoinId: string;
}

/**
 * Continuous USD-price line for USD-pegged coins with a $1 reference line.
 * Non-USD pegs need FX adjustment so the chart is hidden for them (returns null).
 */
export function PegDeviationChart({ data, pegCurrency, stablecoinId }: PegDeviationChartProps) {
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();

  const chartData = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];
    return data
      .filter((d) => d.price != null && d.price > 0)
      .map((d) => ({
        ts: d.date * 1000,
        price: d.price as number,
      }));
  }, [data]);

  const { range, setRange, filteredData, options } = useTimeRangeFilter(chartData, "ts");

  const fromMs = filteredData[0]?.ts ?? null;
  const toMs = filteredData[filteredData.length - 1]?.ts ?? null;
  const { data: annotations } = useChartAnnotations(stablecoinId, fromMs, toMs);

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
    if (step > 1 && d.getMonth() !== 0) {
      d.setFullYear(d.getFullYear() + 1, 0, 1);
    }
    while (d.getTime() <= last) {
      ticks.push(d.getTime());
      d.setMonth(d.getMonth() + step);
    }
    return ticks;
  }, [range, filteredData]);

  const yDomain = useMemo<[number, number]>(() => {
    if (filteredData.length === 0) return [0.95, 1.05];
    let min = Infinity;
    let max = -Infinity;
    for (const d of filteredData) {
      if (d.price < min) min = d.price;
      if (d.price > max) max = d.price;
    }
    // Always include the peg target in the visible window.
    min = Math.min(min, 1);
    max = Math.max(max, 1);
    const span = max - min;
    const pad = Math.max(span * 0.1, 0.001);
    return [min - pad, max + pad];
  }, [filteredData]);

  if (pegCurrency !== "USD") {
    return null;
  }

  return (
    <Card className="rounded-xl border-l-[3px] border-l-blue-500 animate-in fade-in duration-300">
      <CardHeader className="flex flex-row items-center justify-between">
        <DetailSectionTitle>Peg Deviation</DetailSectionTitle>
        <TimeRangeButtons options={options} value={range} onChange={setRange} />
      </CardHeader>
      <CardContent>
        {filteredData.length > 0 ? (
          <div
            ref={chartContainerRef}
            className="h-[250px] sm:h-[350px]"
            role="figure"
            aria-label={`Peg deviation chart showing ${filteredData.length} data points`}
          >
            {isChartReady ? (
              <LineChart
                width={width}
                height={height}
                data={filteredData}
                margin={{ top: 5, right: 5, bottom: range === "all" ? 32 : 20, left: 5 }}
              >
                <TimeGrid />
                <TimeXAxis
                  dataKey="ts"
                  ticks={xTicks}
                  interval={range === "all" ? 0 : "preserveStartEnd"}
                  tick={<PegXTick range={range} />}
                  height={range === "all" ? 44 : 30}
                />
                <MonoYAxis tickFormatter={formatPriceTick} domain={yDomain} />
                <ReferenceLine y={1} stroke={CHART_SLATE} strokeDasharray="4 4" />
                <DateTooltip formatter={(value) => formatTooltip(Number(value))} />
                <Line
                  type="monotone"
                  dataKey="price"
                  stroke={CHART_BLUE}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <ChartAnnotationLines annotations={annotations} />
              </LineChart>
            ) : (
              <ChartSkeleton className="h-full w-full" />
            )}
          </div>
        ) : (
          <div className="flex h-[250px] sm:h-[350px] items-center justify-center text-muted-foreground">
            No price history available
          </div>
        )}
      </CardContent>
      {annotations.length > 0 ? (
        <ul className="sr-only" aria-label="Chart events">
          {annotations.map((a) => (
            <li key={`${a.ts}-${a.kind}`}>
              {new Date(a.ts).toLocaleDateString()}: {a.label}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
