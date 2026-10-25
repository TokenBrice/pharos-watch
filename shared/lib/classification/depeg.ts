import type { DdrResolutionTier } from "../../types/depeg-resolver";

/**
 * Depeg tracker, depeg history and Depeg Resolver (DDR) presentation.
 * Pills share one spelling: `border-X-500/30 bg-X-500/10 text-X-700 dark:text-X-400`.
 */

/** Historical depeg event-load meter: filled pips share the DEWS `watch` orange. */
export const DEPEG_EVENT_LOAD_PIP_CLASS = "border-orange-500/40 bg-orange-500";

/** Lowest flagged tier of the status-page price-divergence ladder (below the watch and alert pills). */
export const PRICE_DIVERGENCE_ELEVATED_PILL_CLASS = "border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-400";

export type DepegRowStatus = "active" | "pending" | "coverageLimited" | "watch" | "clear";

/**
 * Depeg board status pill and row tint. `watch` covers DEWS WARNING and
 * DANGER; its row tint comes from `THREAT_BAND_ACCENT_CLASSES[band].rowTint`.
 * Active rows carry no tint: they fill the top of the Attention sort.
 */
export const DEPEG_ROW_STATUS_CLASSES = {
  active: { pill: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400", rowTint: "" },
  pending: { pill: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400", rowTint: "bg-amber-500/[0.06]" },
  coverageLimited: { pill: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400", rowTint: "bg-sky-500/[0.04]" },
  watch: { pill: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400", rowTint: "" },
  clear: { pill: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", rowTint: "" },
} as const satisfies Record<DepegRowStatus, { pill: string; rowTint: string }>;

export type DepegDirection = "below" | "above";

export const DEPEG_DIRECTION_CLASSES = {
  below: { pill: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400", text: "text-red-700 dark:text-red-400" },
  above: { pill: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400", text: "text-amber-700 dark:text-amber-400" },
} as const satisfies Record<DepegDirection, { pill: string; text: string }>;

/** The pulsing "live" dot behind an active depeg. */
export const DEPEG_LIVE_PING_CLASS = "bg-red-400";

export type DdrVerdictTier = Exclude<DdrResolutionTier, "insufficient_signal">;

export const DDR_VERDICT_CLASSES = {
  recovery_likely: {
    band: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    accent: "text-emerald-700 dark:text-emerald-400",
    dot: "bg-emerald-500",
    ring: "ring-emerald-500/70",
  },
  at_risk: {
    band: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    accent: "text-amber-700 dark:text-amber-400",
    dot: "bg-amber-500",
    ring: "ring-amber-500/70",
  },
  recovery_unlikely: {
    band: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
    accent: "text-red-700 dark:text-red-400",
    dot: "bg-red-500",
    ring: "ring-red-500/70",
  },
} as const satisfies Record<DdrVerdictTier, { band: string; accent: string; dot: string; ring: string }>;

/**
 * Stage 1 reader vocabulary. DDRv5 relabels the unchanged wire tiers as
 * evidence classes; forecasts locked under an earlier methodology keep the
 * labels they were published with.
 */
export type DdrTierVocabulary = "legacy" | "evidence_class";

/** First methodology major whose forecasts read their tier as an evidence class. */
export const DDR_EVIDENCE_CLASS_MIN_MAJOR = 5;

export function getDdrTierVocabulary(methodologyVersion: string | null | undefined): DdrTierVocabulary {
  const major = Number(/^v?(\d+)/.exec(methodologyVersion ?? "")?.[1]);
  return Number.isFinite(major) && major >= DDR_EVIDENCE_CLASS_MIN_MAJOR ? "evidence_class" : "legacy";
}

export const DDR_TIER_LABELS = {
  legacy: {
    recovery_likely: {
      label: "Recovery likely",
      short: "Likely",
      blurb: "Structure and live signals favor a return to peg.",
    },
    at_risk: {
      label: "At risk",
      short: "At risk",
      blurb: "Recovery is plausible but not assured — the kill signals are live.",
    },
    recovery_unlikely: {
      label: "Recovery unlikely",
      short: "Unlikely",
      blurb: "Comparable structural failures did not return to peg.",
    },
    insufficient_signal: {
      label: "Insufficient signal",
      short: "No signal",
      blurb: "Not enough live signal for a verdict yet.",
    },
  },
  evidence_class: {
    recovery_likely: {
      label: "No break signals",
      short: "No break",
      blurb: "No kill signal fired and the break is shallow; most comparable breaks recovered.",
    },
    at_risk: {
      label: "Stress signals",
      short: "Stress",
      blurb: "Kill signals fired or the break is deep; most comparable breaks still recovered.",
    },
    recovery_unlikely: {
      label: "Terminal evidence",
      short: "Terminal",
      blurb: "Hard evidence that this break may not recover (wind-down, severe impairment, or compounded stress on a deep break).",
    },
    insufficient_signal: {
      label: "Insufficient signal",
      short: "No signal",
      blurb: "Not enough live signal for a verdict yet.",
    },
  },
} as const satisfies Record<
  DdrTierVocabulary,
  Record<DdrResolutionTier, { label: string; short: string; blurb: string }>
>;

export type DdrReviewTone = "positive" | "watch" | "negative" | "pending" | "retry";

/** DDR reviewer verdict/coverage pills; `retry` is the publication-retry state. */
export const DDR_REVIEW_TONE_CLASSES = {
  positive: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  watch: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  negative: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  pending: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  retry: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400",
} as const satisfies Record<DdrReviewTone, string>;

export type DdrOutcome = "correct" | "risk" | "pending" | "miss";

/** Reviewer outcome marks: `dot` on the strip (pending is hollow), `legendDot` in the key. */
export const DDR_OUTCOME_CLASSES = {
  correct: { dot: "bg-emerald-500", legendDot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400" },
  risk: { dot: "bg-amber-500", legendDot: "bg-amber-500", text: "text-amber-700 dark:text-amber-400" },
  pending: { dot: "bg-sky-500/20 ring-1 ring-inset ring-sky-500", legendDot: "bg-sky-500", text: "text-sky-700 dark:text-sky-400" },
  miss: { dot: "bg-red-500", legendDot: "bg-red-500", text: "text-red-700 dark:text-red-400" },
} as const satisfies Record<DdrOutcome, { dot: string; legendDot: string; text: string }>;

/** Kill signals (toward terminal) against recovery anchors (toward repeg). */
export const DDR_KILL_SAVE_CLASSES = {
  kill: { filled: "bg-red-500", empty: "bg-red-500/25", head: "text-red-700 dark:text-red-400", bar: "bg-red-500/70" },
  save: { filled: "bg-emerald-500", empty: "bg-emerald-500/25", head: "text-emerald-700 dark:text-emerald-400", bar: "bg-emerald-500/70" },
} as const satisfies Record<"kill" | "save", { filled: string; empty: string; head: string; bar: string }>;

export const DDR_TIMELINE_CLASSES = {
  terminalLine: "bg-red-500/30",
  terminalText: "text-red-700 dark:text-red-400",
  /** `currentColor` of the depth sparkline SVG. */
  terminalGlyph: "text-red-500",
  pendingTrack: "bg-gradient-to-r from-sky-500/60 via-sky-500/30 to-transparent",
  pendingArrow: "border-l-sky-500/40",
  pendingFill: "bg-sky-500/20",
  pendingText: "text-sky-700 dark:text-sky-400",
  pendingMarker: "bg-sky-500",
} as const;
