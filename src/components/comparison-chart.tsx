"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";
import { RECHARTS_TOOLTIP_STYLES } from "@/lib/chart-colors";
import { ChartSkeleton } from "@/components/chart-skeleton";

interface SeriesData {
  id: string;
  label: string;
  data: { ts: number; value: number }[];
  color: string;
}

interface ComparisonChartProps {
  title: string;
  series: SeriesData[];
  formatValue?: (v: number) => string;
  range?: TimeRangeOption;
  onRangeChange?: (range: TimeRangeOption) => void;
  normalizable?: boolean;
  isLoading?: boolean;
}

export function ComparisonChart({
  title,
  series,
  formatValue,
  range,
  onRangeChange,
  normalizable,
  isLoading,
}: ComparisonChartProps) {
  const [normalized, setNormalized] = useState(false);
  // Merge all series into a single array keyed by timestamp
  const mergedData = useMemo(() => {
    const tsMap = new Map<number, Record<string, number>>();

    for (const s of series) {
      for (const d of s.data) {
        let entry = tsMap.get(d.ts);
        if (!entry) {
          entry = { ts: d.ts };
          tsMap.set(d.ts, entry);
        }
        entry[s.id] = d.value;
      }
    }

    return Array.from(tsMap.values()).sort((a, b) => a.ts - b.ts);
  }, [series]);

  const { range: localRange, setRange: setLocalRange, filteredData, options } = useTimeRangeFilter(
    mergedData,
    "ts"
  );

  // Support controlled range from parent
  const activeRange = range ?? localRange;
  const handleRangeChange = useCallback((r: TimeRangeOption) => {
    setLocalRange(r);
    onRangeChange?.(r);
  }, [setLocalRange, onRangeChange]);

  // Sync external range prop into local state
  // eslint-disable-next-line react-hooks/exhaustive-deps -- localRange intentionally omitted to avoid infinite loop
  useEffect(() => {
    if (range != null && range !== localRange) {
      setLocalRange(range);
    }
  }, [range]);

  // Normalize: percent change from first available value per series
  const displayData = useMemo(() => {
    if (!normalized || filteredData.length === 0) return filteredData;
    const firstValues: Record<string, number> = {};
    for (const s of series) {
      for (const row of filteredData) {
        const val = row[s.id];
        if (typeof val === "number" && val > 0) {
          firstValues[s.id] = val;
          break;
        }
      }
    }
    return filteredData.map((row) => {
      const norm: Record<string, number> = { ts: row.ts };
      for (const s of series) {
        const val = row[s.id];
        const first = firstValues[s.id];
        if (typeof val === "number" && first) {
          norm[s.id] = ((val / first) - 1) * 100;
        }
      }
      return norm;
    });
  }, [normalized, filteredData, series]);

  // Determine XAxis date format based on selected range
  const formatTimestamp = useCallback((ts: number) => {
    const d = new Date(ts);
    if (activeRange === "7d" || activeRange === "30d") {
      return d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
    }
    return d.toLocaleDateString("en-US", {
      month: "short",
      year: "2-digit",
    });
  }, [activeRange]);

  const defaultFormat = (v: number) => v.toLocaleString();
  const valueFormatter = formatValue ?? defaultFormat;
  const activeFormatter = normalized
    ? (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`
    : valueFormatter;

  return (
    <Card className="rounded-xl">
      <CardHeader className="flex flex-row items-center justify-between gap-2 flex-wrap">
        <CardTitle as="h2">{title}</CardTitle>
        <div className="flex items-center gap-2">
          {normalizable && (
            <div className="flex gap-1">
              <button
                onClick={() => setNormalized(false)}
                aria-pressed={!normalized}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none ${
                  !normalized
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                Absolute
              </button>
              <button
                onClick={() => setNormalized(true)}
                aria-pressed={normalized}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none ${
                  normalized
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                Normalized %
              </button>
            </div>
          )}
          <TimeRangeButtons options={options} value={activeRange} onChange={handleRangeChange} />
        </div>
      </CardHeader>
      <CardContent>
        {series.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1">
            {series.map((s) => (
              <div key={s.id} className="flex items-center gap-1.5 text-sm">
                <span
                  className="inline-block h-0.5 w-4 rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                <span className="text-muted-foreground">{s.label}</span>
              </div>
            ))}
          </div>
        )}
        {displayData.length > 0 ? (
          <div
            className="h-[300px] sm:h-[400px]"
            role="figure"
            aria-label={`${title} comparison chart with ${series.length} series`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={displayData}
                margin={{ top: 5, right: 5, bottom: 20, left: 5 }}
              >
                <XAxis
                  dataKey="ts"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={formatTimestamp}
                />
                <YAxis
                  tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={activeFormatter}
                />
                <Tooltip
                  formatter={(value: number | string | (number | string)[] | undefined, name: string | number | undefined) => {
                    const match = series.find((s) => s.id === name);
                    return [activeFormatter(Number(value)), match?.label ?? String(name ?? "")];
                  }}
                  labelFormatter={(label) =>
                    new Date(Number(label)).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })
                  }
                  {...RECHARTS_TOOLTIP_STYLES}
                />
                {series.map((s) => (
                  <Line
                    key={s.id}
                    type="monotone"
                    dataKey={s.id}
                    name={s.id}
                    stroke={s.color}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : isLoading ? (
          <ChartSkeleton className="h-[300px] sm:h-[400px]" />
        ) : (
          <div className="flex h-[300px] sm:h-[400px] items-center justify-center text-muted-foreground">
            No data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
