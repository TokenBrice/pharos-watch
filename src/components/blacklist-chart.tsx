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
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { isGoldStablecoin, extractGoldPrices } from "@/lib/blacklist-helpers";
import { BLACKLIST_CHART_COLORS } from "@/lib/classification";
import { CHART_HEIGHT } from "@/lib/chart-colors";
import type { BlacklistEvent } from "@/lib/types";

const STABLECOINS_ORDER = ["USDT", "USDC", "PAXG", "XAUT"] as const;

function quarterToSortKey(timestamp: number): number {
  const d = new Date(timestamp * 1000);
  return d.getFullYear() * 4 + Math.floor(d.getMonth() / 3);
}

function sortKeyToLabel(sortKey: number): string {
  const year = Math.floor(sortKey / 4);
  const q = (sortKey % 4) + 1;
  return `Q${q} '${(year % 100).toString().padStart(2, "0")}`;
}

interface BlacklistChartProps {
  events: BlacklistEvent[] | undefined;
  isLoading: boolean;
}

export function BlacklistChart({ events, isLoading }: BlacklistChartProps) {
  const { data: stablecoins } = useStablecoins();

  const goldPrices = useMemo(() => {
    if (!stablecoins) return {};
    return extractGoldPrices(stablecoins.peggedAssets);
  }, [stablecoins]);

  const chartData = useMemo(() => {
    if (!events) return [];

    // Bucket blacklist events by quarter and stablecoin
    const buckets = new Map<number, Record<string, number>>();

    for (const evt of events) {
      if (evt.eventType !== "blacklist" || evt.amount == null) continue;

      const gold = isGoldStablecoin(evt.stablecoin);
      const usdMultiplier = gold ? (goldPrices[evt.stablecoin] ?? 0) : 1;
      const usdValue = evt.amount * usdMultiplier;
      if (usdValue <= 0) continue;

      const sk = quarterToSortKey(evt.timestamp);
      const bucket = buckets.get(sk) ?? { USDT: 0, USDC: 0, PAXG: 0, XAUT: 0 };
      bucket[evt.stablecoin] = (bucket[evt.stablecoin] ?? 0) + usdValue;
      buckets.set(sk, bucket);
    }

    if (buckets.size === 0) return [];

    // Fill gaps between first and last quarter
    const sortKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
    const min = sortKeys[0];
    const max = sortKeys[sortKeys.length - 1];

    const result: Array<{ quarter: string; USDT: number; USDC: number; PAXG: number; XAUT: number }> = [];
    for (let sk = min; sk <= max; sk++) {
      const bucket = buckets.get(sk);
      result.push({
        quarter: sortKeyToLabel(sk),
        USDT: bucket?.USDT ?? 0,
        USDC: bucket?.USDC ?? 0,
        PAXG: bucket?.PAXG ?? 0,
        XAUT: bucket?.XAUT ?? 0,
      });
    }

    return result;
  }, [events, goldPrices]);

  if (isLoading) {
    return (
      <Card className="rounded-xl">
        <CardHeader>
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-72 mt-1" />
        </CardHeader>
        <CardContent>
          <Skeleton className={`${CHART_HEIGHT} w-full`} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader>
        <CardTitle as="h2">Blacklisted Funds Over Time</CardTitle>
        <p className="text-sm text-muted-foreground">
          Frozen balances at time of blacklisting, per quarter, in USD value
        </p>
      </CardHeader>
      <CardContent>
        {chartData.length > 0 ? (
          <div
            className={CHART_HEIGHT}
            role="figure"
            aria-label={`Blacklisted funds stacked bar chart showing ${chartData.length} quarters of freeze events by stablecoin issuer`}
          >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="quarter"
                tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                angle={-45}
                textAnchor="end"
                height={80}
                interval={Math.max(0, Math.floor(chartData.length / 10) - 1)}
              />
              <YAxis
                tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(val: number) => formatCurrency(val, 0)}
              />
              <Tooltip
                content={<BlacklistTooltip />}
                cursor={{ fill: "currentColor", opacity: 0.05 }}
              />
              <Legend
                iconType="square"
                iconSize={10}
                wrapperStyle={{ fontSize: 13 }}
              />
              {STABLECOINS_ORDER.map((coin) => (
                <Bar
                  key={coin}
                  dataKey={coin}
                  stackId="a"
                  fill={BLACKLIST_CHART_COLORS[coin]}
                  radius={coin === "XAUT" ? [2, 2, 0, 0] : undefined}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
          </div>
        ) : (
          <div className={`flex ${CHART_HEIGHT} items-center justify-center text-muted-foreground`}>
            No blacklist events recorded yet
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BlacklistTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload) return null;

  const nonZero = payload.filter((p) => p.value > 0);
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
