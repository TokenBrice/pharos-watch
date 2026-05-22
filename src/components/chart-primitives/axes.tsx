"use client";

import { type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import { RECHARTS_TOOLTIP_STYLES } from "@/lib/chart-colors";
import { cn } from "@/lib/utils";

const MONO_AXIS_TICK = {
  fontSize: 12,
  fontFamily: "var(--font-mono, monospace)",
  fill: "var(--color-muted-foreground)",
} as const;

function formatDateLabel(value: unknown, locale: string, options: Intl.DateTimeFormatOptions): string {
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
  const resolvedTickFormatter = tickFormatter ?? ((value: unknown) => formatDateLabel(value, locale, dateFormat));

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

export function MonoYAxis({
  tick = MONO_AXIS_TICK,
  tickLine = false,
  axisLine = false,
  width = 68,
  tickMargin = 8,
  ...props
}: MonoYAxisProps) {
  return <YAxis tick={tick} tickLine={tickLine} axisLine={axisLine} width={width} tickMargin={tickMargin} {...props} />;
}

type CategoricalXAxisProps = ComponentProps<typeof XAxis>;

export function CategoricalXAxis({
  tick = MONO_AXIS_TICK,
  tickLine = false,
  axisLine = false,
  ...props
}: CategoricalXAxisProps) {
  return <XAxis tick={tick} tickLine={tickLine} axisLine={axisLine} {...props} />;
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
  const resolvedLabelFormatter = labelFormatter ?? ((value: unknown) => formatDateLabel(value, locale, dateFormat));

  return <Tooltip {...RECHARTS_TOOLTIP_STYLES} labelFormatter={resolvedLabelFormatter} {...props} />;
}

export function ChartLegendChip({
  children,
  markerClassName = "inline-block h-2.5 w-2.5 rounded-full",
  markerStyle,
  className,
}: {
  children: ReactNode;
  markerClassName?: string;
  markerStyle?: CSSProperties;
  className?: string;
}) {
  return (
    <div className={cn("pharos-chart-legend-chip", className)}>
      <span aria-hidden className={markerClassName} style={markerStyle} />
      {children}
    </div>
  );
}

type TimeGridProps = ComponentProps<typeof CartesianGrid>;

export function TimeGrid({
  strokeDasharray = "2 6",
  stroke = "var(--color-border)",
  vertical = false,
  ...props
}: TimeGridProps) {
  return <CartesianGrid strokeDasharray={strokeDasharray} stroke={stroke} vertical={vertical} {...props} />;
}
