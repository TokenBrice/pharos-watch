"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatChartDate, formatCurrency } from "@shared/lib/format";
import { ChartLegendChip } from "@/components/chart-primitives/legend";
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
  // Merge all series into flat array keyed by timestamp. Hours with an
  // unavailable net (null or partial valuation) are already omitted upstream.
  const mergedData = mergeMultiSeriesData(series, (d) => d.netFlowUsd);
  const unavailableSeries = series.filter((s) => s.unavailableHours > 0);
  const unknownCoverageSeries = series.filter((s) => s.unknownCoverageHours > 0);

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
              ? new Date(timestamp).toLocaleTimeString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                  hourCycle: "h23",
                  timeZone: "UTC",
                })
              : formatChartDate(timestamp, "short")}
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
        {unavailableSeries.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Partial valuation: {unavailableSeries.map((s) => `${s.label} ${s.unavailableHours}h`).join(", ")} omitted
            because unpriced events leave the signed net unavailable.
          </p>
        )}
        {unknownCoverageSeries.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            Coverage unknown: {unknownCoverageSeries.map((s) => `${s.label} ${s.unknownCoverageHours}h`).join(", ")} were
            aggregated before valuation completeness was recorded.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
