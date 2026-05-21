"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
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

// ---------------------------------------------------------------------------
// IDEA-15 — Standalone static axis frame for partial chart render
//
// These primitives render a geometry-matched SVG axis + grid frame that
// stands in for the Recharts chart until data resolves. The goal is for the
// frame not to re-flow when Recharts mounts: same plot rect, same tick
// positions, same dashed grid stroke.
// ---------------------------------------------------------------------------

/**
 * Default Recharts XAxis height with `axisLine={false}`, `tickLine={false}`,
 * `tickMargin={10}` and a 12px tick font. Empirically Recharts allocates
 * ~30px regardless of `tickMargin`, so we match that.
 */
const STATIC_X_AXIS_HEIGHT = 30;
const STATIC_Y_AXIS_WIDTH = 68;
const STATIC_TICK_FONT_SIZE = 12;
const STATIC_TICK_FILL = "var(--color-muted-foreground)";
const STATIC_GRID_STROKE = "var(--color-border)";
const STATIC_GRID_DASH = "2 6";

interface StaticChartGeometry {
  /** Total SVG width in px. */
  width: number;
  /** Total SVG height in px. */
  height: number;
  /** Chart margin matching the live `<AreaChart margin>` prop. */
  margin?: { top?: number; right?: number; bottom?: number; left?: number };
  /** YAxis width — must match the live `<MonoYAxis>` width. */
  yAxisWidth?: number;
  /** XAxis height; defaults to the empirical Recharts value (30). */
  xAxisHeight?: number;
}

interface PlotRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function computePlotRect({
  width,
  height,
  margin,
  yAxisWidth = STATIC_Y_AXIS_WIDTH,
  xAxisHeight = STATIC_X_AXIS_HEIGHT,
}: StaticChartGeometry): PlotRect {
  const top = margin?.top ?? 0;
  const right = margin?.right ?? 0;
  const bottom = margin?.bottom ?? 0;
  const left = margin?.left ?? 0;
  return {
    x0: left + yAxisWidth,
    x1: Math.max(left + yAxisWidth, width - right),
    y0: top,
    y1: Math.max(top, height - bottom - xAxisHeight),
  };
}

function buildEvenTicks(count: number): number[] {
  if (count <= 1) return [0];
  return Array.from({ length: count }, (_, i) => i / (count - 1));
}

interface StaticTimeXAxisProps extends StaticChartGeometry {
  /** Number of tick labels to render. Default 6 keeps the frame breathing. */
  tickCount?: number;
  /** Optional explicit domain `[startMs, endMs]`. Falls back to a 90-day window ending now. */
  domain?: [number, number];
  /** Optional formatter — defaults to a month/year label. */
  tickFormatter?: (timestamp: number) => string;
}

/**
 * Static SVG x-axis tick row. Geometry-matched to the live `<TimeXAxis>` so
 * the swap is a paint-only change.
 */
export function StaticTimeXAxis({
  width,
  height,
  margin,
  yAxisWidth,
  xAxisHeight = STATIC_X_AXIS_HEIGHT,
  tickCount = 6,
  domain,
  tickFormatter,
}: StaticTimeXAxisProps) {
  if (width <= 0 || height <= 0) return null;
  const { x0, x1, y1 } = computePlotRect({ width, height, margin, yAxisWidth, xAxisHeight });
  const [start, end] = domain ?? defaultTimeDomain();
  const formatter = tickFormatter ?? defaultTimeTickFormatter;

  return (
    <g aria-hidden>
      {buildEvenTicks(tickCount).map((t, i) => {
        const x = x0 + t * (x1 - x0);
        const ts = start + t * (end - start);
        return (
          <text
            key={i}
            x={x}
            y={y1 + 10 + STATIC_TICK_FONT_SIZE}
            fill={STATIC_TICK_FILL}
            fontFamily="var(--font-mono, monospace)"
            fontSize={STATIC_TICK_FONT_SIZE}
            textAnchor="middle"
            style={{ opacity: 0.75 }}
          >
            {formatter(ts)}
          </text>
        );
      })}
    </g>
  );
}

interface StaticMonoYAxisProps extends StaticChartGeometry {
  /** Number of tick labels. Default 5 matches Recharts. */
  tickCount?: number;
  /** Optional numeric domain `[min, max]`. Falls back to `[0, 100]`. */
  domain?: [number, number];
  /** Optional formatter — defaults to a plain integer. */
  tickFormatter?: (value: number) => string;
}

