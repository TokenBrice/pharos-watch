"use client";

import { useMemo } from "react";
import { CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import {
  QuarterlyStackedBarChart,
  type QuarterlyStackedBarSeries,
} from "@/components/chart-primitives/quarterly-stacked-bar-chart";
import type { BlacklistEventType, BlacklistQuarterlyEventTypePoint } from "@shared/types";
import { EVENT_CHART_COLORS, EVENT_LABELS } from "@shared/lib/classification";

const CHART_HEIGHT = "h-[220px] sm:h-[260px]";

const EVENT_TYPE_SERIES: QuarterlyStackedBarSeries[] = [
  { dataKey: "blacklist", color: EVENT_CHART_COLORS.blacklist, fillOpacity: 0.8 },
  { dataKey: "unblacklist", color: EVENT_CHART_COLORS.unblacklist, fillOpacity: 0.7 },
  { dataKey: "destroy", color: EVENT_CHART_COLORS.destroy, fillOpacity: 0.75, radius: [3, 3, 0, 0] },
];

interface BlacklistDetailChartProps {
  data: BlacklistQuarterlyEventTypePoint[] | undefined;
  isLoading: boolean;
}

type Entry = { dataKey: BlacklistEventType; value: number; color: string };

export function BlacklistDetailChart({ data, isLoading }: BlacklistDetailChartProps) {
  const chartData = useMemo(() => data ?? [], [data]);

  if (isLoading) {
    return (
      <section className="border-t border-border/40 pt-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-3 w-64 mt-1" />
        <Skeleton className={`${CHART_HEIGHT} mt-4 w-full`} />
      </section>
    );
  }

  if (chartData.length === 0) {
    return (
      <section className="border-t border-border/40 pt-4 animate-in fade-in duration-[220ms] motion-reduce:animate-none">
        <CardTitle as="h3" className="pharos-kicker">Events per Quarter</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          Insufficient data for the quarterly view on this asset yet.
        </p>
      </section>
    );
  }

  return (
    <section className="border-t border-border/40 pt-4 animate-in fade-in duration-[220ms] motion-reduce:animate-none">
      <CardTitle as="h3" className="pharos-kicker">Events per Quarter</CardTitle>
      <p className="mt-1 text-xs text-muted-foreground">
        Count of {EVENT_LABELS.blacklist}, {EVENT_LABELS.unblacklist}, and {EVENT_LABELS.destroy} events attributed to their execution quarter.
      </p>
      <div className="mt-4">
        <div className="mb-3 flex flex-wrap gap-2">
          {(["blacklist", "unblacklist", "destroy"] as const).map((key) => (
            <div key={key} className="pharos-chart-legend-chip">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: EVENT_CHART_COLORS[key] }}
              />
              {EVENT_LABELS[key]}
            </div>
          ))}
        </div>
        <QuarterlyStackedBarChart
          data={chartData}
          series={EVENT_TYPE_SERIES}
          yAxis={{ allowDecimals: false, width: 48 }}
          tooltipContent={<EventTypeTooltip />}
          ariaLabel={`Quarterly blacklist events chart showing ${chartData.length} quarters`}
          height={CHART_HEIGHT}
        />
      </div>
    </section>
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
        <TooltipRow key={p.dataKey} color={p.color} label={EVENT_LABELS[p.dataKey]} value={String(p.value)} />
      ))}
    </PharosChartTooltip>
  );
}
