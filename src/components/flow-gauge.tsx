export interface FlowGaugeBandConfig {
  label: string;
  hex: string;
  textClass: string;
  bgClass: string;
}

export const GAUGE_BANDS: Record<string, FlowGaugeBandConfig> = {
  CRISIS: { label: "Crisis", hex: "#ef4444", textClass: "text-red-500", bgClass: "bg-red-500" },
  STRESS: { label: "Stress", hex: "#f97316", textClass: "text-orange-500", bgClass: "bg-orange-500" },
  CAUTIOUS: { label: "Cautious", hex: "#f59e0b", textClass: "text-amber-500", bgClass: "bg-amber-500" },
  NEUTRAL: { label: "Neutral", hex: "#6b7280", textClass: "text-gray-500", bgClass: "bg-gray-500" },
  HEALTHY: { label: "Healthy", hex: "#84cc16", textClass: "text-lime-500", bgClass: "bg-lime-500" },
  CONFIDENT: { label: "Confident", hex: "#22c55e", textClass: "text-green-500", bgClass: "bg-green-500" },
  SURGE: { label: "Surge", hex: "#10b981", textClass: "text-emerald-500", bgClass: "bg-emerald-500" },
};
