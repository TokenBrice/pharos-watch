/**
 * Shared deviation severity color mapping.
 *
 * Hex values match --severity-*-hex CSS custom properties in semantic.css.
 * Tailwind class functions use static strings (required for purge).
 *
 * Thresholds (absolute basis points):
 *   < GREEN  green  (healthy)
 *   GREEN-AMBER  amber  (mild)
 *   AMBER-ORANGE orange (moderate)
 *   >= ORANGE  red    (severe)
 */

import { isQuietDeviationsEnabled } from "@/lib/feature-flags";

const THRESHOLDS = { GREEN: 50, AMBER: 200, ORANGE: 500 } as const;

/** Severity border class with accent opacity — suitable for outlined badges. */
export function deviationBorderClass(absBps: number): string {
  if (absBps < THRESHOLDS.GREEN) return "border-green-500/50";
  if (absBps < THRESHOLDS.AMBER) return "border-amber-500/50";
  if (absBps < THRESHOLDS.ORANGE) return "border-orange-500/50";
  return "border-red-500/50";
}

export function deviationColorClass(absBps: number): string {
  if (isQuietDeviationsEnabled()) {
    if (absBps < THRESHOLDS.GREEN) return "text-muted-foreground";
    if (absBps < THRESHOLDS.AMBER) return "text-amber-700 dark:text-amber-400";
    if (absBps < THRESHOLDS.ORANGE) return "text-orange-700 dark:text-orange-400";
    return "text-red-700 dark:text-red-400";
  }
  if (absBps < THRESHOLDS.GREEN) return "text-green-700 dark:text-green-400";
  if (absBps < THRESHOLDS.AMBER) return "text-amber-700 dark:text-amber-400";
  if (absBps < THRESHOLDS.ORANGE) return "text-orange-700 dark:text-orange-400";
  return "text-red-700 dark:text-red-400";
}

export function deviationBgClass(absBps: number): string {
  if (absBps < THRESHOLDS.GREEN) return "bg-green-500";
  if (absBps < THRESHOLDS.AMBER) return "bg-amber-500";
  if (absBps < THRESHOLDS.ORANGE) return "bg-orange-500";
  return "bg-red-500";
}

/** Severity icon name (Lucide component name) for a given deviation in basis points */
export type SeverityIcon = "CircleCheck" | "TriangleAlert" | "OctagonAlert" | "CircleX";

export function deviationIconName(absBps: number): SeverityIcon {
  if (absBps < THRESHOLDS.GREEN) return "CircleCheck";
  if (absBps < THRESHOLDS.AMBER) return "TriangleAlert";
  if (absBps < THRESHOLDS.ORANGE) return "OctagonAlert";
  return "CircleX";
}

// ---------------------------------------------------------------------------
// Score tier system (used by liquidity, bluechip, peg components)
// ---------------------------------------------------------------------------

type ScoreTier = "green" | "blue" | "amber" | "red";

export const TIER_TEXT: Record<ScoreTier, string> = {
  green: "text-emerald-700 dark:text-emerald-400",
  blue: "text-blue-700 dark:text-blue-400",
  amber: "text-amber-700 dark:text-amber-400",
  red: "text-red-700 dark:text-red-400",
};

interface ScoreColorThreshold {
  min: number;
  className: string;
}

export function scoreToColorClass(
  score: number | null | undefined,
  thresholds: readonly ScoreColorThreshold[],
  fallbackClass = "text-muted-foreground",
): string {
  if (score == null) return fallbackClass;
  for (const threshold of thresholds) {
    if (score >= threshold.min) return threshold.className;
  }
  return fallbackClass;
}

const SCORE_TEXT_THRESHOLDS = [
  { min: 80, className: TIER_TEXT.green },
  { min: 60, className: TIER_TEXT.blue },
  { min: 40, className: TIER_TEXT.amber },
  { min: Number.NEGATIVE_INFINITY, className: TIER_TEXT.red },
] as const;

const PEG_SCORE_THRESHOLDS = [
  { min: 90, className: "text-green-700 dark:text-green-400" },
  { min: 70, className: "text-amber-700 dark:text-amber-400" },
  { min: Number.NEGATIVE_INFINITY, className: "text-red-700 dark:text-red-400" },
] as const;

const DURABILITY_TEXT_THRESHOLDS = [
  { min: 70, className: "text-emerald-700 dark:text-emerald-400" },
  { min: 40, className: "text-amber-700 dark:text-amber-400" },
  { min: Number.NEGATIVE_INFINITY, className: "text-red-700 dark:text-red-400" },
] as const;

/** Map a 0-100 liquidity/durability score to a tier */
export function getScoreTier(score: number): ScoreTier {
  if (score >= 80) return "green";
  if (score >= 60) return "blue";
  if (score >= 40) return "amber";
  return "red";
}

/** Map a 0-100 liquidity/durability score to a Tailwind text color class */
export function getScoreColor(score: number): string {
  return scoreToColorClass(score, SCORE_TEXT_THRESHOLDS);
}

/** Map a peg score (0-100, null) to a Tailwind text color class */
export function pegScoreColor(score: number | null): string {
  return scoreToColorClass(score, PEG_SCORE_THRESHOLDS);
}

// ---------------------------------------------------------------------------
// Durability score color helpers (70/40 thresholds — intentionally different
// from the generic 80/60/40 score tier thresholds above)
// ---------------------------------------------------------------------------

/** Map a 0-100 durability score to a Tailwind text color class */
export function getDurabilityColor(score: number): string {
  return scoreToColorClass(score, DURABILITY_TEXT_THRESHOLDS);
}

/** Map a 0-100 durability score to a Tailwind background color class */
export function getDurabilityBgColor(score: number): string {
  if (score >= 70) return "bg-emerald-500";
  if (score >= 40) return "bg-amber-500";
  return "bg-red-500";
}

/** Semantic color class for ratio-based quality (green/amber/red). */
export function ratioQualityColor(ratio: number, highThreshold = 0.8, midThreshold = 0.5): string {
  if (ratio >= highThreshold) return "text-emerald-700 dark:text-emerald-400";
  if (ratio >= midThreshold) return "text-amber-700 dark:text-amber-400";
  return "text-red-700 dark:text-red-400";
}
