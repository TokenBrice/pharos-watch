"use client";

import { cn } from "@/lib/utils";

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
function StaticTimeXAxis({
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
function StaticMonoYAxis({
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
function StaticTimeGrid({ width, height, margin, yAxisWidth, xAxisHeight, lineCount = 5 }: StaticTimeGridProps) {
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
      <StaticMonoYAxis {...geometry} tickCount={yTickCount} domain={yDomain} tickFormatter={yTickFormatter} />
      <StaticTimeXAxis {...geometry} tickCount={xTickCount} domain={xDomain} tickFormatter={xTickFormatter} />
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
