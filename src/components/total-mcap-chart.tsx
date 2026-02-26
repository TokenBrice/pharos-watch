"use client";

import { useMemo } from "react";
import {
  ComposedChart,
  Area,
  Line,
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
import { CHART_BLUE, CHART_TEAL, RECHARTS_TOOLTIP_STYLES } from "@/lib/chart-colors";
import { useStablecoinCharts } from "@/hooks/use-stablecoin-charts";
import { useStabilityIndexDetail } from "@/hooks/use-stability-index";

export function TotalMcapChart() {
  const { data, isLoading } = useStablecoinCharts();
  const { data: psiData } = useStabilityIndexDetail();

  const chartData = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) return [];

    // Build sorted (oldest-first) mcap array
    const mcapPoints = data.map((point) => ({
      ts: point.date * 1000,
      total: Object.values(point.totalCirculatingUSD).reduce(
        (sum, v) => sum + (v ?? 0),
        0,
      ),
    }));

    // Build sorted (oldest-first) PSI array from history + current
    const psiPoints: { ts: number; score: number }[] = [];
    if (psiData?.history) {
      const reversed = [...psiData.history].reverse();
      for (const h of reversed) {
        psiPoints.push({ ts: h.date * 1000, score: h.score });
      }
    }
    if (psiData?.current) {
      psiPoints.push({ ts: psiData.current.computedAt * 1000, score: psiData.current.score });
    }

    // Merge both timestamp grids so every PSI data point is visible
    const tsSet = new Set(mcapPoints.map((p) => p.ts));
    for (const p of psiPoints) tsSet.add(p.ts);
    const allTs = [...tsSet].sort((a, b) => a - b);

    let mIdx = 0;
    let pIdx = 0;
    return allTs.map((ts) => {
      // Forward-fill mcap: advance to latest point at or before ts
      while (mIdx < mcapPoints.length - 1 && mcapPoints[mIdx + 1].ts <= ts) mIdx++;
      const total = mcapPoints[mIdx].ts <= ts ? mcapPoints[mIdx].total : undefined;

      // Forward-fill PSI: advance to latest point at or before ts
      while (pIdx < psiPoints.length - 1 && psiPoints[pIdx + 1].ts <= ts) pIdx++;
      const score =
        psiPoints.length > 0 && psiPoints[pIdx].ts <= ts
          ? psiPoints[pIdx].score
          : undefined;

      return { ts, total, score };
    });
  }, [data, psiData]);

  const { range, setRange, filteredData, options } = useTimeRangeFilter(chartData, "ts");

  const yDomain = useMemo((): [number, number | string] => {
    if (range === "all" || filteredData.length === 0) return [0, "auto"];
    const values = filteredData.map((d) => d.total).filter((v): v is number => v != null);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = (max - min) * 0.15 || max * 0.05;
    return [Math.max(0, min - padding), max + padding];
  }, [range, filteredData]);

  if (isLoading) {
    return (
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle as="h2">Stablecoin Pulse: Total Marketcap x Pharos Stability Index</CardTitle>
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
        <CardTitle as="h2">Stablecoin Pulse: Total Marketcap x Pharos Stability Index</CardTitle>
        <TimeRangeButtons options={options} value={range} onChange={setRange} />
      </CardHeader>
      <CardContent>
        {filteredData.length > 0 ? (
          <>
          <div className="flex flex-wrap gap-4 mb-4">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: CHART_BLUE }} />
              Market Cap
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: CHART_TEAL }} />
              Pharos Stability Index
            </div>
          </div>
          <div className="h-[250px] sm:h-[350px]" role="figure" aria-label={`Total stablecoin market cap and Pharos Stability Index chart showing ${filteredData.length} data points`}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={filteredData} margin={{ top: 5, right: 45, bottom: 20, left: 5 }}>
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
                yAxisId="mcap"
                tick={{ fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(val: number) => formatCurrency(val, 0)}
                domain={yDomain}
              />
              <YAxis
                yAxisId="psi"
                orientation="right"
                domain={[0, 100]}
                tick={{ fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(val: number) => String(val)}
              />
              <Tooltip
                formatter={(value, name) => {
                  if (name === "Market Cap") return [formatCurrency(Number(value)), "Market Cap"];
                  if (name === "PSI") {
                    if (value == null || isNaN(Number(value))) return null;
                    return [Number(value).toFixed(1), "Pharos Stability Index"];
                  }
                  return [String(value), String(name)];
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
              <Area
                yAxisId="mcap"
                type="monotone"
                dataKey="total"
                stroke={CHART_BLUE}
                fill="url(#mcapGradient)"
                strokeWidth={2}
                name="Market Cap"
              />
              <Line
                yAxisId="psi"
                type="monotone"
                dataKey="score"
                stroke={CHART_TEAL}
                strokeWidth={2}
                dot={false}
                connectNulls
                name="PSI"
              />
            </ComposedChart>
          </ResponsiveContainer>
          </div>
          </>
        ) : (
          <div className="flex h-[250px] sm:h-[350px] items-center justify-center text-muted-foreground">
            No market cap data available
          </div>
        )}
      </CardContent>
    </Card>
  );
}
