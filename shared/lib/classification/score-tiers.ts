/**
 * Score-tier ramps and the named severity hues that are classification
 * colours rather than UI state: `info` (blue, the second score tier) and
 * `rose` (the deliberate "structurally short / worst" slot, kept apart from
 * red active failure). `src/lib/severity-tone.ts` re-exposes the two named
 * rows next to its state-token tones.
 */

export type ScoreTier5 = "t80" | "t65" | "t50" | "t35" | "t0";

/** Five-step score ramp (redemption backstop: 80/65/50/35 cut-offs). Fills are the `/70` spectrum track. */
export const SCORE_TIER_5_CLASSES = {
  t80: {
    pill: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    text: "text-emerald-700 dark:text-emerald-400",
    fill: "bg-emerald-500/70",
  },
  t65: {
    pill: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
    text: "text-blue-700 dark:text-blue-400",
    fill: "bg-blue-500/70",
  },
  t50: {
    pill: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    text: "text-amber-700 dark:text-amber-400",
    fill: "bg-amber-500/70",
  },
  t35: {
    pill: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400",
    text: "text-orange-700 dark:text-orange-400",
    fill: "bg-orange-500/70",
  },
  t0: {
    pill: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
    text: "text-red-700 dark:text-red-400",
    fill: "bg-red-500/70",
  },
} as const satisfies Record<ScoreTier5, { pill: string; text: string; fill: string }>;

/** Numeric redemption display bands, worst → best; not the ordinal mint scale. */
export const SCORE_TIER_5_POLICY = [
  { key: "t0", min: 0, label: "<35" },
  { key: "t35", min: 35, label: "35–49" },
  { key: "t50", min: 50, label: "50–64" },
  { key: "t65", min: 65, label: "65–79" },
  { key: "t80", min: 80, label: "80+" },
] as const satisfies readonly { key: ScoreTier5; min: number; label: string }[];

export function resolveScoreTier5(score: number | null): ScoreTier5 | null {
  if (score == null || Number.isNaN(score)) return null;
  for (let index = SCORE_TIER_5_POLICY.length - 1; index > 0; index--) {
    if (score >= SCORE_TIER_5_POLICY[index].min) return SCORE_TIER_5_POLICY[index].key;
  }
  return "t0";
}

export type ScoreTier4 = "t80" | "t60" | "t40" | "t0";

/** Four-step score ramp (liquidity 80/60/40, Bluechip grade order). */
export const SCORE_TIER_4_CLASSES = {
  t80: { text: "text-emerald-700 dark:text-emerald-400", fill: "bg-emerald-500/70" },
  t60: { text: "text-blue-700 dark:text-blue-400", fill: "bg-blue-500/70" },
  t40: { text: "text-amber-700 dark:text-amber-400", fill: "bg-amber-500/70" },
  t0: { text: "text-red-700 dark:text-red-400", fill: "bg-red-500/70" },
} as const satisfies Record<ScoreTier4, { text: string; fill: string }>;

export type SeverityNamedTone = "info" | "rose";

/** Same slots as `SeverityToneClasses` in `src/lib/severity-tone.ts`. */
export const SEVERITY_NAMED_TONE_CLASSES = {
  info: {
    pill: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
    banner: "border-blue-500/30 bg-blue-500/10",
    text: "text-blue-700 dark:text-blue-400",
    bar: "bg-blue-500",
  },
  rose: {
    pill: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400",
    banner: "border-rose-500/30 bg-rose-500/10",
    text: "text-rose-700 dark:text-rose-400",
    bar: "bg-rose-500",
  },
} as const satisfies Record<SeverityNamedTone, { pill: string; banner: string; text: string; bar: string }>;

/** Safety Score breakdown row score text; neutral rows stay foreground. */
export const SAFETY_BREAKDOWN_ROW_TONE_TEXT_CLASSES = {
  warn: "text-amber-700 dark:text-amber-400",
  critical: "text-rose-700 dark:text-rose-400",
} as const;

/** Custody card: unidentified custody share segment and a failed protection rung. */
export const CUSTODY_STATE_CLASSES = {
  unidentified: "bg-amber-500/60",
  failed: "border border-rose-500/60",
} as const;

export type CaseStudyOutcomeKey = "survived" | "wounded" | "died";

/** Rose is the deliberate "died" hue; text uses the house 700 shade. */
export const CASE_STUDY_OUTCOME_CLASSES = {
  survived: { chip: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400", text: "text-emerald-700 dark:text-emerald-400" },
  wounded: { chip: "border-amber-500/40 text-amber-700 dark:text-amber-400", text: "text-amber-700 dark:text-amber-400" },
  died: { chip: "border-rose-500/40 text-rose-700 dark:text-rose-400", text: "text-rose-700 dark:text-rose-400" },
} as const satisfies Record<CaseStudyOutcomeKey, { chip: string; text: string }>;
