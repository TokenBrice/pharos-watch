"use client";

import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { CartesianGrid, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { RECHARTS_TOOLTIP_STYLES } from "@/lib/chart-colors";
import { cn } from "@/lib/utils";
import type {
  ChartAnnotation,
  ChartAnnotationKind,
} from "@shared/types/chart-annotation";

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

export function MonoYAxis({ tick = MONO_AXIS_TICK, tickLine = false, axisLine = false, width = 68, tickMargin = 8, ...props }: MonoYAxisProps) {
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
  /** When true, prefix each marker with a numbered badge (1, 2, 3...) tied to the legend order. */
  numbered?: boolean;
}

/**
 * Renders Recharts `<ReferenceLine>` markers for event annotations on
 * `McapChart` / `PegDeviationChart`. Vertical lines read clearly across the
 * full chart height and don't require a per-series y-value lookup.
 * `ifOverflow="hidden"` keeps out-of-range markers from extending the chart's
 * data domain (defence in depth with hook-side clamping).
 */
export function ChartAnnotationLines({ annotations, numbered = false }: ChartAnnotationLinesProps) {
  if (annotations.length === 0) return null;
  return (
    <>
      {annotations.map((a, i) => {
        const color = ANNOTATION_HEX_COLORS[a.kind];
        return (
          <ReferenceLine
            key={`${a.ts}-${a.kind}`}
            x={a.ts}
            ifOverflow="hidden"
            stroke={color}
            strokeWidth={1.25}
            strokeDasharray="2 4"
            strokeOpacity={0.7}
            label={
              numbered
                ? {
                    value: String(i + 1),
                    position: "insideTopRight",
                    fill: color,
                    fontSize: 10,
                    fontFamily: "var(--font-mono, monospace)",
                    fontWeight: 600,
                    offset: 4,
                  }
                : undefined
            }
          />
        );
      })}
    </>
  );
}

const ANNOTATION_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * Sighted legend rendered below `McapChart` / `PegDeviationChart`. Each entry
 * matches a `ChartAnnotationLines` reference line by `kind` color so users can
 * decode what the vertical lines mark. Keeps the `<ul>` semantic so screen
 * readers read the same event list.
 */
export function ChartAnnotationLegend({
  annotations,
  className = "mt-3 flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-muted-foreground",
  numbered = false,
}: {
  annotations: readonly ChartAnnotation[];
  /**
   * Override the `<ul>` className. Default includes the `mt-3` spacing used
   * when the legend sits directly under a chart card. Pass a className without
   * `mt-3` when the legend is rendered inside an already-padded container
   * (e.g. the shared legend below the Market Cap / Peg Deviation pair).
   */
  className?: string;
  /** When true, prefix each entry with its 1-based index to match numbered chart markers. */
  numbered?: boolean;
}) {
  if (annotations.length === 0) return null;
  return (
    <ul
      aria-label="Chart events"
      className={className}
    >
      {annotations.map((a, i) => {
        const date = ANNOTATION_DATE_FMT.format(new Date(a.ts));
        const color = ANNOTATION_HEX_COLORS[a.kind];
        const content = (
          <>
            {numbered ? (
              <span
                aria-hidden
                className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 font-mono text-[10px] font-semibold tabular-nums"
                style={{
                  color,
                  border: `1px solid ${color}`,
                  backgroundColor: `${color}1a`,
                }}
              >
                {i + 1}
              </span>
            ) : (
              <span
                aria-hidden
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
              />
            )}
            <span className="font-mono tabular-nums text-foreground/80">{date}</span>
            <span aria-hidden className="text-muted-foreground/60">—</span>
            <span className="text-foreground/80">{a.label}</span>
          </>
        );
        return (
          <li
            key={`${a.ts}-${a.kind}`}
            className="inline-flex items-baseline gap-1.5 leading-tight"
          >
            {a.href ? (
              <a
                href={a.href}
                target="_blank"
                rel="noreferrer noopener"
                className="pharos-focus-ring inline-flex items-baseline gap-1.5 rounded-sm underline-offset-2 hover:underline"
              >
                {content}
              </a>
            ) : (
              <span className="inline-flex items-baseline gap-1.5">{content}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
