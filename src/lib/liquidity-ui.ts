import type { LiquidityCoverageClass } from "@shared/types";

export const COVERAGE_FILL_CLASSES: Record<LiquidityCoverageClass, string> = {
  primary: "fill-sky-700 dark:fill-sky-500",
  mixed: "fill-teal-600 dark:fill-teal-400",
  fallback: "fill-amber-600 dark:fill-amber-400",
  legacy: "fill-slate-500 dark:fill-slate-400",
  unobserved: "fill-muted-foreground/30",
};

export const COVERAGE_TEXT_CLASSES: Record<LiquidityCoverageClass, string> = {
  primary: "text-sky-700 dark:text-sky-400",
  mixed: "text-teal-700 dark:text-teal-400",
  fallback: "text-amber-700 dark:text-amber-400",
  legacy: "text-slate-600 dark:text-slate-400",
  unobserved: "text-muted-foreground",
};

export const COVERAGE_WATER_HEX: Record<LiquidityCoverageClass, string> = {
  primary: "#0369a1",
  mixed: "#0d9488",
  fallback: "#d97706",
  legacy: "#64748b",
  unobserved: "#94a3b8",
};

export type RippleBand = "still" | "gentle" | "choppy";

export function rippleIntensityBand(volume24hUsd: number): RippleBand {
  if (volume24hUsd >= 10_000_000) return "choppy";
  if (volume24hUsd >= 100_000) return "gentle";
  return "still";
}

/** 0 (fully clear) to ~0.65 (fully murky). null organic → mid-murk. */
export function clarityOpacity(organicFraction: number | null): number {
  if (organicFraction == null) return 0.35;
  const clamped = Math.max(0, Math.min(1, organicFraction));
  return (1 - clamped) * 0.65;
}

export function depthFillPct(score: number | null): number {
  if (score == null) return 0;
  return Math.max(0, Math.min(100, score));
}
