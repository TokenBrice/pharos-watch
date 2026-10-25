/* ═══════════════════════════════════════════════════════════════════
   Chart theme
   One set of axis, grid, stroke and tooltip-surface values for Recharts
   and hand-rolled SVG charts. Colors are CSS variables so both themes
   follow the token layer; series hues stay in chart-colors.ts.
   ═══════════════════════════════════════════════════════════════════ */

/** Tick labels: 11px mono figures in muted ink, on every axis. */
export const CHART_TICK_FONT_SIZE = 11;
export const CHART_TICK_FONT_FAMILY = "var(--font-mono, monospace)";
export const CHART_TICK_FILL = "var(--color-muted-foreground)";
export const MONO_Y_AXIS_WIDTH = 68;

/** Spread into a Recharts axis `tick` prop or onto a hand-rolled SVG tick `<text>`. */
export const CHART_AXIS_TICK = {
  fontSize: CHART_TICK_FONT_SIZE,
  fontFamily: CHART_TICK_FONT_FAMILY,
  fill: CHART_TICK_FILL,
} as const;

/** Axis titles ("APY %", "Safety Score"): sans, same size as ticks. */
export const CHART_AXIS_LABEL = {
  fontSize: CHART_TICK_FONT_SIZE,
  fill: CHART_TICK_FILL,
} as const;

/** Horizontal value gridlines: hairline, dotted, border ink. */
export const CHART_GRID_STROKE = "var(--color-border)";
export const CHART_GRID_DASH = "2 6";

/** Axis baseline, when a chart draws one. */
export const CHART_AXIS_LINE = { stroke: "var(--color-border)" } as const;

/** Reference lines (benchmark, threshold, zero): dashed, 1px. */
export const CHART_REFERENCE_DASH = "4 4";

export const CHART_STROKE_WIDTH = {
  /** The chart's primary series. */
  series: 2,
  /** Supporting or comparison series. */
  secondary: 1.5,
  /** Gridlines, reference lines, crosshairs. */
  guide: 1,
} as const;

/** Background band fills (regime, severity, quadrant) stay below the data. */
export const CHART_BAND_OPACITY = 0.12;

/**
 * Tooltip surface shared by `PharosChartTooltip`, `RECHARTS_TOOLTIP_STYLES`
 * and hand-positioned SVG readouts.
 */
export const CHART_TOOLTIP_SURFACE = {
  backgroundColor: "var(--color-card)",
  border: "1px solid color-mix(in oklch, var(--color-border) 70%, transparent)",
  borderRadius: "var(--radius-xl, 0.75rem)",
  boxShadow: "var(--elevation-raised)",
  padding: "0.75rem 0.875rem",
} as const;

/** Standard Recharts tooltip styling (spread into `<Tooltip>` props). */
export const RECHARTS_TOOLTIP_STYLES = {
  contentStyle: {
    ...CHART_TOOLTIP_SURFACE,
    fontFamily: "var(--font-mono)",
  },
  labelStyle: {
    color: "var(--color-foreground)",
    fontFamily: "var(--font-sans)",
    fontWeight: 600,
    fontSize: "0.75rem",
    marginBottom: "0.5rem",
  },
  itemStyle: { color: "var(--color-muted-foreground)", fontFamily: "var(--font-mono)", fontSize: "0.75rem" },
} as const;