/**
 * Static SVG y-axis tick column. Right-aligned to the plot edge, matching Recharts.
 */
export function StaticMonoYAxis({
  width,
  height,
  margin,
  yAxisWidth = STATIC_Y_AXIS_WIDTH,
  xAxisHeight,
  tickCount = 5,
  domain,
  tickFormatter,
}: StaticMonoYAxisProps) {
  if (width <= 0 || height <= 0) return null;
  const { x0, y0, y1 } = computePlotRect({ width, height, margin, yAxisWidth, xAxisHeight });
  const [min, max] = domain ?? [0, 100];
  const formatter = tickFormatter ?? ((v: number) => String(Math.round(v)));

  return (
    <g aria-hidden>
      {buildEvenTicks(tickCount).map((t, i) => {
        // Screen Y inverts domain: top = max, bottom = min.
        const y = y0 + t * (y1 - y0);
        const value = max - t * (max - min);
        return (
          <text
            key={i}
            x={x0 - 8}
            y={y + STATIC_TICK_FONT_SIZE / 2 - 2}
            fill={STATIC_TICK_FILL}
            fontFamily="var(--font-mono, monospace)"
            fontSize={STATIC_TICK_FONT_SIZE}
            textAnchor="end"
            style={{ opacity: 0.75 }}
          >
            {formatter(value)}
          </text>
        );
      })}
    </g>
  );
}

interface StaticTimeGridProps extends StaticChartGeometry {
  /** Number of horizontal grid lines, including the top/bottom edges. Default 5. */
  lineCount?: number;
}

/**
 * Horizontal dashed grid lines matching `<TimeGrid>`'s `strokeDasharray="2 6"` style.
 */
export function StaticTimeGrid({
  width,
  height,
  margin,
  yAxisWidth,
  xAxisHeight,
  lineCount = 5,
}: StaticTimeGridProps) {
  if (width <= 0 || height <= 0) return null;
  const { x0, x1, y0, y1 } = computePlotRect({ width, height, margin, yAxisWidth, xAxisHeight });
  return (
    <g aria-hidden>
      {buildEvenTicks(lineCount).map((t, i) => {
        const y = y0 + t * (y1 - y0);
        return (
          <line
            key={i}
            x1={x0}
            x2={x1}
            y1={y}
            y2={y}
            stroke={STATIC_GRID_STROKE}
            strokeDasharray={STATIC_GRID_DASH}
            strokeWidth={1}
            style={{ opacity: 0.6 }}
          />
        );
      })}
    </g>
  );
}

interface ChartShellSkeletonProps extends StaticChartGeometry {
  /** Optional className applied to the outer `<svg>`. */
  className?: string;
  /** X-axis tick count. */
  xTickCount?: number;
  /** Y-axis tick count. */
  yTickCount?: number;
  /** X-axis domain. */
  xDomain?: [number, number];
  /** Y-axis domain. */
  yDomain?: [number, number];
  /** X tick formatter. */
  xTickFormatter?: (timestamp: number) => string;
  /** Y tick formatter. */
  yTickFormatter?: (value: number) => string;
  /** Accessibility label for the placeholder frame. Default: "Chart loading". */
  ariaLabel?: string;
}

/**
 * Composite static frame — grid + y-axis + x-axis — sized to the chart
 * container so when Recharts mounts the axes do not re-flow.
 *
 * Returns `null` if width/height are zero so the parent can render a fallback
 * (typically `<ChartSkeleton>`) until the container's `ResizeObserver` fires.
 */
export function ChartShellSkeleton({
  className,
  width,
  height,
  margin,
  yAxisWidth,
  xAxisHeight,
  xTickCount,
  yTickCount,
  xDomain,
  yDomain,
  xTickFormatter,
  yTickFormatter,
  ariaLabel = "Chart loading",
}: ChartShellSkeletonProps) {
  if (width <= 0 || height <= 0) return null;
  const geometry: StaticChartGeometry = { width, height, margin, yAxisWidth, xAxisHeight };
  return (
    <svg
      className={cn("pharos-chart-shell-skeleton", className)}
      width={width}
      height={height}
      role="img"
      aria-label={ariaLabel}
    >
      <StaticTimeGrid {...geometry} />
      <StaticMonoYAxis
        {...geometry}
        tickCount={yTickCount}
        domain={yDomain}
        tickFormatter={yTickFormatter}
      />
      <StaticTimeXAxis
        {...geometry}
        tickCount={xTickCount}
        domain={xDomain}
        tickFormatter={xTickFormatter}
      />
    </svg>
  );
}

