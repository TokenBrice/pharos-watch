"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { MINT_BURN_CHART_COLORS } from "@/lib/classification";
import type { MintBurnEvent, MintBurnStablecoin } from "@/lib/types";

const STABLECOINS_ORDER: MintBurnStablecoin[] = ["USDC", "USDT"];

function monthKey(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const y = d.getFullYear() % 100;
  const m = d.getMonth();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m]} '${y.toString().padStart(2, "0")}`;
}

function monthSortKey(timestamp: number): number {
  const d = new Date(timestamp * 1000);
  return d.getFullYear() * 12 + d.getMonth();
}

interface MintBurnChartProps {
  events: MintBurnEvent[] | undefined;
  isLoading: boolean;
}

export function MintBurnChart({ events, isLoading }: MintBurnChartProps) {
  const chartData = useMemo(() => {
    if (!events || events.length === 0) return [];

    // Bucket net flow (mint - burn) by month and stablecoin
    const buckets = new Map<number, Record<string, number>>();

    for (const evt of events) {
      const sk = monthSortKey(evt.timestamp);
      const bucket = buckets.get(sk) ?? { USDC: 0, USDT: 0 };
      const sign = evt.eventType === "mint" ? 1 : -1;
      bucket[evt.stablecoin] = (bucket[evt.stablecoin] ?? 0) + sign * evt.amount;
      buckets.set(sk, bucket);
    }

    if (buckets.size === 0) return [];

    const sortKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
    const min = sortKeys[0];
    const max = sortKeys[sortKeys.length - 1];

    const result: Array<{ month: string; USDC: number; USDT: number }> = [];
    for (let sk = min; sk <= max; sk++) {
      const bucket = buckets.get(sk);
      const year = Math.floor(sk / 12);
      const m = sk % 12;
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const label = `${months[m]} '${(year % 100).toString().padStart(2, "0")}`;
      result.push({
        month: label,
        USDC: bucket?.USDC ?? 0,
        USDT: bucket?.USDT ?? 0,
      });
    }

    return result;
  }, [events]);

  if (isLoading) {
    return (
      <Card className="rounded-2xl">
        <CardHeader>
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-72 mt-1" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[400px] w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle as="h2">Net Issuance Over Time</CardTitle>
        <p className="text-sm text-muted-foreground">
          Monthly net flow (mints &minus; burns) for USDC and USDT
        </p>
      </CardHeader>
      <CardContent>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={400}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                angle={-45}
                textAnchor="end"
                height={80}
                interval={Math.max(0, Math.floor(chartData.length / 12) - 1)}
              />
              <YAxis
                tick={{ fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(val: number) => formatCurrency(val, 0)}
              />
              <Tooltip
                content={<NetFlowTooltip />}
                cursor={{ fill: "currentColor", opacity: 0.05 }}
              />
              <Legend
                iconType="square"
                iconSize={10}
                wrapperStyle={{ fontSize: 13 }}
              />
              <ReferenceLine y={0} stroke="currentColor" strokeOpacity={0.2} />
              {STABLECOINS_ORDER.map((coin, i) => (
                <Bar
                  key={coin}
                  dataKey={coin}
                  stackId="a"
                  fill={MINT_BURN_CHART_COLORS[coin]}
                  radius={i === STABLECOINS_ORDER.length - 1 ? [2, 2, 0, 0] : undefined}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-[400px] items-center justify-center text-muted-foreground">
            No mint/burn events recorded yet
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NetFlowTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload) return null;

  const nonZero = payload.filter((p) => p.value !== 0);
  if (nonZero.length === 0) return null;

  const total = nonZero.reduce((s, p) => s + p.value, 0);

  return (
    <div className="rounded-lg border bg-card px-3 py-2 shadow-md text-sm">
      <p className="font-semibold mb-1">{label}</p>
      {nonZero.map((p) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <div className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: p.color }} />
            <span>{p.dataKey}</span>
          </div>
          <span className="font-mono tabular-nums">{formatCurrency(p.value)}</span>
        </div>
      ))}
      {nonZero.length > 1 && (
        <div className="flex items-center justify-between gap-4 border-t mt-1 pt-1 font-semibold">
          <span>Total</span>
          <span className="font-mono tabular-nums">{formatCurrency(total)}</span>
        </div>
      )}
    </div>
  );
}
