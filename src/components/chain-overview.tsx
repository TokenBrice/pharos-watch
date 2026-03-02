"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { formatCurrency } from "@/lib/format";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { CHART_PALETTE, RECHARTS_TOOLTIP_STYLES } from "@/lib/chart-colors";
import type { StablecoinData } from "@/lib/types";

interface ChainOverviewProps {
  data: StablecoinData[] | undefined;
}

export function ChainOverview({ data }: ChainOverviewProps) {
  const chartData = useMemo(() => {
    if (!data) return [];

    const trackedIds = new Set(TRACKED_STABLECOINS.map((s) => s.id));
    const chainTotals: Record<string, number> = {};

    for (const coin of data) {
      if (!trackedIds.has(coin.id) || !coin.chainCirculating) continue;
      for (const [chain, info] of Object.entries(coin.chainCirculating)) {
        const value = info?.current ?? 0;
        if (value > 0) {
          chainTotals[chain] = (chainTotals[chain] ?? 0) + value;
        }
      }
    }

    const sorted = Object.entries(chainTotals)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);

    const top10 = sorted.slice(0, 10);
    const otherValue = sorted.slice(10).reduce((sum, c) => sum + c.value, 0);
    if (otherValue > 0) {
      top10.push({ name: "Other", value: otherValue });
    }

    return top10;
  }, [data]);

  if (chartData.length === 0) {
    return (
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle as="h2">Chain Distribution</CardTitle>
        </CardHeader>
        <CardContent>
          <ChartSkeleton className="h-[250px] sm:h-[350px] w-full" variant="bars" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader>
        <CardTitle as="h2">Chain Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[250px] sm:h-[350px]" role="figure" aria-label="Chain distribution bar chart">
        <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(val: number) => formatCurrency(val, 0)}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              width={80}
            />
            <Tooltip
              formatter={(value) => [formatCurrency(Number(value)), "TVL"]}
              {...RECHARTS_TOOLTIP_STYLES}
            />
            <Bar dataKey="value" radius={[0, 4, 4, 0]}>
              {chartData.map((_, index) => (
                <Cell key={index} fill={CHART_PALETTE[index % CHART_PALETTE.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
