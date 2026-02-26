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

const THRESHOLDS = { GREEN: 50, AMBER: 200, ORANGE: 500 } as const;

/** Severity hex token map — single source of truth for JS-side hex values */
const SEVERITY_HEX = {
  healthy:  "#22c55e",
  mild:     "#f59e0b",
  moderate: "#f97316",
  severe:   "#ef4444",
} as const;

export function deviationColorClass(absBps: number): string {
  if (absBps < THRESHOLDS.GREEN) return "text-green-500";
  if (absBps < THRESHOLDS.AMBER) return "text-amber-500";
  if (absBps < THRESHOLDS.ORANGE) return "text-orange-500";
  return "text-red-500";
}

export function deviationBgClass(absBps: number): string {
  if (absBps < THRESHOLDS.GREEN) return "bg-green-500";
  if (absBps < THRESHOLDS.AMBER) return "bg-amber-500";
  if (absBps < THRESHOLDS.ORANGE) return "bg-orange-500";
  return "bg-red-500";
}

export function deviationColorHex(absBps: number): string {
  if (absBps < THRESHOLDS.GREEN) return SEVERITY_HEX.healthy;
  if (absBps < THRESHOLDS.AMBER) return SEVERITY_HEX.mild;
  if (absBps < THRESHOLDS.ORANGE) return SEVERITY_HEX.moderate;
  return SEVERITY_HEX.severe;
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

export type ScoreTier = "green" | "blue" | "amber" | "red";

export const TIER_TEXT: Record<ScoreTier, string> = {
  green: "text-emerald-500",
  blue: "text-blue-500",
  amber: "text-amber-500",
  red: "text-red-500",
};

export const TIER_BORDER: Record<ScoreTier, string> = {
  green: "border-l-emerald-500",
  blue: "border-l-blue-500",
  amber: "border-l-amber-500",
  red: "border-l-red-500",
};

/** Map a 0-100 liquidity/durability score to a tier */
export function getScoreTier(score: number): ScoreTier {
  if (score >= 80) return "green";
  if (score >= 60) return "blue";
  if (score >= 40) return "amber";
  return "red";
}

/** Map a 0-100 liquidity/durability score to a Tailwind text color class */
export function getScoreColor(score: number): string {
  return TIER_TEXT[getScoreTier(score)];
}

/** Map a peg score (0-100, null) to a Tailwind text color class */
export function pegScoreColor(score: number | null): string {
  if (score === null) return "text-muted-foreground";
  if (score >= 90) return "text-green-500";
  if (score >= 70) return "text-amber-500";
  return "text-red-500";
}

// ---------------------------------------------------------------------------
// Durability score color helpers (70/40 thresholds — intentionally different
// from the generic 80/60/40 score tier thresholds above)
// ---------------------------------------------------------------------------

/** Map a 0-100 durability score to a Tailwind text color class */
export function getDurabilityColor(score: number): string {
  if (score >= 70) return "text-emerald-500";
  if (score >= 40) return "text-amber-500";
  return "text-red-500";
}

/** Map a 0-100 durability score to a Tailwind background color class */
export function getDurabilityBgColor(score: number): string {
  if (score >= 70) return "bg-emerald-500";
  if (score >= 40) return "bg-amber-500";
  return "bg-red-500";
}
