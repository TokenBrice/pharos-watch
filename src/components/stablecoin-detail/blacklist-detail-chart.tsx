"use client";

import { useMemo } from "react";
import { ComposedChart, Bar, Tooltip } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import { CategoricalXAxis, ChartGrid, MonoYAxis } from "@/components/chart-primitives";
import type { BlacklistQuarterlyEventTypePoint } from "@shared/types";

const CHART_HEIGHT = "h-[220px] sm:h-[260px]";

// Red = blacklist (punitive), amber = destroy (escalation), emerald =
// unblacklist (reversal). Mirrors the badge colours on the main /blacklist
// table so users carry intuition across pages.
const EVENT_TYPE_COLORS = {
  blacklist: "#ef4444",
  destroy: "#f59e0b",
  unblacklist: "#10b981",
} as const;

interface BlacklistDetailChartProps {
  data: BlacklistQuarterlyEventTypePoint[] | undefined;
  isLoading: boolean;
}

type Entry = { dataKey: string; value: number; color: string };

export function BlacklistDetailChart({ data, isLoading }: BlacklistDetailChartProps) {
  const { ref, ready, width, height } = useChartContainerReady<HTMLDivElement>();
  const chartData = useMemo(() => data ?? [], [data]);

  if (isLoading) {
    return (
      <Card className="rounded-xl">
        <CardHeader>
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3 w-64 mt-1" />
        </CardHeader>
        <CardContent>
          <Skeleton className={`${CHART_HEIGHT} w-full`} />
        </CardContent>
      </Card>
    );
  }

  if (chartData.length === 0) {
    return (
      <Card className="rounded-xl animate-in fade-in duration-300">
        <CardHeader>
          <CardTitle as="h3" className="pharos-kicker">Events per Quarter</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Insufficient data for the quarterly view on this asset yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl animate-in fade-in duration-300">
      <CardHeader>
        <CardTitle as="h3" className="pharos-kicker">Events per Quarter</CardTitle>
        <p className="text-xs text-muted-foreground">
          Count of blacklist, unblacklist, and destroy events attributed to their execution quarter.
        </p>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap gap-2">
          {(["blacklist", "unblacklist", "destroy"] as const).map((key) => (
            <div key={key} className="pharos-chart-legend-chip">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: EVENT_TYPE_COLORS[key] }}
              />
              {key[0]!.toUpperCase() + key.slice(1)}
            </div>
          ))}
        </div>
        <div
          ref={ref}
          className={CHART_HEIGHT}
          role="figure"
          aria-label={`Quarterly blacklist events chart showing ${chartData.length} quarters`}
        >
          {ready ? (
            <ComposedChart
              width={width}
              height={height}
              data={chartData}
              margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            >
              <ChartGrid strokeDasharray="3 3" />
              <CategoricalXAxis
                dataKey="quarter"
                tick={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono, monospace)",
                  fill: "var(--color-muted-foreground)",
                }}
                angle={-35}
                textAnchor="end"
                height={52}
                interval={Math.max(0, Math.floor(chartData.length / 8) - 1)}
              />
              <MonoYAxis
                tick={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono, monospace)",
                  fill: "var(--color-muted-foreground)",
                }}
                allowDecimals={false}
                width={48}
              />
              <Tooltip content={<EventTypeTooltip />} cursor={{ fill: "currentColor", opacity: 0.05 }} />
              <Bar dataKey="blacklist" stackId="a" fill={EVENT_TYPE_COLORS.blacklist} fillOpacity={0.8} />
              <Bar dataKey="unblacklist" stackId="a" fill={EVENT_TYPE_COLORS.unblacklist} fillOpacity={0.7} />
              <Bar dataKey="destroy" stackId="a" fill={EVENT_TYPE_COLORS.destroy} fillOpacity={0.75} radius={[3, 3, 0, 0]} />
            </ComposedChart>
          ) : (
            <Skeleton className="h-full w-full" />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function EventTypeTooltip({ active, payload, label }: { active?: boolean; payload?: Entry[]; label?: string }) {
  if (!active || !payload || payload.length === 0) return null;
  const rows = payload.filter((p) => p.value > 0);
  if (rows.length === 0) return null;
  return (
    <PharosChartTooltip active={active}>
      <TooltipLabel>{label}</TooltipLabel>
      {rows.map((p) => (
        <TooltipRow key={p.dataKey} color={p.color} label={p.dataKey} value={String(p.value)} />
      ))}
    </PharosChartTooltip>
  );
}
