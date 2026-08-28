"use client";

import { Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip } from "recharts";
import { DateTooltip, MonoYAxis, TimeGrid, TimeXAxis } from "@/components/chart-primitives/axes";
import { ScreenReaderDataTable } from "@/components/chart-primitives/data-table";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import { mergeSeriesByTimestamp } from "@/lib/chart-utils";

export interface MultiSeriesLineChartSeries<D extends { ts: number }> {
  id: string;
  label: string;
  color: string;
  data: D[];
}

export function mergeMultiSeriesData<D extends { ts: number }>(
  series: readonly MultiSeriesLineChartSeries<D>[],
  getValue: (datum: D) => number,
): Record<string, number>[] {
  return mergeSeriesByTimestamp([...series], getValue);
}

interface MultiSeriesLineChartProps<D extends { ts: number }> {
  series: readonly MultiSeriesLineChartSeries<D>[];
  getValue: (datum: D) => number;
  data?: Record<string, number>[];
  ariaLabel: string;
  height: number | `${number}%`;
  className?: string;
  margin: { top: number; right: number; bottom: number; left: number };
  xTickFormatter: (timestamp: number) => string;
  yTickFormatter: (value: number) => string;
  valueFormatter: (value: number) => string;
  tooltipLabelFormatter: (timestamp: number) => string;
  tableDateFormatter: (timestamp: number) => string;
  tableCaption: (rows: ReadonlyArray<Record<string, number>>, truncated: boolean, total: number) => string;
  lineStrokeWidth?: number;
  minTickGap?: number;
  showGrid?: boolean;
  showZeroLine?: boolean;
  tooltipVariant?: "date" | "pharos";
}

export function MultiSeriesLineChart<D extends { ts: number }>({
  series,
  getValue,
  data,
  ariaLabel,
  height,
  className,
  margin,
  xTickFormatter,
  yTickFormatter,
  valueFormatter,
  tooltipLabelFormatter,
  tableDateFormatter,
  tableCaption,
  lineStrokeWidth = 2,
  minTickGap,
  showGrid = false,
  showZeroLine = false,
  tooltipVariant = "date",
}: MultiSeriesLineChartProps<D>) {
  const mergedData = data ?? mergeMultiSeriesData(series, getValue);

  return (
    <>
      <ScreenReaderDataTable
        data={mergedData}
        columns={[
          { id: "ts", label: "Date", format: (row) => tableDateFormatter(row.ts) },
          ...series.map((item) => ({
            id: item.id,
            label: item.label,
            format: (row: Record<string, number>) => row[item.id] == null ? "—" : valueFormatter(row[item.id]),
          })),
        ]}
        caption={tableCaption}
      />
      <div className={className} role="figure" aria-label={ariaLabel}>
        <ResponsiveContainer width="100%" height={height} minWidth={0} minHeight={0}>
          <LineChart data={mergedData} margin={margin}>
            {showGrid ? <TimeGrid /> : null}
            <TimeXAxis dataKey="ts" minTickGap={minTickGap} tickFormatter={xTickFormatter} />
            <MonoYAxis tickFormatter={yTickFormatter} />
            {showZeroLine ? <ReferenceLine y={0} stroke="var(--color-border)" strokeDasharray="4 4" /> : null}
            {tooltipVariant === "pharos" ? (
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <PharosChartTooltip active={active}>
                      <TooltipLabel>{tooltipLabelFormatter(Number(label))}</TooltipLabel>
                      {payload.map((item) => {
                        const seriesItem = series.find((candidate) => candidate.id === item.dataKey);
                        return (
                          <TooltipRow
                            key={String(item.dataKey)}
                            color={item.color}
                            label={seriesItem?.label ?? String(item.name ?? item.dataKey)}
                            value={item.value == null ? "—" : valueFormatter(Number(item.value))}
                          />
                        );
                      })}
                    </PharosChartTooltip>
                  );
                }}
              />
            ) : (
              <DateTooltip
                labelFormatter={(label) => tooltipLabelFormatter(Number(label))}
                formatter={(value, name) => {
                  const item = series.find((candidate) => candidate.id === name);
                  return [valueFormatter(Number(value)), item?.label ?? String(name ?? "")];
                }}
              />
            )}
            {series.map((item) => (
              <Line
                key={item.id}
                type="monotone"
                dataKey={item.id}
                name={item.id}
                stroke={item.color}
                strokeWidth={lineStrokeWidth}
                dot={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
