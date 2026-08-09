/**
 * Shared severity tone tokens (WS8.4).
 *
 * Deliberately NOT in `shared/lib/classification.ts` — that module owns
 * classification labels/colors (backing, governance, peg…). This module owns
 * the orthogonal "how bad is this signal" ramp that ~100 component files were
 * spelling by hand, with 18 emerald and 21 amber variants in circulation.
 *
 * Every value is a complete static Tailwind string (hard rule: no dynamic
 * class construction), and every value is the **majority spelling** measured
 * across `src/` on 2026-08-09:
 *
 * | tone    | shape  | occurrences of the chosen spelling |
 * |---------|--------|------------------------------------|
 * | ok      | pill   | 16 (next: 3)                       |
 * | watch   | pill   | 13 (next: 11)                      |
 * | alert   | pill   | 16 (next: 10)                      |
 * | neutral | pill   | 15 (next: 8)                       |
 * | info    | pill   | 12 (next: 2)                       |
 *
 * Slots:
 * - `pill`   — outlined badge/chip: border + tint + readable text in both themes.
 * - `banner` — bordered callout block; the block sets its own text color, so the
 *              token carries border + tint only (it is `pill` minus the text pair).
 * - `text`   — text-only accent (arrows, deltas, inline numbers).
 *
 * `alert` is red, not rose. Rose is a separate, smaller palette used by a few
 * detail modules; it is intentionally left out rather than silently re-hued.
 */

export type SeverityTone = "ok" | "watch" | "alert" | "neutral" | "info";

export interface SeverityToneClasses {
  /** Outlined badge/chip: border + tint + text. */
  pill: string;
  /** Bordered callout block: border + tint only. */
  banner: string;
  /** Text-only accent. */
  text: string;
}

export const SEVERITY_TONE_CLASS: Record<SeverityTone, SeverityToneClasses> = {
  ok: {
    pill: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    banner: "border-emerald-500/30 bg-emerald-500/10",
    text: "text-emerald-700 dark:text-emerald-400",
  },
  watch: {
    pill: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    banner: "border-amber-500/30 bg-amber-500/10",
    text: "text-amber-700 dark:text-amber-400",
  },
  alert: {
    pill: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
    banner: "border-red-500/30 bg-red-500/10",
    text: "text-red-700 dark:text-red-400",
  },
  neutral: {
    pill: "border-border/60 bg-muted/30 text-muted-foreground",
    banner: "border-border/60 bg-muted/30",
    text: "text-muted-foreground",
  },
  info: {
    pill: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
    banner: "border-blue-500/30 bg-blue-500/10",
    text: "text-blue-700 dark:text-blue-400",
  },
};
