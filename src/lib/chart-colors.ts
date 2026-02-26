/* ═══════════════════════════════════════════════════════════════════
   Chart Color Tokens
   Single source of truth for all chart colors. Hex values here match
   the --*-hex CSS custom properties in semantic.css.
   Recharts needs literal hex strings — CSS var() doesn't work in SVG
   fill/stroke attributes rendered by React.
   ═══════════════════════════════════════════════════════════════════ */

/** Centralized color tokens — edit here, not in individual components */
const TOKEN = {
  blue:     "#3b82f6",
  purple:   "#8b5cf6",
  pink:     "#ec4899",
  orange:   "#f97316",
  green:    "#10b981",
  cyan:     "#06b6d4",
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
export const CHART_BLUE  = TOKEN.blue;
export const CHART_GREEN = TOKEN.green;
export const CHART_TEAL  = TOKEN.teal;
export const CHART_RED   = TOKEN.red;

/** Standard responsive chart container height */
export const CHART_HEIGHT = "h-[250px] sm:h-[350px]";

/** Standard Recharts tooltip styling (spread into <Tooltip> props) */
export const RECHARTS_TOOLTIP_STYLES = {
  contentStyle: {
    backgroundColor: "var(--color-card)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-lg, 0.5rem)",
    fontFamily: "var(--font-mono)",
  },
  labelStyle: { color: "var(--color-foreground)", fontFamily: "var(--font-sans)" },
  itemStyle: { color: "var(--color-muted-foreground)", fontFamily: "var(--font-mono)" },
} as const;

export const PSI_BAND_COLORS = {
  BEDROCK:  TOKEN.green,
  STEADY:   TOKEN.teal,
  TREMOR:   TOKEN.yellow,
  FRACTURE: TOKEN.orange,
  CRISIS:   TOKEN.red,
  MELTDOWN: TOKEN.darkRed,
} as const;
