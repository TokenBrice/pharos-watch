import { SEVERITY_NAMED_TONE_CLASSES } from "@shared/lib/classification";

/**
 * Shared severity tone tokens (WS8.4).
 *
 * This module owns the orthogonal "how bad is this signal" UI-state ramp that
 * ~100 component files were spelling by hand, with 18 emerald and 21 amber
 * variants in circulation. The `ok`/`watch`/`alert`/`sky` rows are backed by
 * state tokens. The two named-palette rows (`info` blue, `rose`) are
 * classification colours (score tiers, the detail rail's "structurally short"
 * slot), so their values live in `SEVERITY_NAMED_TONE_CLASSES` in
 * `shared/lib/classification.ts` and are re-exposed here unchanged; edit them
 * there, never here.
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
 * - `bar`    — solid fill for a progress/ladder bar. Only for bars that encode a
 *              *graded* value; a bar showing a share of a basket is a composition,
 *              not a risk level, and stays neutral (owner ruling 2026-08-11).
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
  /** Solid fill for a graded progress/ladder bar. */
  bar: string;
}

export const SEVERITY_TONE_CLASS: Record<SeverityTone, SeverityToneClasses> = {
  ok: {
    pill: "border-state-positive bg-state-positive-subtle text-state-positive",
    banner: "border-state-positive bg-state-positive-subtle",
    text: "text-state-positive",
    bar: "bg-state-positive-solid",
  },
  watch: {
    pill: "border-state-warn bg-state-warn-subtle text-state-warn",
    banner: "border-state-warn bg-state-warn-subtle",
    text: "text-state-warn",
    bar: "bg-state-warn-solid",
  },
  alert: {
    pill: "border-state-danger bg-state-danger-subtle text-state-danger",
    banner: "border-state-danger bg-state-danger-subtle",
    text: "text-state-danger",
    bar: "bg-state-danger-solid",
  },
  neutral: {
    pill: "border-border/60 bg-muted/30 text-muted-foreground",
    banner: "border-border/60 bg-muted/30",
    text: "text-muted-foreground",
    bar: "bg-muted-foreground/40",
  },
  info: SEVERITY_NAMED_TONE_CLASSES.info,
  sky: {
    pill: "border-state-info-solid/25 bg-state-info-subtle text-state-info-bright",
    banner: "border-state-info-solid/25 bg-state-info-subtle",
    text: "text-state-info-bright",
    bar: "bg-state-info-solid",
  },
  rose: SEVERITY_NAMED_TONE_CLASSES.rose,
};
