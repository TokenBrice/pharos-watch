export const CHART_PALETTE = [
  "#3b82f6", "#8b5cf6", "#ec4899", "#f97316", "#10b981",
  "#06b6d4", "#eab308", "#ef4444", "#6366f1", "#14b8a6",
  "#f59e0b", "#84cc16", "#94a3b8",
];

/** Primary chart accent colors — import these instead of hardcoding hex values */
export const CHART_BLUE = CHART_PALETTE[0];  // #3b82f6
export const CHART_GREEN = CHART_PALETTE[4]; // #10b981
export const CHART_TEAL = CHART_PALETTE[9]; // #14b8a6
export const CHART_RED = "#ef4444";

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
  BEDROCK: "#22c55e",
  STEADY: "#14b8a6",
  TREMOR: "#eab308",
  FRACTURE: "#f97316",
  CRISIS: "#ef4444",
  MELTDOWN: "#991b1b",
} as const;
