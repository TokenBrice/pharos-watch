import type { StatusResponse } from "../../types";

/** Dashboard badges and runway bars are intentional projections of one status vocabulary. */
export const STATUS_TONE = {
  healthy: {
    label: "Healthy",
    badgeClassName: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    valueClassName: "text-emerald-700 dark:text-emerald-400",
    barClassName: "bg-emerald-500",
  },
  degraded: {
    label: "Degraded",
    badgeClassName: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    valueClassName: "text-amber-700 dark:text-amber-400",
    barClassName: "bg-amber-500",
  },
  stale: {
    label: "Stale",
    badgeClassName: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
    valueClassName: "text-red-700 dark:text-red-400",
    barClassName: "bg-red-500",
  },
  unknown: { label: "No probe.", barClassName: "bg-slate-300 dark:bg-slate-600" },
} as const satisfies Record<StatusResponse["overallStatus"] | "unknown", {
  label: string;
  barClassName: string;
  badgeClassName?: string;
  valueClassName?: string;
}>;
