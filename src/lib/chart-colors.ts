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

/** Standard Recharts tooltip styling (spread into <Tooltip> props) */
export const RECHARTS_TOOLTIP_STYLES = {
  contentStyle: {
    backgroundColor: "var(--color-card)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-lg, 0.5rem)",
  },
  labelStyle: { color: "var(--color-foreground)" },
  itemStyle: { color: "var(--color-muted-foreground)" },
} as const;
