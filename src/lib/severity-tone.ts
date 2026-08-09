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
 * `alert` is red, not rose: rose and sky are two further hues the product uses
 * as *named palette* slots rather than as severity steps, so they get their own
 * entries (WS8.14) instead of being silently re-hued onto red/blue.
 *
 * - `sky`  — "informational, in progress, provisional": pending reviews, running
 *   lanes, provisional yield sources, request-source attribution. Chosen
 *   spelling `border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300`
 *   is the measured majority (10 sites vs 5 for the `/30` border variant), so
 *   it deliberately keeps a lighter border than the `/30` severity steps.
 * - `rose` — the detail rail's "structurally short / disagrees" treatment, kept
 *   distinct from `alert` red so the rail's two failure vocabularies stay
 *   readable side by side. Spelling matches the house `/30 · /10 · 700/400`
 *   rhythm (the price-transparency spelling, unchanged by the migration).
 *
 * Data-driven ramps that compute a hue from a measured threshold
 * (`src/lib/severity-colors.ts`, the coverage chip palettes) are engines, not
 * tokens, and stay where they are.
 */

export type SeverityTone = "ok" | "watch" | "alert" | "neutral" | "info" | "sky" | "rose";

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
  sky: {
    pill: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    banner: "border-sky-500/25 bg-sky-500/10",
    text: "text-sky-700 dark:text-sky-300",
  },
  rose: {
    pill: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400",
    banner: "border-rose-500/30 bg-rose-500/10",
    text: "text-rose-700 dark:text-rose-400",
  },
};
