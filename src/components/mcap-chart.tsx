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
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import { formatCurrency } from "@/lib/format";
import { CHART_BLUE, RECHARTS_TOOLTIP_STYLES } from "@/lib/chart-colors";
import type { SupplyHistoryPoint } from "@/hooks/use-stablecoins";

interface McapChartProps {
  data: SupplyHistoryPoint[];
}

export function McapChart({ data }: McapChartProps) {
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

  const yDomain = useMemo((): [number, number | string] => {
    if (range === "all" || filteredData.length === 0) return [0, "auto"];
    const values = filteredData.map((d) => d.mcap);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = (max - min) * 0.15 || max * 0.05;
    return [Math.max(0, min - padding), max + padding];
  }, [range, filteredData]);

  return (
    <Card className="rounded-xl border-l-[3px] border-l-blue-500">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle as="h2">Market Cap</CardTitle>
        <TimeRangeButtons options={options} value={range} onChange={setRange} />
      </CardHeader>
      <CardContent>
        {filteredData.length > 0 ? (
          <div className="h-[250px] sm:h-[350px]" role="figure" aria-label={`Market cap chart showing ${filteredData.length} data points`}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={filteredData} margin={{ top: 5, right: 5, bottom: 20, left: 5 }}>
              <defs>
                <linearGradient id="mcapGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_BLUE} stopOpacity={0.2} />
                  <stop offset="95%" stopColor={CHART_BLUE} stopOpacity={0.02} />
                </linearGradient>
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
                tickFormatter={(ts: number) => {
                  const d = new Date(ts);
                  if (range === "7d" || range === "30d") {
                    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                  }
                  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
                }}
              />
              <YAxis
                tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(val: number) => formatCurrency(val)}
                domain={yDomain}
              />
              <Tooltip
                formatter={(value) => [formatCurrency(Number(value)), "Market Cap"]}
                labelFormatter={(label) =>
                  new Date(Number(label)).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                }
                {...RECHARTS_TOOLTIP_STYLES}
              />
              <Area
                type="monotone"
                dataKey="mcap"
                stroke={CHART_BLUE}
                fill="url(#mcapGradient)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-[250px] sm:h-[350px] items-center justify-center text-muted-foreground">
            No market cap data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
