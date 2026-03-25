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
import { MonoYAxis, TimeXAxis } from "@/components/chart-primitives";
import { mergeSeriesByTimestamp } from "@/lib/chart-utils";

export interface FlowSeries {
  id: string;
  label: string;
  color: string;
  data: { ts: number; netFlowUsd: number }[];
}

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
                className={`pharos-focus-ring rounded px-2 py-0.5 text-xs transition-colors ${
                  hours === opt.value
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
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
            <div
              key={s.id}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              {s.label}
            </div>
          ))}
        </div>
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
      </CardContent>
    </Card>
  );
}
