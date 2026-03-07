"use client";

import { useMemo } from "react";
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { formatCurrency } from "@shared/lib/format";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { isGoldStablecoin, extractGoldPrices } from "@/lib/blacklist-helpers";
import { BLACKLIST_CHART_COLORS } from "@shared/lib/classification";
import { RECHARTS_TOOLTIP_STYLES } from "@/lib/chart-colors";
import type { BlacklistEvent, BlacklistStablecoin } from "@shared/types";

const STABLECOINS_ORDER = ["USDT", "USDC", "EURC", "PAXG", "XAUT"] as const satisfies readonly BlacklistStablecoin[];
const CHART_HEIGHT = "h-[220px] sm:h-[280px]";

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
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();

  const goldPrices = useMemo(() => {
    if (!stablecoins) return {};
    return extractGoldPrices(stablecoins.peggedAssets);
  }, [stablecoins]);

  const chartData = useMemo(() => {
    if (!events) return [];

    // Bucket blacklist events by quarter and stablecoin
    const buckets = new Map<number, Record<BlacklistStablecoin, number>>();

    for (const evt of events) {
      if (evt.eventType !== "blacklist" || evt.amount == null) continue;

      const gold = isGoldStablecoin(evt.stablecoin);
      const usdMultiplier = gold ? (goldPrices[evt.stablecoin] ?? 0) : 1;
      const usdValue = evt.amount * usdMultiplier;
      if (usdValue <= 0) continue;

      const sk = quarterToSortKey(evt.timestamp);
      const bucket = buckets.get(sk) ?? { USDT: 0, USDC: 0, EURC: 0, PAXG: 0, XAUT: 0 };
      bucket[evt.stablecoin] = (bucket[evt.stablecoin] ?? 0) + usdValue;
      buckets.set(sk, bucket);
    }

    if (buckets.size === 0) return [];

    // Fill gaps between first and last quarter
    const sortKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
    const min = sortKeys[0];
    const max = sortKeys[sortKeys.length - 1];

    const result: Array<{
      quarter: string;
      USDT: number;
      USDC: number;
      EURC: number;
      PAXG: number;
      XAUT: number;
      total: number;
    }> = [];
    for (let sk = min; sk <= max; sk++) {
      const bucket = buckets.get(sk);
      const total =
        (bucket?.USDT ?? 0) + (bucket?.USDC ?? 0) + (bucket?.EURC ?? 0) + (bucket?.PAXG ?? 0) + (bucket?.XAUT ?? 0);
      result.push({
        quarter: sortKeyToLabel(sk),
        USDT: bucket?.USDT ?? 0,
        USDC: bucket?.USDC ?? 0,
        EURC: bucket?.EURC ?? 0,
        PAXG: bucket?.PAXG ?? 0,
        XAUT: bucket?.XAUT ?? 0,
        total,
      });
    }

    return result;
  }, [events, goldPrices]);

  const peakQuarters = useMemo(() => {
    return [...chartData]
      .filter((point) => point.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 2);
  }, [chartData]);

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
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle as="h2">Blacklisted Funds Over Time</CardTitle>
            <p className="text-sm text-muted-foreground">
              Frozen balances at time of blacklisting, per quarter, in USD value
            </p>
          </div>
          {peakQuarters.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {peakQuarters.map((quarter) => (
                <span
                  key={quarter.quarter}
                  className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-xs text-muted-foreground"
                >
                  <span className="font-medium text-foreground">{quarter.quarter}</span>
                  <span className="font-mono">{formatCurrency(quarter.total, 0)}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Peak freeze quarters surface above so the top chart stays legible without losing the issuer breakdown.
        </p>
      </CardHeader>
      <CardContent>
        {chartData.length > 0 ? (
          <div
            ref={chartContainerRef}
            className={CHART_HEIGHT}
            role="figure"
            aria-label={`Blacklisted funds stacked bar chart showing ${chartData.length} quarters of freeze events by stablecoin issuer`}
          >
            {isChartReady ? (
              <ComposedChart
                width={width}
                height={height}
                data={chartData}
                margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
              >
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis
                  dataKey="quarter"
                  tick={{
                    fontSize: 11,
                    fontFamily: "var(--font-mono, monospace)",
                    fill: "var(--color-muted-foreground)",
                  }}
                  tickLine={false}
                  axisLine={false}
                  angle={-35}
                  textAnchor="end"
                  height={52}
                  interval={Math.max(0, Math.floor(chartData.length / 8) - 1)}
                />
                <YAxis
                  tick={{
                    fontSize: 11,
                    fontFamily: "var(--font-mono, monospace)",
                    fill: "var(--color-muted-foreground)",
                  }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(val: number) => formatCurrency(val, 0)}
                  width={62}
                />
                <Tooltip content={<BlacklistTooltip />} cursor={{ fill: "currentColor", opacity: 0.05 }} />
                <Legend iconType="square" iconSize={9} wrapperStyle={{ fontSize: 12, paddingTop: "8px" }} />
                {STABLECOINS_ORDER.map((coin) => (
                  <Bar
                    key={coin}
                    dataKey={coin}
                    stackId="a"
                    fill={BLACKLIST_CHART_COLORS[coin]}
                    fillOpacity={coin === "USDT" ? 0.75 : 0.62}
                    radius={coin === "XAUT" ? [3, 3, 0, 0] : undefined}
                  />
                ))}
                <Line
                  type="monotone"
                  dataKey="total"
                  stroke="var(--color-foreground)"
                  strokeOpacity={0.45}
                  strokeWidth={1.5}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                />
              </ComposedChart>
            ) : (
              <Skeleton className="h-full w-full" />
            )}
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
    <div
      className="rounded-lg border px-3 py-2 shadow-md text-sm"
      style={{
        backgroundColor: RECHARTS_TOOLTIP_STYLES.contentStyle.backgroundColor,
        borderColor: "var(--color-border)",
        borderRadius: RECHARTS_TOOLTIP_STYLES.contentStyle.borderRadius,
        fontFamily: RECHARTS_TOOLTIP_STYLES.contentStyle.fontFamily,
      }}
    >
      <p className="font-semibold mb-1" style={{ fontFamily: RECHARTS_TOOLTIP_STYLES.labelStyle.fontFamily }}>
        {label}
      </p>
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
