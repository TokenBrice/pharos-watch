"use client";

import {
  LineChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatChartDate } from "@shared/lib/format";
import { MonoYAxis, TimeXAxis } from "@/components/chart-primitives";

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

function formatFlowValue(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  return `$${(v / 1e6).toFixed(0)}M`;
}

export function FlowComparisonChart({
  series,
  hours,
  onHoursChange,
}: FlowComparisonChartProps) {
  // Merge all series into flat array keyed by timestamp
  const mergedData: Record<string, number>[] = (() => {
    const tsMap = new Map<number, Record<string, number>>();
    for (const s of series) {
      for (const d of s.data) {
        let entry = tsMap.get(d.ts);
        if (!entry) {
          entry = { ts: d.ts };
          tsMap.set(d.ts, entry);
        }
        entry[s.id] = d.netFlowUsd;
      }
    }
    return Array.from(tsMap.values()).sort((a, b) => a.ts - b.ts);
  })();

  if (mergedData.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm font-semibold">
            Net Flow Over Time
          </CardTitle>
          <div className="flex gap-1">
            {HOUR_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => onHoursChange(opt.value)}
                className={`rounded px-2 py-0.5 text-xs transition-colors ${
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
        <ResponsiveContainer width="100%" height={200}>
          <LineChart
            data={mergedData}
            margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          >
            <TimeXAxis dataKey="ts" />
            <MonoYAxis tickFormatter={formatFlowValue} />
            <ReferenceLine
              y={0}
              stroke="rgba(255,255,255,0.12)"
              strokeDasharray="4 4"
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                return (
                  <div className="rounded-lg border border-border/60 bg-card px-3 py-2 text-xs shadow-md space-y-1">
                    <p className="text-muted-foreground">
                      {formatChartDate(label as number, "short")}
                    </p>
                    {payload.map((p) => {
                      const val = p.value as number | null | undefined;
                      const formatted =
                        val != null
                          ? `${val >= 0 ? "+" : ""}${formatFlowValue(val)}`
                          : "—";
                      return (
                        <div
                          key={p.dataKey as string}
                          className="flex items-center gap-2"
                        >
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ background: p.color }}
                          />
                          <span className="text-muted-foreground">
                            {p.name}:
                          </span>
                          <span
                            className="font-mono font-semibold"
                            style={{ color: p.color }}
                          >
                            {formatted}
                          </span>
                        </div>
                      );
                    })}
                  </div>
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

        {/* Legend */}
        <div className="mt-2 flex flex-wrap gap-3">
          {series.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: s.color }}
              />
              {s.label}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
