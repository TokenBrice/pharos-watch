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

interface SupplyChartProps {
  data: SupplyHistoryPoint[];
}

export function SupplyChart({ data }: SupplyChartProps) {
  const chartData = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];

    return data
      .filter((d) => d.circulatingUsd > 0)
      .map((d) => ({
        ts: d.date * 1000,
        supply: d.circulatingUsd,
      }));
  }, [data]);

  const { range, setRange, filteredData, options } = useTimeRangeFilter(chartData, "ts");

  return (
    <Card className="rounded-2xl border-l-[3px] border-l-blue-500">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle as="h2">Circulating Supply</CardTitle>
        <TimeRangeButtons options={options} value={range} onChange={setRange} />
      </CardHeader>
      <CardContent>
        {filteredData.length > 0 ? (
          <div className="h-[250px] sm:h-[350px]" role="figure" aria-label={`Circulating supply chart showing ${filteredData.length} data points`}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={filteredData} margin={{ top: 5, right: 5, bottom: 20, left: 5 }}>
              <defs>
                <linearGradient id="supplyGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_BLUE} stopOpacity={0.4} />
                  <stop offset="95%" stopColor={CHART_BLUE} stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tick={{ fontSize: 12 }}
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
                tick={{ fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(val: number) => formatCurrency(val, 0)}
              />
              <Tooltip
                formatter={(value) => [formatCurrency(Number(value)), "Supply"]}
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
                dataKey="supply"
                stroke={CHART_BLUE}
                fill="url(#supplyGradient)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-[250px] sm:h-[350px] items-center justify-center text-muted-foreground">
            No supply data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
