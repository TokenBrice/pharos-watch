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
import { CHART_BLUE, RECHARTS_TOOLTIP_STYLES } from "@/lib/chart-colors";
import { useStablecoinCharts } from "@/hooks/use-stablecoin-charts";

export function TotalMcapChart() {
  const { data, isLoading } = useStablecoinCharts();

  const chartData = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];

    return data.map((point) => {
      const total = Object.values(point.totalCirculatingUSD).reduce(
        (sum, v) => sum + (v ?? 0),
        0
      );
      return {
        ts: point.date * 1000,
        total,
      };
    });
  }, [data]);

  const { range, setRange, filteredData, options } = useTimeRangeFilter(chartData, "ts");

  const yDomain = useMemo((): [number, number | string] => {
    if (range === "all" || filteredData.length === 0) return [0, "auto"];
    const values = filteredData.map((d) => d.total);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = (max - min) * 0.15 || max * 0.05;
    return [Math.max(0, min - padding), max + padding];
  }, [range, filteredData]);

  if (isLoading) {
    return (
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle as="h2">Total Stablecoin Market Cap</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[250px] sm:h-[350px] w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-2xl animate-in fade-in duration-300">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle as="h2">Total Stablecoin Market Cap</CardTitle>
        <TimeRangeButtons options={options} value={range} onChange={setRange} />
      </CardHeader>
      <CardContent>
        {filteredData.length > 0 ? (
          <div className="h-[250px] sm:h-[350px]" role="figure" aria-label={`Total stablecoin market cap chart showing ${filteredData.length} data points`}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={filteredData} margin={{ top: 5, right: 5, bottom: 20, left: 5 }}>
              <defs>
                <linearGradient id="mcapGradient" x1="0" y1="0" x2="0" y2="1">
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
                tickFormatter={(ts: number) =>
                  new Date(ts).toLocaleDateString("en-US", {
                    month: "short",
                    year: "2-digit",
                  })
                }
              />
              <YAxis
                tick={{ fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(val: number) => formatCurrency(val, 0)}
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
                dataKey="total"
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
