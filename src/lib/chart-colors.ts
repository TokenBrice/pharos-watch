/* ═══════════════════════════════════════════════════════════════════
   Chart Color Tokens
   General chart palette and tokens; classification colors live in
   shared/lib/classification children. Hex tokens here match semantic.css.
   Recharts needs literal hex strings — CSS var() doesn't work in SVG
   fill/stroke attributes rendered by React.
   ═══════════════════════════════════════════════════════════════════ */

/** Centralized color tokens — edit here, not in individual components */
const TOKEN = {
  blue: "#4bc4de",
  purple: "#8b5cf6",
  pink: "#ec4899",
  orange: "#f97316",
  green: "#3bcc87",
  cyan: "#23a7c8",
  yellow: "#eab308",
  red: "#ef4444",
  indigo: "#6366f1",
  teal: "#14b8a6",
  amber: "#f59e0b",
  lime: "#84cc16",
  slate: "#94a3b8",
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
export const CHART_SLATE_SOFT = "#cbd5e1";
export const CHART_SLATE_STRONG = "#64748b";
export const CHART_AMBER = TOKEN.amber;
export const CHART_TEAL = TOKEN.teal;

/** Standard responsive chart container height */
export const CHART_HEIGHT = "h-[250px] sm:h-[350px]";

export { THREAT_BAND_HEX } from "@shared/lib/classification";

// ---------------------------------------------------------------------------
// Extracted inline chart colors -- previously defined inside components.
// ---------------------------------------------------------------------------

/** In-block label ink for the tinted reserve treemap fills. */
export const RESERVE_TREEMAP_LABEL_COLOR = "var(--color-foreground)";


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
