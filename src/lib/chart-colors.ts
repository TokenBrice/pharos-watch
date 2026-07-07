/* ═══════════════════════════════════════════════════════════════════
   Chart Color Tokens
   Single source of truth for all chart colors. Hex values here match
   the --*-hex CSS custom properties in semantic.css.
   Recharts needs literal hex strings — CSS var() doesn't work in SVG
   fill/stroke attributes rendered by React.
   ═══════════════════════════════════════════════════════════════════ */

/** Centralized color tokens — edit here, not in individual components */
const TOKEN = {
  blue:     "#4bc4de",
  purple:   "#8b5cf6",
  pink:     "#ec4899",
  orange:   "#f97316",
  green:    "#3bcc87",
  cyan:     "#23a7c8",
  yellow:   "#eab308",
  red:      "#ef4444",
  indigo:   "#6366f1",
  teal:     "#14b8a6",
  amber:    "#f59e0b",
  lime:     "#84cc16",
  slate:    "#94a3b8",
  darkRed:  "#991b1b",
} as const;

export const CHART_PALETTE = [
  TOKEN.blue, TOKEN.purple, TOKEN.pink, TOKEN.orange, TOKEN.green,
  TOKEN.cyan, TOKEN.yellow, TOKEN.red, TOKEN.indigo, TOKEN.teal,
  TOKEN.amber, TOKEN.lime, TOKEN.slate,
];

/** Primary chart accent colors — import these instead of hardcoding hex values */
export const CHART_BLUE   = TOKEN.blue;
export const CHART_GREEN  = TOKEN.green;
export const CHART_ORANGE = TOKEN.orange;
export const CHART_RED    = TOKEN.red;
export const CHART_SLATE  = TOKEN.slate;
export const CHART_SLATE_SOFT = "#cbd5e1";
export const CHART_SLATE_STRONG = "#64748b";
export const CHART_AMBER  = TOKEN.amber;
export const CHART_TEAL   = TOKEN.teal;

/** Standard responsive chart container height */
export const CHART_HEIGHT = "h-[250px] sm:h-[350px]";

/** Standard Recharts tooltip styling (spread into <Tooltip> props) */
export const RECHARTS_TOOLTIP_STYLES = {
  contentStyle: {
    backgroundColor: "var(--color-card)",
    border: "1px solid color-mix(in oklch, var(--color-border) 70%, transparent)",
    borderRadius: "var(--radius-xl, 0.75rem)",
    fontFamily: "var(--font-mono)",
    boxShadow: "var(--elevation-rest)",
    padding: "0.75rem 0.875rem",
  },
  labelStyle: { color: "var(--color-foreground)", fontFamily: "var(--font-sans)", fontWeight: 500, fontSize: "0.75rem", marginBottom: "0.5rem" },
  itemStyle: { color: "var(--color-muted-foreground)", fontFamily: "var(--font-mono)", fontSize: "0.875rem" },
} as const;

export { THREAT_BAND_HEX } from "@shared/lib/classification";

// ---------------------------------------------------------------------------
// Extracted inline chart colors -- previously defined inside components.
// ---------------------------------------------------------------------------

/** Reserve risk-tier treemap block fills (Figma coin template): deep tinted
 *  solids sampled from the frame — very-low risk is BLUE per the design. */
export const RISK_COLORS: Record<string, string> = {
  "very-low": "#003362",
  low: "#123b29",
  medium: "#382a00",
  high: "#462000",
  "very-high": "#500f1c",
};

/** Bright accents paired with RISK_COLORS for the treemap legend, in-block
 *  percentage labels, and tooltips (Figma coin template). */
export const RISK_ACCENT_COLORS: Record<string, string> = {
  "very-low": "#3b82f6",
  low: "#22c55e",
  medium: "#eab308",
  high: "#f97316",
  "very-high": "#ef4444",
};

/** Per-DEWS-signal chart colors (from dews-detail.tsx) */
export const SIGNAL_CHART_COLORS: Record<string, string> = {
  supply: "#60a5fa",
  pool: "#fbbf24",
  liq: "#a78bfa",
  price: "#22d3ee",
  diverg: "#f472b6",
  black: "#f87171",
  flow: "#34d399",
  yield: "#fb923c",
};

/** Brand-specific colors for market-cap charts. */
export const USDT_GREEN = "#3bcc87";
export const USDC_BLUE = "#4bc4de";
