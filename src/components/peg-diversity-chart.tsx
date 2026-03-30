"use client";

import { useCallback, useMemo, useState } from "react";
import { CHART_DRAW_IN, CHART_NO_ANIM } from "@/lib/chart-animation";
import { AreaChart, Area } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { formatCurrency, formatChartDate } from "@shared/lib/format";
import { useStablecoinCharts } from "@/hooks/api-hooks";
import { PEG_CHART_COLORS } from "@shared/lib/classification";
import { CHART_HEIGHT } from "@/lib/chart-colors";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives";
import { computeChartYDomain } from "@/lib/chart-utils";

function pegKeyToCode(key: string): string {
  return key.replace(/^pegged/, "");
}

const OTHER_HEX = "#64748b";

function pegKeyToHex(key: string): string {
  if (key === "peggedOther") return OTHER_HEX;
  return PEG_CHART_COLORS[pegKeyToCode(key)]?.hex ?? "#64748b";
}

function pegKeyToLabel(key: string): string {
  if (key === "peggedOther") return "Other";
  const code = pegKeyToCode(key);
  return PEG_CHART_COLORS[code]?.label ?? code;
}

interface PegTooltipProps {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number; color: string }>;
  label?: number;
  pegKeys: string[];
}

function PegTooltip({ active, payload, label, pegKeys }: PegTooltipProps) {
  if (!payload?.length || !label) return null;

  // Show in reverse order (top of stack first)
  const items = [...pegKeys]
    .reverse()
    .map((key) => {
      const entry = payload.find((p) => p.dataKey === key);
      if (!entry || !entry.value) return null;
      return { key, value: entry.value, color: pegKeyToHex(key) };
    })
    .filter(Boolean) as Array<{ key: string; value: number; color: string }>;

  if (items.length === 0) return null;

  const total = items.reduce((sum, i) => sum + i.value, 0);

  return (
    <PharosChartTooltip active={active}>
      <TooltipLabel>{formatChartDate(label, "long")}</TooltipLabel>
      {items.map((item) => (
        <TooltipRow key={item.key} color={item.color} label={pegKeyToLabel(item.key)} value={formatCurrency(item.value)} />
      ))}
      <div className="border-t border-border/50 mt-1.5 pt-1.5">
        <TooltipRow label="Total" value={formatCurrency(total)} bold />
      </div>
    </PharosChartTooltip>
  );
}

