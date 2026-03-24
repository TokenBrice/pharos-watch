"use client";

import { useMemo } from "react";
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { formatCurrency } from "@shared/lib/format";
import { BLACKLIST_CHART_COLORS } from "@shared/lib/classification";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import type { BlacklistSummaryResponse, BlacklistStablecoin } from "@shared/types";

const STABLECOINS_ORDER = ["USDT", "USDC", "PYUSD", "USD1", "PAXG", "XAUT"] as const satisfies readonly BlacklistStablecoin[];
const CHART_HEIGHT = "h-[220px] sm:h-[280px]";

interface BlacklistChartProps {
  chart: BlacklistSummaryResponse["chart"] | undefined;
  isLoading: boolean;
}

type BlacklistTooltipEntry = {
  dataKey: string;
  value: number;
  color: string;
};

export function getBlacklistTooltipSummary(payload?: ReadonlyArray<BlacklistTooltipEntry>) {
  const rows = (payload ?? []).filter((p) => p.dataKey !== "total" && p.value > 0);
  const total = payload?.find((p) => p.dataKey === "total")?.value ?? rows.reduce((sum, p) => sum + p.value, 0);

  return { rows, total };
}

export function BlacklistChart({ chart, isLoading }: BlacklistChartProps) {
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();
  const chartData = useMemo(() => chart ?? [], [chart]);

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
            <CardTitle as="h2" className="pharos-kicker">Blacklisted Funds Over Time</CardTitle>
            <p className="text-sm text-muted-foreground">
              Historical USD-at-event value for blacklist actions, per quarter, where valuation is available
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
                {STABLECOINS_ORDER.map((coin, i) => (
                  <Bar
                    key={coin}
                    dataKey={coin}
                    stackId="a"
                    fill={BLACKLIST_CHART_COLORS[coin]}
                    fillOpacity={i === 0 ? 0.75 : 0.62}
                    radius={i === STABLECOINS_ORDER.length - 1 ? [3, 3, 0, 0] : undefined}
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
  payload?: Array<BlacklistTooltipEntry>;
  label?: string;
}) {
  const { rows, total } = getBlacklistTooltipSummary(payload);
  if (!rows.length && total <= 0) return null;

  return (
    <PharosChartTooltip active={active}>
      <TooltipLabel>{label}</TooltipLabel>
      {rows.map((p) => (
        <TooltipRow key={p.dataKey} color={p.color} label={p.dataKey} value={formatCurrency(p.value)} />
      ))}
      {total > 0 && (
        <div className="border-t border-border/50 mt-1.5 pt-1.5">
          <TooltipRow label="Total" value={formatCurrency(total)} bold />
        </div>
      )}
    </PharosChartTooltip>
  );
}
