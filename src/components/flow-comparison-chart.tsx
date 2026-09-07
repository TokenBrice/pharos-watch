"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatChartDate, formatCurrency } from "@shared/lib/format";
import { ChartLegendChip } from "@/components/chart-primitives/axes";
import { MultiSeriesLineChart, mergeMultiSeriesData } from "@/components/chart-primitives/multi-series-line-chart";
import { ControlPillToggle } from "@/components/control-pill-toggle";
import type { FlowSeriesEntry } from "@/lib/compare-derive";

export type FlowSeries = FlowSeriesEntry;

interface FlowComparisonChartProps {
  series: FlowSeries[];
  hours: number;
  onHoursChange: (hours: number) => void;
}

const HOUR_OPTIONS = [
  { value: 24, label: "24h" },
  { value: 168, label: "7d" },
  { value: 720, label: "30d" },
] as const;

export function FlowComparisonChart({
  series,
  hours,
  onHoursChange,
}: FlowComparisonChartProps) {
  // Merge all series into flat array keyed by timestamp
  const mergedData = mergeMultiSeriesData(series, (d) => d.netFlowUsd);

  if (mergedData.length === 0) return null;

  return (
    <Card className="pharos-card-shell">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle as="h3" className="pharos-kicker">
            Net Flow Over Time
          </CardTitle>
          <ControlPillToggle
            className="flex gap-1"
            buttonClassName="px-2.5 py-1 text-xs"
            options={HOUR_OPTIONS}
            value={hours}
            onChange={onHoursChange}
          />
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap gap-3">
          {series.map((s) => (
            <ChartLegendChip key={s.id} markerStyle={{ backgroundColor: s.color }}>
              {s.label}
            </ChartLegendChip>
          ))}
        </div>
        <div className="pharos-chart-stage">
          <MultiSeriesLineChart
            series={series}
            getValue={(datum) => datum.netFlowUsd}
            data={mergedData}
            ariaLabel={`Net flow comparison chart with ${series.length} series`}
            height={200}
            margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
            xTickFormatter={(timestamp) => hours <= 24
              ? new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" })}
            yTickFormatter={(value) => formatCurrency(value, 1)}
            valueFormatter={(value) => `${value >= 0 ? "+" : ""}${formatCurrency(value, 1)}`}
            tooltipLabelFormatter={(timestamp) => formatChartDate(timestamp, hours <= 24 ? "with-time" : "short")}
            tableDateFormatter={(timestamp) => formatChartDate(timestamp, hours <= 24 ? "with-time" : "short")}
            tableCaption={(rows, truncated, total) => truncated
              ? `Net flow comparison — most recent ${rows.length} of ${total} data points`
              : `Net flow comparison — ${total} data points`}
            lineStrokeWidth={1.5}
            showZeroLine
            tooltipVariant="pharos"
          />
        </div>
      </CardContent>
    </Card>
  );
}
