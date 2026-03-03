"use client";

import { useCallback, useMemo } from "react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { CHART_GREEN, CHART_RED, CHART_BLUE, CHART_HEIGHT } from "@/lib/chart-colors";
import type { MintBurnHourlyBucket } from "@/lib/types";

interface FlowChartProps {
  hourly: MintBurnHourlyBucket[];
  isLoading: boolean;
}

interface ChartDatum {
  ts: number;
  mint: number;
  burn: number;
  net: number;
}

export function FlowChart({ hourly, isLoading }: FlowChartProps) {
  const chartData = useMemo<ChartDatum[]>(() => {
    if (hourly.length === 0) return [];

    const sorted = [...hourly].sort((a, b) => a.hourTs - b.hourTs);
    const byHour = new Map(sorted.map((b) => [b.hourTs, b] as const));
    const startHour = sorted[0].hourTs;
    const endHour = sorted[sorted.length - 1].hourTs;

    const filled: ChartDatum[] = [];
    for (let hourTs = startHour; hourTs <= endHour; hourTs += 3600) {
      const bucket = byHour.get(hourTs);
      filled.push({
        ts: hourTs * 1000,
        mint: bucket?.mintVolumeUsd ?? 0,
        burn: -(bucket?.burnVolumeUsd ?? 0),
        net: bucket?.netFlowUsd ?? 0,
      });
    }
    return filled;
  }, [hourly]);

  const rangeHours = useMemo(() => {
    if (chartData.length < 2) return 0;
    return (chartData[chartData.length - 1].ts - chartData[0].ts) / 3_600_000;
  }, [chartData]);

  const formatXAxisTick = useCallback((ts: number) => {
    const d = new Date(ts);
    if (rangeHours <= 48) {
      return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    }
    if (rangeHours <= 8 * 24) {
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", hour12: true });
    }
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }, [rangeHours]);

  if (isLoading) {
    return <Skeleton className={`${CHART_HEIGHT} w-full rounded-xl`} />;
  }

  if (chartData.length === 0) {
    return (
      <div className={`flex ${CHART_HEIGHT} items-center justify-center text-muted-foreground`}>
        Collecting flow data...
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap gap-4 mb-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: CHART_GREEN }} />
          Minted
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: CHART_RED }} />
          Burned
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: CHART_BLUE }} />
          Net Flow
        </div>
      </div>
      <div
        className={CHART_HEIGHT}
        role="figure"
        aria-label={`Mint and burn flow chart showing ${chartData.length} hourly data points`}
      >
        <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
          <ComposedChart data={chartData} margin={{ top: 5, right: 20, bottom: 20, left: 5 }}>
            <defs>
              <linearGradient id="mintGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={CHART_GREEN} stopOpacity={0.4} />
                <stop offset="95%" stopColor={CHART_GREEN} stopOpacity={0.05} />
              </linearGradient>
              <linearGradient id="burnGrad" x1="0" y1="1" x2="0" y2="0">
                <stop offset="5%" stopColor={CHART_RED} stopOpacity={0.4} />
                <stop offset="95%" stopColor={CHART_RED} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              minTickGap={72}
              tickFormatter={formatXAxisTick}
            />
            <YAxis
              tick={{ fontSize: 12, fontFamily: "var(--font-mono, monospace)", fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(val: number) => formatCurrency(val, 0)}
            />
            <Tooltip
              content={<FlowTooltip />}
              cursor={{ stroke: "var(--color-border)", strokeWidth: 1 }}
            />
            <ReferenceLine y={0} stroke="var(--color-border)" strokeWidth={1} />
            <Area
              type="linear"
              dataKey="mint"
              stroke={CHART_GREEN}
              fill="url(#mintGrad)"
              strokeWidth={1.5}
              name="Minted"
              isAnimationActive={false}
            />
            <Line
              type="linear"
              dataKey="net"
              stroke={CHART_BLUE}
              strokeWidth={1.5}
              strokeOpacity={0.75}
              strokeDasharray="5 3"
              dot={false}
              name="Net Flow"
              isAnimationActive={false}
            />
            <Area
              type="linear"
              dataKey="burn"
              stroke={CHART_RED}
              fill="url(#burnGrad)"
              strokeWidth={2}
              name="Burned"
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function FlowTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number; color: string; name: string }>;
  label?: number;
}) {
  if (!active || !payload || !label) return null;

  const time = new Date(label).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const ordered = [...payload].sort((a, b) => {
    const order: Record<string, number> = { mint: 0, burn: 1, net: 2 };
    return (order[a.dataKey] ?? 99) - (order[b.dataKey] ?? 99);
  });

  return (
    <div className="rounded-lg border bg-card px-3 py-2 shadow-md text-sm" style={{ fontFamily: "var(--font-mono)" }}>
      <p className="font-semibold mb-1" style={{ fontFamily: "var(--font-sans)" }}>{time}</p>
      {ordered.map((p) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <div className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: p.color }} />
            <span style={{ fontFamily: "var(--font-sans)" }}>{p.name}</span>
          </div>
          <span className="tabular-nums">
            {p.dataKey === "net"
              ? `${p.value >= 0 ? "+" : "-"}${formatCurrency(Math.abs(p.value))}`
              : formatCurrency(Math.abs(p.value))}
          </span>
        </div>
      ))}
    </div>
  );
}