const DEFAULT_TIME_TICK_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
});

function defaultTimeTickFormatter(timestamp: number): string {
  return DEFAULT_TIME_TICK_FMT.format(new Date(timestamp));
}

const DEFAULT_PLACEHOLDER_DAYS = 90;

function defaultTimeDomain(): [number, number] {
  const end = Date.now();
  const start = end - DEFAULT_PLACEHOLDER_DAYS * 24 * 60 * 60 * 1000;
  return [start, end];
}

/**
 * Hex literals — Recharts SVG `fill` / `stroke` cannot resolve CSS variables,
 * so the annotation palette is kept here as the canonical source.
 */
export const ANNOTATION_HEX_COLORS: Record<ChartAnnotationKind, string> = {
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

// ---------------------------------------------------------------------------
// D5 — Linear / Log Y-axis toggle
// ---------------------------------------------------------------------------

export type ChartScale = "lin" | "log";

interface ChartScaleToggleProps {
  value: ChartScale;
  onChange: (next: ChartScale) => void;
  /**
   * Greys out both buttons (the active pill still reads as the current
   * setting). Use when log scale is mathematically misleading for the active
   * view (stacked area, etc.) so users can still see *what would happen* but
   * can't trip themselves up.
   */
  disabled?: boolean;
  /** `title=` rendered when disabled — explain *why* the toggle is locked. */
  disabledTitle?: string;
  className?: string;
}

/**
 * `LIN / LOG` scale toggle modelled on `TimeRangeButtons` so it reads as the
 * same control family. Used on supply / market-cap charts where the data
 * spans multiple orders of magnitude (USDT vs the long tail).
 *
 * IMPORTANT: log + stacked area = misleading (areas don't sum on a log axis).
 * Pass `disabled` in stacked layouts with a `disabledTitle` explanation.
 */
export function ChartScaleToggle({
  value,
  onChange,
  disabled = false,
  disabledTitle,
  className,
}: ChartScaleToggleProps) {
  const options: ChartScale[] = ["lin", "log"];
  return (
    <div
      className={cn("flex gap-1", disabled && "opacity-50", className)}
      role="radiogroup"
      aria-label="Y-axis scale"
      title={disabled ? disabledTitle : undefined}
    >
      {options.map((opt) => {
        const isActive = value === opt;
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={isActive}
            disabled={disabled}
            onClick={() => onChange(opt)}
            className={cn(
              "pharos-focus-ring pharos-control-pill px-2.5 sm:py-1 text-[10px] tracking-wider",
              isActive ? "pharos-control-pill-active" : "",
              disabled && "cursor-not-allowed",
            )}
          >
            {opt.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// D4 — Linked-axis brushing + synchronized crosshair context
// ---------------------------------------------------------------------------

/**
 * Brushed time window as `[fromMs, toMs]`. `null` means "no brush — show the
 * full controlled range". When set, both paired charts re-domain to the
 * window.
 */
export type BrushedRange = readonly [number, number] | null;

interface MarketDataChartSync {
  /** Currently hovered timestamp on either chart, or null. */
  hoveredTs: number | null;
  setHoveredTs: (ts: number | null) => void;
  brushedRange: BrushedRange;
  setBrushedRange: (next: BrushedRange) => void;
}

const MarketDataChartSyncContext = createContext<MarketDataChartSync | null>(null);

/**
 * Provides shared hover + brush state to the McapChart / PegDeviationChart
 * pair in `MarketDataSection`. Both charts subscribe via
 * `useMarketDataChartSync` and broadcast their hovered timestamp + brushed
 * window. The context is intentionally narrow — it's a UI sync channel, not a
 * data store.
 */
export function MarketDataChartSyncProvider({ children }: { children: ReactNode }) {
  const [hoveredTs, setHoveredTsState] = useState<number | null>(null);
  const [brushedRange, setBrushedRangeState] = useState<BrushedRange>(null);
  const setHoveredTs = useCallback((ts: number | null) => setHoveredTsState(ts), []);
  const setBrushedRange = useCallback(
    (next: BrushedRange) => setBrushedRangeState(next),
    [],
  );
  const value = useMemo(
    () => ({ hoveredTs, setHoveredTs, brushedRange, setBrushedRange }),
    [hoveredTs, brushedRange, setHoveredTs, setBrushedRange],
  );
  return (
    <MarketDataChartSyncContext.Provider value={value}>{children}</MarketDataChartSyncContext.Provider>
  );
}

/**
 * Optional consumer of `MarketDataChartSyncContext`. Returns `null` when used
 * outside the provider so the same chart components can render standalone
 * (e.g. on the home page) without forcing the provider.
 */
export function useMarketDataChartSync(): MarketDataChartSync | null {
  return useContext(MarketDataChartSyncContext);
}

// ---------------------------------------------------------------------------
// D4 — Custom SVG brush strip
// ---------------------------------------------------------------------------

interface ChartBrushProps {
  /** Full data window the brush can select within (the parent controlled range). */
  domain: readonly [number, number];
  /** Currently selected window. `null` = whole domain. */
  value: BrushedRange;
  onChange: (next: BrushedRange) => void;
  /** Strip height in px. */
  height?: number;
  className?: string;
}

/**
 * Thin SVG drag region for selecting a `[fromMs, toMs]` window. Intentionally
 * lightweight — Recharts' built-in `<Brush>` is heavy and styled to its
 * defaults; this primitive talks directly to the
 * `MarketDataChartSyncContext` shape (`BrushedRange`) so consumers can wire
 * it into linked charts.
 *
 * Interaction model:
 *   - Click-drag on the empty strip starts a new selection.
 *   - Drag the body of an existing selection to translate it.
 *   - Drag either edge handle to resize.
 *   - Double-click clears the brush.
 */
export function ChartBrush({
  domain,
  value,
  onChange,
  height = 28,
  className,
}: ChartBrushProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const dragRef = useRef<
    | null
    | { mode: "new"; anchor: number }
    | { mode: "move"; startPx: number; startRange: readonly [number, number] }
    | { mode: "resize"; edge: "from" | "to"; otherTs: number }
  >(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const [domainFrom, domainTo] = domain;
  const span = Math.max(1, domainTo - domainFrom);

  const tsToPx = useCallback(
    (ts: number) => ((ts - domainFrom) / span) * width,
    [domainFrom, span, width],
  );
  const pxToTs = useCallback(
    (px: number) => {
      const clamped = Math.max(0, Math.min(width, px));
      return domainFrom + (clamped / Math.max(1, width)) * span;
    },
    [domainFrom, span, width],
  );

  const handlePointerDown = (
    e: ReactPointerEvent<SVGRectElement>,
    mode: "new" | "move" | "from" | "to",
  ) => {
    if (width <= 0) return;
    const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!rect) return;
    const px = e.clientX - rect.left;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (mode === "new") {
      dragRef.current = { mode: "new", anchor: pxToTs(px) };
      onChange([pxToTs(px), pxToTs(px)]);
    } else if (mode === "move" && value) {
      dragRef.current = { mode: "move", startPx: px, startRange: value };
    } else if ((mode === "from" || mode === "to") && value) {
      const otherTs = mode === "from" ? value[1] : value[0];
      dragRef.current = { mode: "resize", edge: mode, otherTs };
    }
  };

  const handlePointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (drag.mode === "new") {
      const cur = pxToTs(px);
      const lo = Math.min(drag.anchor, cur);
      const hi = Math.max(drag.anchor, cur);
      onChange([lo, hi]);
    } else if (drag.mode === "move") {
      const deltaTs = (px - drag.startPx) * (span / Math.max(1, width));
      let lo = drag.startRange[0] + deltaTs;
      let hi = drag.startRange[1] + deltaTs;
      const win = hi - lo;
      if (lo < domainFrom) {
        lo = domainFrom;
        hi = lo + win;
      }
      if (hi > domainTo) {
        hi = domainTo;
        lo = hi - win;
      }
      onChange([lo, hi]);
    } else if (drag.mode === "resize") {
      const cur = pxToTs(px);
      const lo = Math.min(drag.otherTs, cur);
      const hi = Math.max(drag.otherTs, cur);
      onChange([lo, hi]);
    }
  };

  const handlePointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    // Drop trivially-thin selections (< 0.5% of span) — treat as a click-to-clear.
    if (value && drag) {
      const winMs = value[1] - value[0];
      if (winMs < span * 0.005) {
        onChange(null);
      }
    }
    try {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore — pointer wasn't captured by this element
    }
  };

  const handleDoubleClick = () => onChange(null);

  const fromPx = value ? tsToPx(value[0]) : 0;
  const toPx = value ? tsToPx(value[1]) : 0;

  return (
    <div ref={containerRef} className={cn("relative w-full select-none", className)}>
      <svg
        width={width}
        height={height}
        role="slider"
        aria-label="Brush time window"
        aria-valuemin={domainFrom}
        aria-valuemax={domainTo}
        aria-valuenow={value ? value[0] : domainFrom}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        style={{ touchAction: "none" }}
      >
        {/* Background track */}
        <rect
          x={0}
          y={height / 2 - 2}
          width={width}
          height={4}
          rx={2}
          fill="var(--color-border)"
          fillOpacity={0.4}
        />
        {/* Click-to-create capture layer */}
        <rect
          x={0}
          y={0}
          width={width}
          height={height}
          fill="transparent"
          cursor={value ? "default" : "crosshair"}
          onPointerDown={(e) => !value && handlePointerDown(e, "new")}
        />
        {value ? (
          <>
            {/* Selection body */}
            <rect
              x={Math.min(fromPx, toPx)}
              y={height / 2 - 6}
              width={Math.abs(toPx - fromPx)}
              height={12}
              rx={3}
              fill="var(--color-foreground)"
              fillOpacity={0.18}
              stroke="var(--color-foreground)"
              strokeOpacity={0.55}
              strokeWidth={1}
              cursor="grab"
              onPointerDown={(e) => handlePointerDown(e, "move")}
            />
            {/* Edge handles */}
            <rect
              x={fromPx - 4}
              y={height / 2 - 8}
              width={8}
              height={16}
              rx={2}
              fill="var(--color-foreground)"
              fillOpacity={0.75}
              cursor="ew-resize"
              onPointerDown={(e) => handlePointerDown(e, "from")}
            />
            <rect
              x={toPx - 4}
              y={height / 2 - 8}
              width={8}
              height={16}
              rx={2}
              fill="var(--color-foreground)"
              fillOpacity={0.75}
              cursor="ew-resize"
              onPointerDown={(e) => handlePointerDown(e, "to")}
            />
          </>
        ) : null}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// D14 — Annotation density strip (1-D histogram by quarter)
// ---------------------------------------------------------------------------

/**
 * Bin annotations into calendar quarters. Returns one entry per quarter that
 * contains at least one annotation. Each entry carries the dominant
 * `ChartAnnotationKind` so the strip's bar can be colored by the
 * `ANNOTATION_HEX_COLORS` palette.
 */
export function bucketAnnotationsByQuarter(
  annotations: readonly ChartAnnotation[],
): Array<{ startMs: number; endMs: number; count: number; dominantKind: ChartAnnotationKind }> {
  if (annotations.length === 0) return [];
  const buckets = new Map<
    string,
    { startMs: number; endMs: number; counts: Map<ChartAnnotationKind, number> }
  >();
  for (const a of annotations) {
    const d = new Date(a.ts);
    const year = d.getUTCFullYear();
    const q = Math.floor(d.getUTCMonth() / 3); // 0..3
    const key = `${year}-Q${q}`;
    let entry = buckets.get(key);
    if (!entry) {
      const start = Date.UTC(year, q * 3, 1);
      const end = Date.UTC(year, q * 3 + 3, 1) - 1;
      entry = { startMs: start, endMs: end, counts: new Map() };
      buckets.set(key, entry);
    }
    entry.counts.set(a.kind, (entry.counts.get(a.kind) ?? 0) + 1);
  }
  return Array.from(buckets.values()).map((b) => {
    let dominant: ChartAnnotationKind = "depeg";
    let maxCount = -1;
    let total = 0;
    for (const [kind, count] of b.counts) {
      total += count;
      if (count > maxCount) {
        maxCount = count;
        dominant = kind;
      }
    }
    return { startMs: b.startMs, endMs: b.endMs, count: total, dominantKind: dominant };
  });
}

interface AnnotationDensityStripProps {
  annotations: readonly ChartAnnotation[];
  /** Domain to scale bins to (full visible chart x-domain). */
  domain: readonly [number, number];
  /** Plotting plot-area width — matches the SVG x-axis pixel range. */
  width: number;
  /** Strip height in px. Default 6, matches the spec. */
  height?: number;
  /** Optional className for the wrapper. */
  className?: string;
}

/**
 * Thin "event density" strip. Quarterly bars sized by count, colored by the
 * dominant kind in each bin. Pure SVG — no Recharts dependency — so it can
 * sit below the chart's x-axis without disturbing Recharts' margin model.
 */
export function AnnotationDensityStrip({
  annotations,
  domain,
  width,
  height = 6,
  className,
}: AnnotationDensityStripProps) {
  const bins = useMemo(() => bucketAnnotationsByQuarter(annotations), [annotations]);
  if (bins.length === 0 || width <= 0) return null;
  const [from, to] = domain;
  const span = Math.max(1, to - from);
  const maxCount = bins.reduce((acc, b) => Math.max(acc, b.count), 0);
  return (
    <div className={cn("relative w-full", className)}>
      <svg width={width} height={height} aria-hidden>
        {bins.map((b, i) => {
          const clampedStart = Math.max(from, b.startMs);
          const clampedEnd = Math.min(to, b.endMs);
          if (clampedEnd <= clampedStart) return null;
          const x = ((clampedStart - from) / span) * width;
          const w = Math.max(2, ((clampedEnd - clampedStart) / span) * width);
          const alpha = 0.35 + 0.55 * (b.count / Math.max(1, maxCount));
          const color = ANNOTATION_HEX_COLORS[b.dominantKind];
          return (
            <rect
              key={`${b.startMs}-${i}`}
              x={x}
              y={0}
              width={w - 1}
              height={height}
              rx={1}
              fill={color}
              fillOpacity={alpha}
            >
              <title>
                {`${b.count} event${b.count === 1 ? "" : "s"} · ${new Date(b.startMs).toLocaleDateString("en-US", { month: "short", year: "numeric" })}`}
              </title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// D4 — Synchronized SVG crosshair (absolutely-positioned overlay)
// ---------------------------------------------------------------------------

interface ChartCrosshairOverlayProps {
  /** Hovered ms timestamp (or null to hide). */
  hoveredTs: number | null;
  /** First / last ts of the visible data window — the chart's x-domain. */
  domain: readonly [number, number] | null;
  /**
   * Plot-area inset (px) from the wrapper's left edge. Should match the
   * Recharts `<YAxis width>` (default 68 via `MonoYAxis`).
   */
  plotInsetLeft: number;
  /** Plot-area inset from the wrapper's right edge. Matches chart `margin.right`. */
  plotInsetRight: number;
  /** Top inset matching the chart's `margin.top`. */
  plotInsetTop: number;
  /** Bottom inset matching the chart's `margin.bottom` (the x-axis area). */
  plotInsetBottom: number;
  className?: string;
}

/**
 * Vertical hairline drawn over the chart's plot area at the x-position of
 * `hoveredTs`. Rendered as an absolutely-positioned overlay so the same
 * primitive works against any Recharts chart layout — we don't depend on
 * Recharts injecting internal axis maps.
 *
 * Use case: paired charts subscribing to the same shared `hoveredTs` via
 * `MarketDataChartSyncContext`. Hover on chart A → both A and B render a
 * matched hairline at the same timestamp.
 */
export function ChartCrosshairOverlay({
  hoveredTs,
  domain,
  plotInsetLeft,
  plotInsetRight,
  plotInsetTop,
  plotInsetBottom,
  className,
}: ChartCrosshairOverlayProps) {
  if (hoveredTs == null || !domain) return null;
  const [from, to] = domain;
  if (hoveredTs < from || hoveredTs > to || to <= from) return null;
  const t = (hoveredTs - from) / (to - from);
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute", className)}
      style={{
        left: plotInsetLeft,
        right: plotInsetRight,
        top: plotInsetTop,
        bottom: plotInsetBottom,
      }}
    >
      <div
        className="absolute top-0 bottom-0 border-l border-dashed border-foreground/55"
        style={{ left: `${t * 100}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// IDEA-4 — Screen-reader chart data tables
// ---------------------------------------------------------------------------

export interface ChartDataTableColumn<T> {
  /** Unique column id; also used as `<th>` key. */
  id: string;
  /** Header label rendered inside `<th scope="col">`. */
  label: string;
  /**
   * Cell formatter. Receives the raw row + a `key` matching `id`. Return a
   * plain string — the table only renders text content for AT clarity.
   */
  format: (row: T) => string;
}

interface ChartDataTableProps<T> {
  /** Caption describing the chart contents (e.g. "Market cap over 90 days"). */
  caption: string;
  /** Rows to render. Pass a summarised subset for long series. */
  data: ReadonlyArray<T>;
  /** Column descriptors. */
  columns: ReadonlyArray<ChartDataTableColumn<T>>;
  /**
   * When true (default) the table is `sr-only` and not visible to sighted
   * users. When false the table is rendered as a normal disclosure body.
   */
  srOnly?: boolean;
  /** Optional className applied to the outer wrapper. */
  className?: string;
}

/**
 * Renders the underlying chart series as a semantic `<table>` so screen
 * readers can announce the actual values. Pair with `ChartDataTableDisclosure`
 * to give low-vision sighted users a visible toggle.
 *
 * Note: keep `data` summarised. For multi-year time-series, cap to ~90 rows
 * and call that out in the caption so the announcement isn't misleading.
 */
export function ChartDataTable<T>({
  caption,
  data,
  columns,
  srOnly = true,
  className,
}: ChartDataTableProps<T>) {
  const wrapperClassName = srOnly ? cn("sr-only", className) : className;
  return (
    <div className={wrapperClassName}>
      <table className={srOnly ? undefined : "w-full border-collapse text-xs"}>
        <caption className={srOnly ? undefined : "mb-2 text-left text-xs text-muted-foreground"}>
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.id}
                scope="col"
                className={
                  srOnly
                    ? undefined
                    : "border-b border-border/60 px-2 py-1.5 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
                }
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((col, colIndex) => {
                const value = col.format(row);
                if (colIndex === 0) {
                  return (
                    <th
                      key={col.id}
                      scope="row"
                      className={
                        srOnly
                          ? undefined
                          : "border-b border-border/30 px-2 py-1 text-left font-mono tabular-nums text-foreground/85"
                      }
                    >
                      {value}
                    </th>
                  );
                }
                return (
                  <td
                    key={col.id}
                    className={
                      srOnly
                        ? undefined
                        : "border-b border-border/30 px-2 py-1 text-left font-mono tabular-nums text-foreground/85"
                    }
                  >
                    {value}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ChartDataTableDisclosureProps<T> extends ChartDataTableProps<T> {
  /** Label for the closed state. Defaults to "Show as table". */
  showLabel?: string;
  /** Label for the open state. Defaults to "Hide table". */
  hideLabel?: string;
  /** Optional className applied to the toggle button. */
  buttonClassName?: string;
}

/**
 * Disclosure pair: a small "Show as table" button + a lazily-rendered visible
 * data table. While closed, the sr-only table is always present so screen
 * readers can still announce the data. While open, the visible table replaces
 * the sr-only one.
 */
export function ChartDataTableDisclosure<T>({
  caption,
  data,
  columns,
  showLabel = "Show as table",
  hideLabel = "Hide table",
  buttonClassName,
  className,
}: ChartDataTableDisclosureProps<T>) {
  const [open, setOpen] = useState(false);
  const tableId = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={tableId}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          "pharos-focus-ring pharos-control-pill px-2.5 sm:py-1 text-[10px] tracking-wider",
          buttonClassName,
        )}
      >
        {open ? hideLabel : showLabel}
      </button>
      <div id={tableId} className={cn("w-full", className)}>
        <ChartDataTable
          caption={caption}
          data={data}
          columns={columns}
          srOnly={!open}
        />
      </div>
    </>
  );
}

/**
 * Cap a time-series for screen-reader table rendering. Keeps the most recent
 * `maxRows` rows in chronological order. Returns the capped slice plus a flag
 * indicating whether the original series was truncated, so callers can amend
 * the table caption.
 */
export function capDataForTable<T>(
  data: ReadonlyArray<T>,
  maxRows: number,
): { rows: ReadonlyArray<T>; truncated: boolean } {
  if (data.length <= maxRows) return { rows: data, truncated: false };
  return { rows: data.slice(data.length - maxRows), truncated: true };
}
