"use client";

import { useCallback, useMemo } from "react";
import {
  ComposedChart,
  Area,
  Line,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import { TimeXAxis, MonoYAxis, TimeGrid } from "@/components/chart-primitives";
import { formatCurrency, formatChartDate } from "@shared/lib/format";
import { CHART_GREEN, CHART_RED, CHART_BLUE, CHART_HEIGHT } from "@/lib/chart-colors";
import type { MintBurnHourlyBucket } from "@shared/types";
import { DAY_HOURS, HOUR_MS, HOUR_SECONDS } from "@/lib/constants";

interface FlowChartProps {
  hourly: MintBurnHourlyBucket[];
  isLoading: boolean;
}

interface ChartDatum {
  ts: number;
  mint: number;
  burn: number;
  net: number;
  isInterpolated: boolean;
}

export function FlowChart({ hourly, isLoading }: FlowChartProps) {
  const chartData = useMemo<ChartDatum[]>(() => {
    if (hourly.length === 0) return [];

    const sorted = [...hourly].sort((a, b) => a.hourTs - b.hourTs);
    const byHour = new Map(sorted.map((b) => [b.hourTs, b] as const));
    const startHour = sorted[0].hourTs;
    const endHour = sorted[sorted.length - 1].hourTs;

    const filled: ChartDatum[] = [];
    for (let hourTs = startHour; hourTs <= endHour; hourTs += HOUR_SECONDS) {
      const bucket = byHour.get(hourTs);
      filled.push({
        ts: hourTs * 1000,
        mint: bucket?.mintVolumeUsd ?? 0,
        burn: -(bucket?.burnVolumeUsd ?? 0),
        net: bucket?.netFlowUsd ?? 0,
        isInterpolated: !bucket,
      });
    }
    return filled;
  }, [hourly]);

  const rangeHours = useMemo(() => {
    if (chartData.length < 2) return 0;
    return (chartData[chartData.length - 1].ts - chartData[0].ts) / HOUR_MS;
  }, [chartData]);

  const hasInterpolated = useMemo(() => chartData.some((d) => d.isInterpolated), [chartData]);

  const formatXAxisTick = useCallback((ts: number) => {
    if (rangeHours <= 48) {
      return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    }
    if (rangeHours <= 8 * DAY_HOURS) {
      return formatChartDate(ts, "with-time");
    }
    return formatChartDate(ts, "short");
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
            <TimeGrid />
            <TimeXAxis dataKey="ts" minTickGap={72} tickFormatter={formatXAxisTick} />
            <MonoYAxis tickFormatter={(val: number) => formatCurrency(val, 0)} />
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
      {hasInterpolated && (
        <p className="mt-1 text-xs text-muted-foreground">
          Gaps in hourly data are filled with zero values.
        </p>
      )}
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
    <PharosChartTooltip active={active}>
      <TooltipLabel>{time}</TooltipLabel>
      {ordered.map((p) => (
        <TooltipRow
          key={p.dataKey}
          color={p.color}
          label={p.name}
          value={
            p.dataKey === "net"
              ? `${p.value >= 0 ? "+" : "-"}${formatCurrency(Math.abs(p.value))}`
              : formatCurrency(Math.abs(p.value))
          }
        />
      ))}
    </PharosChartTooltip>
  );
}
