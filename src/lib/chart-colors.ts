/* ═══════════════════════════════════════════════════════════════════
   Chart Color Tokens
   General chart palette and tokens; classification colors live in
   shared/lib/classification children. Primary series colors resolve via
   theme-paired CSS variables (`--chart-series-*` in semantic.css) so
   both light (#fff) and dark (L=0.20) chart cards meet >=3:1 contrast.
   ═══════════════════════════════════════════════════════════════════ */

/** Centralized color tokens — edit here, not in individual components */
const TOKEN = {
  blue: "var(--chart-series-blue)",
  purple: "#8b5cf6",
  pink: "#ec4899",
  orange: "#f97316",
  green: "var(--chart-series-green)",
  cyan: "var(--chart-series-cyan)",
  yellow: "#eab308",
  red: "#ef4444",
  indigo: "#6366f1",
  teal: "#14b8a6",
  amber: "var(--chart-series-amber)",
  lime: "#84cc16",
  slate: "var(--chart-series-slate)",
  darkRed: "#991b1b",
} as const;

export const CHART_PALETTE = [
  TOKEN.blue,
  TOKEN.purple,
  TOKEN.pink,
  TOKEN.orange,
  TOKEN.green,
  TOKEN.cyan,
  TOKEN.yellow,
  TOKEN.red,
  TOKEN.indigo,
  TOKEN.teal,
  TOKEN.amber,
  TOKEN.lime,
  TOKEN.slate,
];

/** Primary chart accent colors — import these instead of hardcoding hex values */
export const CHART_BLUE = TOKEN.blue;
export const CHART_GREEN = TOKEN.green;
export const CHART_ORANGE = TOKEN.orange;
export const CHART_RED = TOKEN.red;
export const CHART_SLATE = TOKEN.slate;
export const CHART_SLATE_STRONG = "#64748b";
export const CHART_AMBER = TOKEN.amber;
export const CHART_TEAL = TOKEN.teal;

export const CHART_HEIGHT = "h-[250px] sm:h-[350px]";

export { THREAT_BAND_HEX } from "@shared/lib/classification";

// ---------------------------------------------------------------------------
// Extracted inline chart colors -- previously defined inside components.
// ---------------------------------------------------------------------------



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
export const USDT_GREEN = TOKEN.green;
export const USDC_BLUE = TOKEN.blue;
