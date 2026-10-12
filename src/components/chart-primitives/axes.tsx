"use client";

import { useId, useMemo, type ComponentProps } from "react";
import { CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import { logTicks, niceTicks, niceTicksForValues, type NiceTicksOptions, type TickKind } from "@/lib/chart-ticks";
import { CHART_AXIS_TICK, CHART_GRID_DASH, CHART_GRID_STROKE, RECHARTS_TOOLTIP_STYLES } from "@/lib/chart-theme";
import { formatChartDate } from "@shared/lib/format";

export const MONO_Y_AXIS_WIDTH = 68;

/**
 * Returns a stable, SVG-safe id built from React's `useId()` with the given
 * prefix. Strips any characters that are illegal in SVG `id`/`url(#...)`
 * references so the value can be used for gradients, clip paths, etc.
 */
export function useSvgId(prefix: string): string {
  const rawId = useId();
  return `${prefix}-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

export interface ChartMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function usePlotInsets(margin: ChartMargin, yAxisWidth = MONO_Y_AXIS_WIDTH) {
  return useMemo(
    () => ({
      plotInsetLeft: margin.left + yAxisWidth,
      plotInsetRight: margin.right,
      plotInsetTop: margin.top,
      plotInsetBottom: margin.bottom,
    }),
    [margin, yAxisWidth],
  );
}

function formatDateLabel(value: unknown, locale: string, options: Intl.DateTimeFormatOptions): string {
  if (value == null) return "";
  const timestamp = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(timestamp)) return String(value);
  // The data contract is UTC: a viewer-local label would move a UTC-midnight
  // point to the previous day (or month) for most of the world.
  return new Date(timestamp).toLocaleDateString(locale, { timeZone: "UTC", ...options });
}

type TimeXAxisProps = ComponentProps<typeof XAxis>;

/** "Oct '26": the apostrophe keeps a two-digit year from reading as a day. */
function formatMonthYearTick(value: unknown): string {
  if (value == null) return "";
  const timestamp = typeof value === "number" ? value : Number(value);
  return Number.isNaN(timestamp) ? String(value) : formatChartDate(timestamp, "compact");
}

export function TimeXAxis({
  dataKey = "date",
  tickFormatter = formatMonthYearTick,
  ...props
}: TimeXAxisProps) {
  return (
    <XAxis
      dataKey={dataKey}
      type="number"
      scale="time"
      domain={["dataMin", "dataMax"]}
      tick={CHART_AXIS_TICK}
      tickLine={false}
      axisLine={false}
      tickMargin={10}
      tickFormatter={tickFormatter}
      {...props}
    />
  );
}

/**
 * `domain` + `ticks` for a data-driven value axis: the domain extends to the
 * outer 1/2/2.5/5 ticks. Spread into `MonoYAxis` (or a raw axis). Recharts'
 * own snap125 forces its tick count and can double the domain (0–2,150 →
 * 0–4,000), so auto-domain charts pass these instead.
 */
export function useNiceValueAxis(
  values: ReadonlyArray<number | null | undefined>,
  { kind, count, includeZero = true }: Pick<NiceTicksOptions, "kind" | "count" | "includeZero"> = {},
): { domain?: [number, number]; ticks?: number[] } {
  return useMemo(() => {
    const { domain, ticks } = niceTicksForValues(values, { kind, count, includeZero });
    return ticks.length > 0 ? { domain, ticks } : {};
  }, [values, kind, count, includeZero]);
}

type MonoYAxisProps = ComponentProps<typeof YAxis> & {
  /** Step rules for a fixed numeric `domain` (see `niceTicks`). */
  tickKind?: TickKind;
};

function isFixedNumericDomain(domain: unknown): domain is [number, number] {
  return Array.isArray(domain) && domain.length === 2 && domain.every((bound) => typeof bound === "number" && Number.isFinite(bound));
}

/**
 * Y axis with the shared tick theme and 1/2/2.5/5 ticks (log: 1/2/5 × 10^n). A
 * fixed linear domain widens to its outer nice ticks, so the top gridline caps
 * the data, and gets explicit ticks, because Recharts would otherwise append
 * the raw domain end (0/15/30/50). A log domain keeps its bounds. An
 * unresolved auto domain falls back to Recharts' `snap125`.
 */
export function MonoYAxis({
  tick = CHART_AXIS_TICK,
  tickLine = false,
  axisLine = false,
  width = MONO_Y_AXIS_WIDTH,
  tickMargin = 8,
  niceTicks: niceTicksMode = "snap125",
  tickKind,
  domain,
  ticks,
  scale,
  ...props
}: MonoYAxisProps) {
  const fixed = useMemo(() => {
    if (ticks !== undefined || !isFixedNumericDomain(domain)) return undefined;
    return scale === "log"
      ? logTicks(domain[0], domain[1], { extend: false })
      : niceTicks(domain[0], domain[1], { kind: tickKind });
  }, [domain, scale, tickKind, ticks]);
  return (
    <YAxis
      tick={tick}
      tickLine={tickLine}
      axisLine={axisLine}
      width={width}
      tickMargin={tickMargin}
      niceTicks={niceTicksMode}
      domain={fixed?.domain ?? domain}
      ticks={ticks ?? fixed?.ticks}
      scale={scale}
      {...props}
    />
  );
}

type CategoricalXAxisProps = ComponentProps<typeof XAxis>;

export function CategoricalXAxis({
  tick = CHART_AXIS_TICK,
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

type TimeGridProps = ComponentProps<typeof CartesianGrid>;

export function TimeGrid({
  strokeDasharray = CHART_GRID_DASH,
  stroke = CHART_GRID_STROKE,
  vertical = false,
  ...props
}: TimeGridProps) {
  return <CartesianGrid strokeDasharray={strokeDasharray} stroke={stroke} vertical={vertical} {...props} />;
}

export function ChartAreaGradient({ id, color }: { id: string; color: string }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="5%" stopColor={color} stopOpacity={0.3} />
      <stop offset="95%" stopColor={color} stopOpacity={0.05} />
    </linearGradient>
  );
}
