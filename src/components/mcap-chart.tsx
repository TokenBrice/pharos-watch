"use client";

import { useMemo } from "react";
import { AreaChart, Area, ReferenceDot } from "recharts";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter, type TimeRangeOption } from "@/hooks/use-time-range-filter";
import { cn } from "@/lib/utils";
import { formatCurrency, formatChartDate } from "@shared/lib/format";
import { CHART_BLUE } from "@/lib/chart-colors";
import { ChartSkeleton } from "@/components/chart-skeleton";
import {
  ChartAnnotationLegend,
  ChartAnnotationLines,
  DateTooltip,
  MonoYAxis,
  TimeGrid,
  TimeXAxis,
} from "@/components/chart-primitives";
import { buildAdaptiveMonthlyTicks, computeChartYDomain } from "@/lib/chart-utils";
import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";
import { useChartAnnotations } from "@/hooks/use-chart-annotations";

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
  stablecoinId: string;
  /**
   * Suppress the inline annotation legend (`<ChartAnnotationLegend>`) below
   * the card. Reference-line markers are still drawn. Used when the chart is
   * paired with `PegDeviationChart` in a side-by-side grid and a single
   * shared legend is rendered by the parent.
   */
  hideAnnotationLegend?: boolean;
  /**
   * When provided, the chart uses this range and hides its internal
   * time-range buttons. Used by `MarketDataSection` to drive both charts
   * from a single header-level selector.
   */
  controlledRange?: TimeRangeOption;
  /** Optional className for the outer `<Card>` (e.g. remove the accent border in grouped layouts). */
  cardClassName?: string;
  /** When true, drop the outer Card chrome so the chart can be embedded in a grouped panel. */
  embedded?: boolean;
}

export function McapChart({
  data,
  stablecoinId,
  hideAnnotationLegend = false,
  controlledRange,
  cardClassName,
  embedded = false,
}: McapChartProps) {
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

  const { range, setRange, filteredData, options } = useTimeRangeFilter(
    chartData,
    "ts",
    undefined,
    { externalRange: controlledRange },
  );

  const fromMs = filteredData[0]?.ts ?? null;
  const toMs = filteredData[filteredData.length - 1]?.ts ?? null;
  const { data: annotations } = useChartAnnotations(stablecoinId, fromMs, toMs);

  // Compute explicit monthly ticks for "all" range with adaptive spacing.
  // Cursor always snaps to the first January on or after the data start,
  // so year boundaries always fall on a tick regardless of step size.
  const xTicks = useMemo(() => {
    if (range !== "all" || filteredData.length === 0) return undefined;
    const first = filteredData[0].ts;
    const last = filteredData[filteredData.length - 1].ts;
    return buildAdaptiveMonthlyTicks(first, last);
  }, [range, filteredData]);

  const yDomain = useMemo(
    () => computeChartYDomain(filteredData.map((d) => d.mcap), range === "all"),
    [range, filteredData],
  );

  // Header readout: current mcap + 24h delta (anchor on the previous point — daily data).
  const readout = useMemo(() => {
    if (filteredData.length === 0) return null;
    const last = filteredData[filteredData.length - 1];
    const prev = filteredData.length >= 2 ? filteredData[filteredData.length - 2] : null;
    const delta = prev && prev.mcap > 0 ? (last.mcap - prev.mcap) / prev.mcap : null;
    return {
      mcap: last.mcap,
      ts: last.ts,
      deltaPct: delta == null ? null : delta * 100,
    };
  }, [filteredData]);

  const deltaColor = readout?.deltaPct == null
    ? "var(--color-muted-foreground)"
    : readout.deltaPct > 0
      ? "#22c55e"
      : readout.deltaPct < 0
        ? "#ef4444"
        : "var(--color-muted-foreground)";

  const header = (
    <div className="flex flex-row items-center justify-between gap-3">
      <div className="flex flex-col gap-0.5">
        <DetailSectionTitle>Market Cap</DetailSectionTitle>
        {readout ? (
          <div className="flex items-baseline gap-2 font-mono text-xs tabular-nums">
            <span className="text-foreground/85">{formatCurrency(readout.mcap)}</span>
            {readout.deltaPct != null ? (
              <>
                <span className="text-muted-foreground/60">·</span>
                <span style={{ color: deltaColor }}>
                  {readout.deltaPct > 0 ? "+" : ""}
                  {readout.deltaPct.toFixed(2)}% 24h
                </span>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {controlledRange ? null : (
        <TimeRangeButtons options={options} value={range} onChange={setRange} />
      )}
    </div>
  );

  const chartBody = filteredData.length > 0 ? (
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
          margin={{ top: 5, right: 12, bottom: range === "all" ? 32 : 20, left: 5 }}
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
          {readout ? (
            <ReferenceDot
              x={readout.ts}
              y={readout.mcap}
              r={3.5}
              fill={CHART_BLUE}
              stroke="var(--color-background)"
              strokeWidth={1.5}
              ifOverflow="extendDomain"
            />
          ) : null}
          <ChartAnnotationLines annotations={annotations} numbered />
        </AreaChart>
      ) : (
        <ChartSkeleton className="h-full w-full" />
      )}
    </div>
  ) : (
    <div className="flex h-[250px] sm:h-[350px] items-center justify-center text-muted-foreground">
      No market cap data available
    </div>
  );

  if (embedded) {
    return (
      <div className={cn("animate-in fade-in duration-300", cardClassName)}>
        <div className="px-4 pt-4 sm:px-6 sm:pt-6">{header}</div>
        <div className="px-2 pb-4 pt-3 sm:px-4 sm:pb-6">{chartBody}</div>
        {!hideAnnotationLegend && annotations.length > 0 ? (
          <div className="px-4 pb-4 sm:px-6 sm:pb-6">
            <ChartAnnotationLegend annotations={annotations} numbered />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Card className={cn("rounded-xl border-l-[3px] border-l-blue-500 animate-in fade-in duration-300", cardClassName)}>
      <CardHeader>{header}</CardHeader>
      <CardContent>{chartBody}</CardContent>
      {!hideAnnotationLegend && annotations.length > 0 ? (
        <CardContent className="pt-0">
          <ChartAnnotationLegend annotations={annotations} numbered />
        </CardContent>
      ) : null}
    </Card>
  );
}
