"use client";

import { useCallback, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TimeRangeButtons } from "@/components/time-range-buttons";
import { useTimeRangeFilter } from "@/hooks/use-time-range-filter";
import type { TimeRangeOption } from "@/hooks/use-time-range-filter";
import { ChartLegendChip, DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives/axes";
import { formatChartDate, formatChartPercent } from "@shared/lib/format";
import { mergeSeriesByTimestamp } from "@/lib/chart-utils";
import type { SupplySeriesEntry } from "@/lib/compare-derive";

interface ComparisonChartProps {
  title: string;
  series: SupplySeriesEntry[];
  formatValue?: (v: number) => string;
  range?: TimeRangeOption;
  onRangeChange?: (range: TimeRangeOption) => void;
  normalizable?: boolean;
}

export function ComparisonChart({
  title,
  series,
  formatValue,
  range,
  onRangeChange,
  normalizable,
}: ComparisonChartProps) {
  const [normalized, setNormalized] = useState(false);
  // Merge all series into a single array keyed by timestamp
  const mergedData = useMemo(
    () => mergeSeriesByTimestamp(series, (d) => d.value),
    [series],
  );

  const { range: activeRange, setRange: setLocalRange, filteredData, options } = useTimeRangeFilter(
    mergedData,
    "ts",
    undefined,
    { externalRange: range },
  );

  const handleRangeChange = useCallback((r: TimeRangeOption) => {
    setLocalRange(r);
    onRangeChange?.(r);
  }, [setLocalRange, onRangeChange]);

  // Normalize: percent change from first available value per series
  const displayData = useMemo(() => {
    if (!normalized || filteredData.length === 0) return filteredData;
    const firstValues: Record<string, number> = {};
    for (const s of series) {
      for (const row of filteredData) {
        const val = row[s.id];
        if (typeof val === "number" && val > 0) {
          firstValues[s.id] = val;
          break;
        }
      }
    }
    return filteredData.map((row) => {
      const norm: Record<string, number> = { ts: row.ts };
      for (const s of series) {
        const val = row[s.id];
        const first = firstValues[s.id];
        if (typeof val === "number" && first) {
          norm[s.id] = ((val / first) - 1) * 100;
        }
      }
      return norm;
    });
  }, [normalized, filteredData, series]);

  // Determine XAxis date format based on selected range
  const formatTimestamp = useCallback((ts: number) => {
    if (activeRange === "7d" || activeRange === "30d") {
      return formatChartDate(ts, "short");
    }
    return formatChartDate(ts, "compact");
  }, [activeRange]);

  const defaultFormat = (v: number) => v.toLocaleString();
  const valueFormatter = formatValue ?? defaultFormat;
  const activeFormatter = normalized
    ? (v: number) => formatChartPercent(v)
    : valueFormatter;

  return (
    <Card className="pharos-card-shell animate-in fade-in duration-300">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <p className="pharos-kicker">Comparison Chart</p>
          <CardTitle as="h2" className="pharos-section-title">
            {title}
          </CardTitle>
          <p className="pharos-meta">
            Read absolute scale first, then switch to normalized mode to compare trajectory instead of raw size.
          </p>
        </div>
        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          {normalizable && (
            <div className="flex gap-1">
              <button type="button"
                onClick={() => setNormalized(false)}
                aria-pressed={!normalized}
                className={`pharos-focus-ring pharos-control-pill px-2.5 py-1 ${
                  !normalized ? "pharos-control-pill-active" : ""
                }`}
              >
                Absolute
              </button>
              <button type="button"
                onClick={() => setNormalized(true)}
                aria-pressed={normalized}
                className={`pharos-focus-ring pharos-control-pill px-2.5 py-1 ${
                  normalized ? "pharos-control-pill-active" : ""
                }`}
              >
                Normalized %
              </button>
            </div>
          )}
          <TimeRangeButtons options={options} value={activeRange} onChange={handleRangeChange} />
        </div>
      </CardHeader>
      <CardContent>
        {series.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {series.map((s) => (
              <ChartLegendChip
                key={s.id}
                markerClassName="inline-block h-0.5 w-4 rounded-full"
                markerStyle={{ backgroundColor: s.color }}
              >
                <span>{s.label}</span>
              </ChartLegendChip>
            ))}
          </div>
        )}
        {displayData.length > 0 ? (
          <div className="pharos-chart-stage">
            <div
              className="h-[300px] sm:h-[400px]"
              role="figure"
              aria-label={`${title} comparison chart with ${series.length} series`}
            >
              <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                <LineChart
                  data={displayData}
                  margin={{ top: 8, right: 8, bottom: 16, left: 0 }}
                >
                  <TimeGrid />
                  <TimeXAxis
                    dataKey="ts"
                    minTickGap={72}
                    tickFormatter={formatTimestamp}
                  />
                  <MonoYAxis tickFormatter={activeFormatter} />
                  <DateTooltip
                    formatter={(value, name) => {
                      const match = series.find((s) => s.id === name);
                      return [activeFormatter(Number(value)), match?.label ?? String(name ?? "")];
                    }}
                  />
                  {series.map((s) => (
                    <Line
                      key={s.id}
                      type="monotone"
                      dataKey={s.id}
                      name={s.id}
                      stroke={s.color}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        ) : (
          <div className="pharos-empty-note flex h-[300px] sm:h-[400px] items-center justify-center text-center">
            No comparison data is available for the current set and time window.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
