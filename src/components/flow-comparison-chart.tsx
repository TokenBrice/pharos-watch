"use client";

import { useMemo } from "react";
import {
  LineChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import { formatChartDate, formatCurrency } from "@shared/lib/format";
import { MonoYAxis, TimeXAxis, ChartLegendChip } from "@/components/chart-primitives/axes";
import { ScreenReaderDataTable } from "@/components/chart-primitives/data-table";
import { mergeSeriesByTimestamp } from "@/lib/chart-utils";
import type { FlowSeriesEntry } from "@/lib/compare-derive";

export type FlowSeries = FlowSeriesEntry;

interface FlowComparisonChartProps {
  series: FlowSeries[];
  hours: number;
  onHoursChange: (hours: number) => void;
}

const HOUR_OPTIONS = [
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
  { label: "30d", value: 720 },
] as const;

export function FlowComparisonChart({
  series,
  hours,
  onHoursChange,
}: FlowComparisonChartProps) {
  // Merge all series into flat array keyed by timestamp
  const mergedData = useMemo(
    () => mergeSeriesByTimestamp(series, (d) => d.netFlowUsd),
    [series],
  );

  if (mergedData.length === 0) return null;

  return (
    <Card className="pharos-card-shell">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle as="h3" className="pharos-kicker">
            Net Flow Over Time
          </CardTitle>
          <div className="flex gap-1">
            {HOUR_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                aria-pressed={hours === opt.value}
                onClick={() => onHoursChange(opt.value)}
                className={`pharos-focus-ring pharos-control-pill px-2.5 py-1 text-xs ${
                  hours === opt.value ? "pharos-control-pill-active" : ""
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
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
        <ScreenReaderDataTable
          data={mergedData}
          columns={[
            { id: "ts", label: "Date", format: (row) => formatChartDate(row["ts"] as number, hours <= 24 ? "with-time" : "short") },
            ...series.map((s) => ({
              id: s.id,
              label: s.label,
              format: (row: Record<string, number>) => {
                const v = row[s.id];
                return v != null ? `${v >= 0 ? "+" : ""}${formatCurrency(v, 1)}` : "—";
              },
            })),
          ]}
          caption={(rows, truncated, total) =>
            truncated
              ? `Net flow comparison — most recent ${rows.length} of ${total} data points`
              : `Net flow comparison — ${total} data points`
          }
        />
        <div className="pharos-chart-stage">
          <ResponsiveContainer width="100%" height={200}>
          <LineChart
            data={mergedData}
            margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          >
            <TimeXAxis
              dataKey="ts"
              tickFormatter={(ts: number) =>
                hours <= 24
                  ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                  : new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" })
              }
            />
            <MonoYAxis tickFormatter={(v: number) => formatCurrency(v, 1)} />
            <ReferenceLine
              y={0}
              stroke="var(--color-border)"
              strokeDasharray="4 4"
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                return (
                  <PharosChartTooltip active={active}>
                    <TooltipLabel>
                      {formatChartDate(label as number, hours <= 24 ? "with-time" : "short")}
                    </TooltipLabel>
                    {payload.map((p) => {
                      const val = p.value as number | null | undefined;
                      const formatted =
                        val != null
                          ? `${val >= 0 ? "+" : ""}${formatCurrency(val, 1)}`
                          : "—";
                      return (
                        <TooltipRow
                          key={p.dataKey as string}
                          color={p.color}
                          label={String(p.name ?? p.dataKey)}
                          value={formatted}
                        />
                      );
                    })}
                  </PharosChartTooltip>
                );
              }}
            />
            {series.map((s) => (
              <Line
                key={s.id}
                type="monotone"
                dataKey={s.id}
                name={s.label}
                stroke={s.color}
                strokeWidth={1.5}
                dot={false}
                connectNulls
              />
            ))}
          </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
