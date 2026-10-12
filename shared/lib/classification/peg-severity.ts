/**
 * Peg-deviation levels, the three-step quality ramp and up/down direction.
 *
 * Peg deviation keeps green for "healthy"; score ramps use emerald for "good"
 * (owner ruling C6), so the two never read as the same scale.
 */

export type PegDeviationLevel = "healthy" | "mild" | "moderate" | "severe";

/** Lower bound (absolute bps, inclusive) of each non-healthy level. */
export const PEG_DEVIATION_LEVEL_MIN_BPS = {
  mild: 50,
  moderate: 200,
  severe: 500,
} as const satisfies Record<Exclude<PegDeviationLevel, "healthy">, number>;

export const PEG_DEVIATION_LEVEL_LABELS = {
  healthy: "Healthy",
  mild: "Mild",
  moderate: "Moderate",
  severe: "Severe",
} as const satisfies Record<PegDeviationLevel, string>;

export function getPegDeviationLevel(absBps: number): PegDeviationLevel {
  if (absBps < PEG_DEVIATION_LEVEL_MIN_BPS.mild) return "healthy";
  if (absBps < PEG_DEVIATION_LEVEL_MIN_BPS.moderate) return "mild";
  if (absBps < PEG_DEVIATION_LEVEL_MIN_BPS.severe) return "moderate";
  return "severe";
}

export const PEG_DEVIATION_TONE_CLASSES = {
  healthy: { text: "text-green-700 dark:text-green-400", border: "border-green-500/50", bar: "bg-green-500" },
  mild: { text: "text-amber-700 dark:text-amber-400", border: "border-amber-500/50", bar: "bg-amber-500" },
  moderate: { text: "text-orange-700 dark:text-orange-400", border: "border-orange-500/50", bar: "bg-orange-500" },
  severe: { text: "text-red-700 dark:text-red-400", border: "border-red-500/50", bar: "bg-red-500" },
} as const satisfies Record<PegDeviationLevel, { text: string; border: string; bar: string }>;

export type QualityTier3 = "good" | "watch" | "bad";

/**
 * Three-step quality ramp (peg score, durability, venue risk, organic share,
 * yield posture, instrument benchmark). `bar40`/`bar80` are the faded fills
 * some surfaces use; `borderL` is the card-edge accent.
 */
export const QUALITY_TIER_3_CLASSES = {
  good: {
    text: "text-emerald-700 dark:text-emerald-400",
    badgeSoft: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    bar: "bg-emerald-500",
    bar40: "bg-emerald-500/40",
    bar80: "bg-emerald-500/80",
    borderL: "border-l-2 border-l-emerald-500",
  },
  watch: {
    text: "text-amber-700 dark:text-amber-400",
    badgeSoft: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    bar: "bg-amber-500",
    bar40: "bg-amber-500/40",
    bar80: "bg-amber-500/80",
    borderL: "border-l-2 border-l-amber-500",
  },
  bad: {
    text: "text-red-700 dark:text-red-400",
    badgeSoft: "bg-red-500/10 text-red-600 dark:text-red-400",
    bar: "bg-red-500",
    bar40: "bg-red-500/40",
    bar80: "bg-red-500/80",
    borderL: "border-l-2 border-l-red-500",
  },
} as const satisfies Record<QualityTier3, {
  text: string;
  badgeSoft: string;
  bar: string;
  bar40: string;
  bar80: string;
  borderL: string;
}>;

export type DirectionTone = "up" | "down";

/** Signed deltas; zero counts as up. */
export const DIRECTION_TONE_CLASSES = {
  up: "text-green-700 dark:text-green-400",
  down: "text-red-700 dark:text-red-400",
} as const satisfies Record<DirectionTone, string>;

export const DIRECTION_CHIP_CLASSES = {
  up: "bg-green-500/10 text-green-700 dark:text-green-400",
  down: "bg-red-500/10 text-red-700 dark:text-red-400",
} as const satisfies Record<DirectionTone, string>;
