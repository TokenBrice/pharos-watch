"use client";

import { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { RECHARTS_TOOLTIP_STYLES } from "@/lib/chart-colors";

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
  normalized?: boolean;
  referenceLine?: number;
}

export function ComparisonChart({
  title,
  series,
  formatValue,
  normalized,
  referenceLine,
}: ComparisonChartProps) {
  // Normalize series if requested (first data point = 100)
  const processedSeries = useMemo(() => {
    if (!normalized) return series;
    return series.map((s) => {
      const baseValue = s.data[0]?.value;
      if (!baseValue || baseValue === 0) return s;
      return {
        ...s,
        data: s.data.map((d) => ({
          ts: d.ts,
          value: (d.value / baseValue) * 100,
        })),
      };
    });
  }, [series, normalized]);

  // Merge all series into a single array keyed by timestamp
  const mergedData = useMemo(() => {
    const tsMap = new Map<number, Record<string, number>>();

    for (const s of processedSeries) {
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
  }, [processedSeries]);

  const { range, setRange, filteredData, options } = useTimeRangeFilter(
    mergedData,
    "ts"
  );

  // Determine XAxis date format based on selected range
  const formatTimestamp = (ts: number) => {
    const d = new Date(ts);
    if (range === "7d" || range === "30d") {
      return d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
    }
    return d.toLocaleDateString("en-US", {
      month: "short",
      year: "2-digit",
    });
  };

  const defaultFormat = (v: number) => v.toLocaleString();
  const valueFormatter = formatValue ?? defaultFormat;

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle as="h2">{title}</CardTitle>
        <TimeRangeButtons options={options} value={range} onChange={setRange} />
      </CardHeader>
      <CardContent>
        {series.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1">
            {processedSeries.map((s) => (
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
        {filteredData.length > 0 ? (
          <div
            className="h-[300px] sm:h-[400px]"
            role="figure"
            aria-label={`${title} comparison chart with ${series.length} series`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={filteredData}
                margin={{ top: 5, right: 5, bottom: 20, left: 5 }}
              >
                <XAxis
                  dataKey="ts"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tick={{ fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={formatTimestamp}
                />
                <YAxis
                  tick={{ fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={valueFormatter}
                />
                <Tooltip
                  formatter={(value: number | string | (number | string)[] | undefined, name: string | number | undefined) => {
                    const match = processedSeries.find((s) => s.id === name);
                    return [valueFormatter(Number(value)), match?.label ?? String(name ?? "")];
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
                {referenceLine !== undefined && (
                  <ReferenceLine
                    y={referenceLine}
                    stroke="var(--color-muted-foreground)"
                    strokeDasharray="3 3"
                    strokeOpacity={0.5}
                  />
                )}
                {processedSeries.map((s) => (
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
        ) : (
          <div className="flex h-[300px] sm:h-[400px] items-center justify-center text-muted-foreground">
            No data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
