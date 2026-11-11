/**
 * Shared deviation severity color mapping.
 *
 * Tailwind classes live in `PEG_DEVIATION_TONE_CLASSES`; the cut-offs
 * (healthy < 50 bps < mild < 200 < moderate < 500 <= severe) and level labels
 * are `PEG_DEVIATION_LEVEL_MIN_BPS` / `getPegDeviationLevel` in classification.
 */

import { isQuietDeviationsEnabled } from "@/lib/feature-flags";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import {
  getDexDurabilityStyle,
  getPegDeviationLevel,
  getPegScoreTier,
  PEG_DEVIATION_TONE_CLASSES,
  QUALITY_TIER_3_CLASSES,
  resolveScoreTier4,
  SCORE_TIER_4_CLASSES,
} from "@shared/lib/classification";

/** Severity border class with accent opacity — suitable for outlined badges. */
export function deviationBorderClass(absBps: number): string {
  return PEG_DEVIATION_TONE_CLASSES[getPegDeviationLevel(absBps)].border;
}

export function deviationColorClass(absBps: number): string {
  const level = getPegDeviationLevel(absBps);
  if (level === "healthy" && isQuietDeviationsEnabled()) return "text-muted-foreground";
  return PEG_DEVIATION_TONE_CLASSES[level].text;
}

export function deviationBgClass(absBps: number): string {
  return PEG_DEVIATION_TONE_CLASSES[getPegDeviationLevel(absBps)].bar;
}

/** Severity icon name (Lucide component name) for a given deviation in basis points */
export type SeverityIcon = "CircleCheck" | "TriangleAlert" | "OctagonAlert" | "CircleX";

export function deviationIconName(absBps: number): SeverityIcon {
  const level = getPegDeviationLevel(absBps);
  if (level === "healthy") return "CircleCheck";
  if (level === "mild") return "TriangleAlert";
  if (level === "moderate") return "OctagonAlert";
  return "CircleX";
}

/** Map a 0-100 liquidity/durability score to a Tailwind text color class */
export function getScoreColor(score: number): string {
  return score == null || Number.isNaN(score) ? "text-muted-foreground" : SCORE_TIER_4_CLASSES[resolveScoreTier4(score)].scoreText;
}

/** Map a peg score (0-100, null) to a Tailwind text color class */
export function pegScoreColor(score: number | null): string {
  const tier = getPegScoreTier(score);
  return tier ? QUALITY_TIER_3_CLASSES[tier].text : "text-muted-foreground";
}

// ---------------------------------------------------------------------------
// Durability score color helpers (70/40 thresholds — intentionally different
// from the generic 80/60/40 score tier thresholds)
// ---------------------------------------------------------------------------

/** Map a 0-100 durability score to a Tailwind text color class */
export function getDurabilityColor(score: number): string {
  return score == null || Number.isNaN(score) ? "text-muted-foreground" : getDexDurabilityStyle(score).text;
}

/** Map a 0-100 durability score to a Tailwind background color class */
export function getDurabilityBgColor(score: number): string {
  return getDexDurabilityStyle(score).bar;
}

/** Semantic color class for ratio-based quality (green/amber/red). */
export function ratioQualityColor(ratio: number): string {
  if (ratio >= 0.8) return SEVERITY_TONE_CLASS.ok.text;
  if (ratio >= 0.5) return SEVERITY_TONE_CLASS.watch.text;
  return SEVERITY_TONE_CLASS.alert.text;
}
