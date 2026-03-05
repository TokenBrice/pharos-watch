export interface FlowGaugeBandConfig {
  label: string;
  hex: string;
  textClass: string;
  bgClass: string;
}

export const GAUGE_BANDS: Record<string, FlowGaugeBandConfig> = {
  CRISIS: { label: "Crisis", hex: "#ef4444", textClass: "text-red-700 dark:text-red-400", bgClass: "bg-red-500" },
  STRESS: { label: "Stress", hex: "#f97316", textClass: "text-orange-700 dark:text-orange-400", bgClass: "bg-orange-500" },
  CAUTIOUS: { label: "Cautious", hex: "#f59e0b", textClass: "text-amber-700 dark:text-amber-400", bgClass: "bg-amber-500" },
  NEUTRAL: { label: "Neutral", hex: "#6b7280", textClass: "text-gray-700 dark:text-gray-400", bgClass: "bg-gray-500" },
  HEALTHY: { label: "Healthy", hex: "#84cc16", textClass: "text-lime-700 dark:text-lime-400", bgClass: "bg-lime-500" },
  CONFIDENT: { label: "Confident", hex: "#22c55e", textClass: "text-green-700 dark:text-green-400", bgClass: "bg-green-500" },
  SURGE: { label: "Surge", hex: "#10b981", textClass: "text-emerald-700 dark:text-emerald-400", bgClass: "bg-emerald-500" },
};
