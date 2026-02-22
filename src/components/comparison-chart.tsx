"use client";

import { useMemo } from "react";
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
}

export function ComparisonChart({
  title,
  series,
  formatValue,
}: ComparisonChartProps) {
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
                    const match = series.find((s) => s.id === name);
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
        ) : (
          <div className="flex h-[300px] sm:h-[400px] items-center justify-center text-muted-foreground">
            No data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
