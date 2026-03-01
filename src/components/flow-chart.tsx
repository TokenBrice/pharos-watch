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
    return hourly.map((b) => ({
      ts: b.hourTs * 1000,
      mint: b.mintVolumeUsd,
      burn: -b.burnVolumeUsd,
      net: b.netFlowUsd,
    }));
  }, [hourly]);

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
              tickFormatter={(ts: number) => {
                const d = new Date(ts);
                return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
              }}
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
              type="monotone"
              dataKey="mint"
              stroke={CHART_GREEN}
              fill="url(#mintGrad)"
              strokeWidth={1.5}
              name="Minted"
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="burn"
              stroke={CHART_RED}
              fill="url(#burnGrad)"
              strokeWidth={1.5}
              name="Burned"
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="net"
              stroke={CHART_BLUE}
              strokeWidth={2}
              dot={false}
              name="Net Flow"
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

  return (
    <div className="rounded-lg border bg-card px-3 py-2 shadow-md text-sm" style={{ fontFamily: "var(--font-mono)" }}>
      <p className="font-semibold mb-1" style={{ fontFamily: "var(--font-sans)" }}>{time}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <div className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: p.color }} />
            <span style={{ fontFamily: "var(--font-sans)" }}>{p.name}</span>
          </div>
          <span className="tabular-nums">{formatCurrency(Math.abs(p.value))}</span>
        </div>
      ))}
    </div>
  );
}
