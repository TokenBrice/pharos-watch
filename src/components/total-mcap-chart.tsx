"use client";

import { useMemo, useState } from "react";
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
import { formatCurrency } from "@/lib/format";
import { useStablecoinCharts } from "@/hooks/use-stablecoin-charts";

export function TotalMcapChart() {
  const { data, isLoading } = useStablecoinCharts();
  const [range, setRange] = useState<"7d" | "30d" | "90d" | "1y" | "all">("all");

  const chartData = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];

    return data.map((point) => {
      const total = Object.values(point.totalCirculatingUSD).reduce(
        (sum, v) => sum + (v ?? 0),
        0
      );
      return {
        ts: point.date * 1000,
        date: new Date(point.date * 1000).toLocaleDateString("en-US", {
          month: "short",
          year: "2-digit",
        }),
        total,
      };
    });
  }, [data]);

  const filteredData = useMemo(() => {
    if (range === "all" || chartData.length === 0) return chartData;
    const latest = chartData[chartData.length - 1]?.ts ?? 0;
    const ms: Record<string, number> = {
      "7d": 7 * 86400000,
      "30d": 30 * 86400000,
      "90d": 90 * 86400000,
      "1y": 365 * 86400000,
    };
    return chartData.filter((d) => d.ts >= latest - ms[range]);
  }, [chartData, range]);

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
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle as="h2">Total Stablecoin Market Cap</CardTitle>
        <div className="flex gap-1">
          {(["7d", "30d", "90d", "1y", "all"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              aria-pressed={range === r}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none ${
                range === r
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              {r === "all" ? "All" : r.toUpperCase()}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {filteredData.length > 0 ? (
          <div className="h-[250px] sm:h-[350px]" role="figure" aria-label={`Total stablecoin market cap chart showing ${filteredData.length} data points`}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={filteredData}>
              <defs>
                <linearGradient id="mcapGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.05} />
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
                contentStyle={{ backgroundColor: "var(--color-card)", borderColor: "var(--color-border)", borderRadius: "var(--radius-lg, 0.5rem)" }}
                labelStyle={{ fontWeight: "bold", color: "var(--color-card-foreground)" }}
                itemStyle={{ color: "var(--color-card-foreground)" }}
              />
              <Area
                type="monotone"
                dataKey="total"
                stroke="#3b82f6"
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