export function PegDiversityChart() {
  const { data, isLoading } = useStablecoinCharts();
  const [shouldAnimate, setShouldAnimate] = useState(true);
  const animProps = shouldAnimate ? CHART_DRAW_IN : CHART_NO_ANIM;
  const handleAnimationEnd = useCallback(() => {
    setShouldAnimate(false);
  }, []);
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();

  const OTHER_KEY = "peggedOther";
  const OTHER_THRESHOLD = 5_000_000;

  const { chartData, pegKeys, totalNonUsd, pegCount, otherLabels } = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return { chartData: [], pegKeys: [], totalNonUsd: 0, pegCount: 0, otherLabels: [] as string[] };

    // Discover all non-USD peg keys
    const keySet = new Set<string>();
    for (const point of data) {
      for (const key of Object.keys(point.totalCirculatingUSD)) {
        if (key !== "peggedUSD") keySet.add(key);
      }
    }

    // Sort by latest mcap descending (largest at bottom for visual stability)
    const latest = data[data.length - 1]!.totalCirculatingUSD;
    const sorted = [...keySet].sort((a, b) => (latest[b] ?? 0) - (latest[a] ?? 0));

    // Split into major (≥$5M) and minor (<$5M) currencies
    const majorKeys: string[] = [];
    const minorKeys: string[] = [];
    for (const key of sorted) {
      if ((latest[key] ?? 0) >= OTHER_THRESHOLD) {
        majorKeys.push(key);
      } else {
        minorKeys.push(key);
      }
    }

    // Merge minor currencies into "Other" if there are any
    const hasOther = minorKeys.length > 0;
    const displayKeys = hasOther ? [...majorKeys, OTHER_KEY] : majorKeys;

    // Build chart points
    const points = data.map((point) => {
      const row: Record<string, number> = { ts: point.date * 1000 };
      for (const key of majorKeys) {
        row[key] = point.totalCirculatingUSD[key] ?? 0;
      }
      if (hasOther) {
        let otherSum = 0;
        for (const key of minorKeys) {
          otherSum += point.totalCirculatingUSD[key] ?? 0;
        }
        row[OTHER_KEY] = otherSum;
      }
      return row;
    });

    // Compute stats from latest point
    let total = 0;
    for (const key of sorted) {
      total += latest[key] ?? 0;
    }

    return {
      chartData: points,
      pegKeys: displayKeys,
      totalNonUsd: total,
      pegCount: sorted.length,
      otherLabels: minorKeys.map((k) => pegKeyToLabel(k)),
    };
  }, [data]);

  const { range, setRange, filteredData, options } = useTimeRangeFilter(chartData, "ts");

  const yDomain = useMemo(
    () => computeChartYDomain(
      filteredData.map((d) => pegKeys.reduce((sum, key) => sum + ((d[key] as number) ?? 0), 0)),
      range === "all",
    ),
    [range, filteredData, pegKeys],
  );

  if (isLoading) {
    return (
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle as="h2">Fiat-pegged, other than USD</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className={`${CHART_HEIGHT} w-full`} />
        </CardContent>
      </Card>
    );
  }

  // Legend items: only pegs present in latest data
  const latestPoint = chartData[chartData.length - 1];
  const legendKeys = latestPoint ? pegKeys.filter((k) => (latestPoint[k] ?? 0) > 0) : pegKeys;

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle as="h2">Fiat-pegged, other than USD</CardTitle>
          {pegCount > 0 && (
            <p className="text-sm text-muted-foreground mt-0.5">
              {pegCount} peg currencies &middot; {formatCurrency(totalNonUsd, 1)} non-USD
            </p>
          )}
        </div>
        <TimeRangeButtons options={options} value={range} onChange={setRange} />
      </CardHeader>
      <CardContent>
        {filteredData.length > 0 ? (
          <>
            <div
              ref={chartContainerRef}
              className={CHART_HEIGHT}
              role="figure"
              aria-label={`Fiat-pegged other than USD stacked area chart showing ${pegCount} peg currencies`}
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
                        <linearGradient key={key} id={`pegGrad-${pegKeyToCode(key)}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={hex} stopOpacity={0.3} />
                          <stop offset="95%" stopColor={hex} stopOpacity={0.05} />
                        </linearGradient>
                      );
                    })}
                  </defs>
                  <TimeGrid />
                  <TimeXAxis
                    dataKey="ts"
                    minTickGap={72}
                  />
                  <MonoYAxis
                    tickFormatter={(val: number) => formatCurrency(val, 0)}
                    domain={yDomain}
                  />
                  <DateTooltip content={<PegTooltip pegKeys={pegKeys} />} />
                  {pegKeys.map((key) => (
                    <Area
                      key={key}
                      type="monotone"
                      dataKey={key}
                      stackId="1"
                      stroke={pegKeyToHex(key)}
                      fill={`url(#pegGrad-${pegKeyToCode(key)})`}
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
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 text-xs text-muted-foreground">
              {legendKeys.map((key) => (
                <span key={key} className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: pegKeyToHex(key) }}
                  />
                  {pegKeyToLabel(key)}
                  {key === OTHER_KEY && otherLabels.length > 0 && (
                    <span className="text-muted-foreground/60">({otherLabels.join(", ")})</span>
                  )}
                </span>
              ))}
            </div>
          </>
        ) : (
          <div className={`flex ${CHART_HEIGHT} items-center justify-center text-muted-foreground`}>
            No peg diversity data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
