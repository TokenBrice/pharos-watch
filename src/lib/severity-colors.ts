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
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import type { MintPressureBand } from "@shared/lib/classification";

const THRESHOLDS = { GREEN: 50, AMBER: 200, ORANGE: 500 } as const;

export interface MintPressureStyle {
  badgeClass: string;
  valueClass: string;
  panelClass: string;
}

/** Presentation styles for the canonical mint-pressure bands. */
export const MINT_PRESSURE_STYLES: Record<MintPressureBand, MintPressureStyle> = {
  "no-activity": {
    badgeClass: "border-border/70 bg-muted/40 text-muted-foreground",
    valueClass: "text-muted-foreground",
    panelClass: "border-border/60 bg-background/35",
  },
  "mint-dominated": {
    badgeClass:
      "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300",
    valueClass: SEVERITY_TONE_CLASS.ok.text,
    panelClass:
      "border-emerald-600/30 bg-emerald-500/10 dark:border-emerald-500/35 dark:bg-emerald-500/10",
  },
  "mint-tilt": {
    badgeClass:
      "border-lime-600/30 bg-lime-500/10 text-lime-700 dark:border-lime-500/40 dark:bg-lime-500/15 dark:text-lime-300",
    valueClass: "text-lime-700 dark:text-lime-400",
    panelClass:
      "border-lime-600/30 bg-lime-500/10 dark:border-lime-500/35 dark:bg-lime-500/10",
  },
  balanced: {
    badgeClass: "border-border/70 bg-muted/40 text-foreground",
    valueClass: "text-foreground",
    panelClass: "border-border/60 bg-background/40",
  },
  "burn-tilt": {
    badgeClass:
      "border-amber-600/30 bg-amber-500/10 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300",
    valueClass: SEVERITY_TONE_CLASS.watch.text,
    panelClass:
      "border-amber-600/30 bg-amber-500/10 dark:border-amber-500/35 dark:bg-amber-500/10",
  },
  "burn-dominated": {
    badgeClass:
      "border-red-600/30 bg-red-500/10 text-red-700 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300",
    valueClass: SEVERITY_TONE_CLASS.alert.text,
    panelClass:
      "border-red-600/30 bg-red-500/10 dark:border-red-500/35 dark:bg-red-500/10",
  },
};

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
  green: SEVERITY_TONE_CLASS.ok.text,
  blue: SEVERITY_TONE_CLASS.info.text,
  amber: SEVERITY_TONE_CLASS.watch.text,
  red: SEVERITY_TONE_CLASS.alert.text,
};

/**
 * Outlined-pill twin of `TIER_TEXT`, for score tiers rendered through
 * `ScorePill` rather than as bare tinted text. Composed from
 * `SEVERITY_TONE_CLASS` instead of respelling the hues — this engine picks a
 * tier, the token module owns what the tier looks like.
 */
export const TIER_PILL: Record<ScoreTier, string> = {
  green: SEVERITY_TONE_CLASS.ok.pill,
  blue: SEVERITY_TONE_CLASS.info.pill,
  amber: SEVERITY_TONE_CLASS.watch.pill,
  red: SEVERITY_TONE_CLASS.alert.pill,
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
export const SCORE_TIER_CUTOFFS = {
  red: 0,
  amber: 40,
  blue: 60,
  green: 80,
} as const;

const SCORE_TEXT_THRESHOLDS = [
  { min: SCORE_TIER_CUTOFFS.green, className: TIER_TEXT.green },
  { min: SCORE_TIER_CUTOFFS.blue, className: TIER_TEXT.blue },
  { min: SCORE_TIER_CUTOFFS.amber, className: TIER_TEXT.amber },
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
  if (score >= SCORE_TIER_CUTOFFS.green) return "green";
  if (score >= SCORE_TIER_CUTOFFS.blue) return "blue";
  if (score >= SCORE_TIER_CUTOFFS.amber) return "amber";
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
  if (score >= 70) return SEVERITY_TONE_CLASS.ok.bar;
  if (score >= 40) return SEVERITY_TONE_CLASS.watch.bar;
  return SEVERITY_TONE_CLASS.alert.bar;
}

/** Semantic color class for ratio-based quality (green/amber/red). */
export function ratioQualityColor(ratio: number, highThreshold = 0.8, midThreshold = 0.5): string {
  if (ratio >= highThreshold) return SEVERITY_TONE_CLASS.ok.text;
  if (ratio >= midThreshold) return SEVERITY_TONE_CLASS.watch.text;
  return SEVERITY_TONE_CLASS.alert.text;
}
