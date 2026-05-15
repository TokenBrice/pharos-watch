"use client";

import type { ComponentProps } from "react";
import { CartesianGrid, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { RECHARTS_TOOLTIP_STYLES } from "@/lib/chart-colors";
import type {
  ChartAnnotation,
  ChartAnnotationKind,
} from "@/hooks/use-chart-annotations";

const MONO_AXIS_TICK = {
  fontSize: 12,
  fontFamily: "var(--font-mono, monospace)",
  fill: "var(--color-muted-foreground)",
} as const;

function formatDateLabel(
  value: unknown,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): string {
  if (value == null) return "";
  const timestamp = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(timestamp)) return String(value);
  return new Date(timestamp).toLocaleDateString(locale, options);
}

type TimeXAxisProps = ComponentProps<typeof XAxis> & {
  locale?: string;
  dateFormat?: Intl.DateTimeFormatOptions;
};

export function TimeXAxis({
  dataKey = "date",
  locale = "en-US",
  dateFormat = { month: "short", year: "2-digit" },
  tickFormatter,
  ...props
}: TimeXAxisProps) {
  const resolvedTickFormatter =
    tickFormatter ??
    ((value: unknown) => formatDateLabel(value, locale, dateFormat));

  return (
    <XAxis
      dataKey={dataKey}
      type="number"
      scale="time"
      domain={["dataMin", "dataMax"]}
      tick={MONO_AXIS_TICK}
      tickLine={false}
      axisLine={false}
      tickMargin={10}
      tickFormatter={resolvedTickFormatter}
      {...props}
    />
  );
}

type MonoYAxisProps = ComponentProps<typeof YAxis>;

export function MonoYAxis({ tick = MONO_AXIS_TICK, tickLine = false, axisLine = false, width = 56, tickMargin = 8, ...props }: MonoYAxisProps) {
  return (
    <YAxis
      tick={tick}
      tickLine={tickLine}
      axisLine={axisLine}
      width={width}
      tickMargin={tickMargin}
      {...props}
    />
  );
}

type CategoricalXAxisProps = ComponentProps<typeof XAxis>;

export function CategoricalXAxis({
  tick = MONO_AXIS_TICK,
  tickLine = false,
  axisLine = false,
  ...props
}: CategoricalXAxisProps) {
  return (
    <XAxis
      tick={tick}
      tickLine={tickLine}
      axisLine={axisLine}
      {...props}
    />
  );
}

type DateTooltipProps = ComponentProps<typeof Tooltip> & {
  locale?: string;
  dateFormat?: Intl.DateTimeFormatOptions;
};

export function DateTooltip({
  locale = "en-US",
  dateFormat = { month: "short", day: "numeric", year: "numeric" },
  labelFormatter,
  ...props
}: DateTooltipProps) {
  const resolvedLabelFormatter =
    labelFormatter ??
    ((value: unknown) => formatDateLabel(value, locale, dateFormat));

  return (
    <Tooltip
      {...RECHARTS_TOOLTIP_STYLES}
      labelFormatter={resolvedLabelFormatter}
      {...props}
    />
  );
}

type TimeGridProps = ComponentProps<typeof CartesianGrid>;

export function ChartGrid({
  strokeDasharray = "2 6",
  stroke = "var(--color-border)",
  vertical = false,
  ...props
}: TimeGridProps) {
  return <CartesianGrid strokeDasharray={strokeDasharray} stroke={stroke} vertical={vertical} {...props} />;
}

export const TimeGrid = ChartGrid;

/**
 * Hex literals — Recharts SVG `fill` / `stroke` cannot resolve CSS variables,
 * so the annotation palette is kept here as the canonical source.
 */
const ANNOTATION_HEX_COLORS: Record<ChartAnnotationKind, string> = {
  "depeg": "#ef4444", // red-500
  "mint-burn-spike": "#3b82f6", // blue-500
  "blacklist-surge": "#f59e0b", // amber-500
  "governance": "#a855f7", // purple-500
  "regulatory": "#64748b", // slate-500
  "methodology-change": "#facc15", // amber-400
};

interface ChartAnnotationLinesProps {
  annotations: readonly ChartAnnotation[];
}

/**
 * Renders Recharts `<ReferenceLine>` markers for event annotations on
 * `McapChart` / `PegDeviationChart`. Vertical lines read clearly across the
 * full chart height and don't require a per-series y-value lookup.
 * `ifOverflow="hidden"` keeps out-of-range markers from extending the chart's
 * data domain (defence in depth with hook-side clamping).
 */
export function ChartAnnotationLines({ annotations }: ChartAnnotationLinesProps) {
  if (annotations.length === 0) return null;
  return (
    <>
      {annotations.map((a) => (
        <ReferenceLine
          key={`${a.ts}-${a.kind}`}
          x={a.ts}
          ifOverflow="hidden"
          stroke={ANNOTATION_HEX_COLORS[a.kind]}
          strokeWidth={1.5}
          strokeDasharray="3 3"
        />
      ))}
    </>
  );
}
