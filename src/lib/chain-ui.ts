import { formatCompactUsd } from "@shared/lib/format";
import type { HealthBand } from "@shared/types/chains";

export function formatChainUsd(value: number): string {
  return formatCompactUsd(value);
}

export function formatRatioPct(value: number): string {
  const pct = value * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

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

export function trendColor(value: number): string {
  return value >= 0
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-red-600 dark:text-red-400";
}
