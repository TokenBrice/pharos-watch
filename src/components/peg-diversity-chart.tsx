"use client";

import { useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { formatCurrency } from "@/lib/format";
import { useStablecoinCharts } from "@/hooks/use-stablecoin-charts";
import { PEG_CHART_COLORS } from "@/lib/classification";
import { CHART_HEIGHT } from "@/lib/chart-colors";

function pegKeyToCode(key: string): string {
  return key.replace(/^pegged/, "");
}

function pegKeyToHex(key: string): string {
  return PEG_CHART_COLORS[pegKeyToCode(key)]?.hex ?? "#64748b";
}

function pegKeyToLabel(key: string): string {
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
  if (!active || !payload?.length || !label) return null;

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
    <div className="rounded-lg border bg-card p-3 shadow-md text-sm">
      <p className="font-bold text-card-foreground mb-1.5">
        {new Date(label).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}
      </p>
      {items.map((item) => (
        <div key={item.key} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-card-foreground">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
              style={{ backgroundColor: item.color }}
            />
            {pegKeyToLabel(item.key)}
          </span>
          <span className="font-medium text-card-foreground tabular-nums">
            {formatCurrency(item.value)}
          </span>
        </div>
      ))}
      <div className="border-t mt-1.5 pt-1.5 flex items-center justify-between text-card-foreground font-semibold">
        <span>Total</span>
        <span className="tabular-nums">{formatCurrency(total)}</span>
      </div>
    </div>
  );
}

export function PegDiversityChart() {
  const { data, isLoading } = useStablecoinCharts();

  const { chartData, pegKeys, totalNonUsd, pegCount } = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0)
      return { chartData: [], pegKeys: [], totalNonUsd: 0, pegCount: 0 };

    // Discover all non-USD peg keys
    const keySet = new Set<string>();
    for (const point of data) {
      for (const key of Object.keys(point.totalCirculatingUSD)) {
        if (key !== "peggedUSD") keySet.add(key);
      }
    }

    // Sort by latest mcap descending (largest at bottom for visual stability)
    const latest = data[data.length - 1]!.totalCirculatingUSD;
    const sorted = [...keySet].sort(
      (a, b) => (latest[b] ?? 0) - (latest[a] ?? 0)
    );

    // Build chart points
    const points = data.map((point) => {
      const row: Record<string, number> = { ts: point.date * 1000 };
      for (const key of sorted) {
        row[key] = point.totalCirculatingUSD[key] ?? 0;
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
      pegKeys: sorted,
      totalNonUsd: total,
      pegCount: sorted.length,
    };
  }, [data]);

  const { range, setRange, filteredData, options } = useTimeRangeFilter(chartData, "ts");

  const yDomain = useMemo((): [number, number | string] => {
    if (range === "all" || filteredData.length === 0) return [0, "auto"];
    const totals = filteredData.map((d) =>
      pegKeys.reduce((sum, key) => sum + ((d[key] as number) ?? 0), 0)
    );
    const min = Math.min(...totals);
    const max = Math.max(...totals);
    const padding = (max - min) * 0.15 || max * 0.05;
    return [Math.max(0, min - padding), max + padding];
  }, [range, filteredData, pegKeys]);

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
  const legendKeys = latestPoint
    ? pegKeys.filter((k) => (latestPoint[k] ?? 0) > 0)
    : pegKeys;

  return (
    <Card className="rounded-xl">
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
              className={CHART_HEIGHT}
              role="figure"
              aria-label={`Fiat-pegged other than USD stacked area chart showing ${pegCount} peg currencies`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={filteredData}
                  margin={{ top: 5, right: 5, bottom: 20, left: 5 }}
                >
                  <defs>
                    {pegKeys.map((key) => {
                      const hex = pegKeyToHex(key);
                      return (
                        <linearGradient
                          key={key}
                          id={`pegGrad-${pegKeyToCode(key)}`}
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
                  <CartesianGrid strokeDasharray="3 3" opacity={0.06} stroke="var(--color-border)" />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    scale="time"
                    domain={["dataMin", "dataMax"]}
                    tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(ts: number) =>
                      new Date(ts).toLocaleDateString("en-US", {
                        month: "short",
                        year: "2-digit",
                      })
                    }
                  />
                  <YAxis
                    tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(val: number) => formatCurrency(val, 0)}
                    domain={yDomain}
                  />
                  <Tooltip
                    content={<PegTooltip pegKeys={pegKeys} />}
                  />
                  {pegKeys.map((key) => (
                    <Area
                      key={key}
                      type="monotone"
                      dataKey={key}
                      stackId="1"
                      stroke={pegKeyToHex(key)}
                      fill={`url(#pegGrad-${pegKeyToCode(key)})`}
                      strokeWidth={1.5}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 text-xs text-muted-foreground">
              {legendKeys.map((key) => (
                <span key={key} className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: pegKeyToHex(key) }}
                  />
                  {pegKeyToLabel(key)}
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
