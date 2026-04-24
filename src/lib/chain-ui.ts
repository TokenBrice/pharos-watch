import { getNetColor } from "@shared/lib/format";
import type { HealthBand } from "@shared/types/chains";

export const HEALTH_BADGE_CLASSES: Record<HealthBand, string> = {
  robust: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  healthy: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  mixed: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  fragile: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  concentrated: "bg-red-500/15 text-red-700 dark:text-red-400",
};

export const HEALTH_TEXT_CLASSES: Record<HealthBand, string> = {
  robust: "text-emerald-600 dark:text-emerald-400",
  healthy: "text-sky-600 dark:text-sky-400",
  mixed: "text-amber-600 dark:text-amber-400",
  fragile: "text-orange-600 dark:text-orange-400",
  concentrated: "text-red-600 dark:text-red-400",
};

export const HEALTH_FILL_CLASSES: Record<HealthBand, string> = {
  robust: "bg-emerald-500",
  healthy: "bg-sky-500",
  mixed: "bg-amber-500",
  fragile: "bg-orange-500",
  concentrated: "bg-red-500",
};

/** Hex values paired with HEALTH_FILL_CLASSES for use in SVG (where Tailwind classes can't apply). */
export const HEALTH_HEX_FILL: Record<HealthBand, string> = {
  robust: "#059669",
  healthy: "#0284c7",
  mixed: "#d97706",
  fragile: "#ea580c",
  concentrated: "#dc2626",
};

export function trendColor(value: number): string {
  return getNetColor(value, {
    positiveClass: "text-emerald-600 dark:text-emerald-400",
    negativeClass: "text-red-600 dark:text-red-400",
    zeroClass: "text-emerald-600 dark:text-emerald-400",
    positiveInclusiveZero: true,
  });
}
