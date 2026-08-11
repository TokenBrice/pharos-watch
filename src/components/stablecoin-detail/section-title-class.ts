/**
 * Two title scales, two shells — the split is a **density tier**, not drift
 * (owner ruling 2026-08-11). PRODUCT.md calls for density calibrated by
 * surface tier, so the dense 22rem rail and the default-density main column
 * deliberately differ, and the difference is confined to exactly two
 * properties:
 *
 * | | rail (`RailCard`) | main column (`DETAIL_MODULE_*`) |
 * |---|---|---|
 * | header padding | `px-4 py-3.5` | `px-4 py-5 sm:px-5` |
 * | divider under header | none | `border-b border-border/40` |
 *
 * Everything else about the two shells must stay identical. Do not "reconcile"
 * the two rows above — they are the intended tier difference. Do reconcile
 * anything else that drifts apart.
 *
 * Title scales are likewise two, and only two:
 * - `DETAIL_SECTION_TITLE_CLASS` — a **section**: a named band of the page a
 *   reader navigates to (the scrollspy targets).
 * - `DETAIL_MODULE_TITLE_CLASS` — a **module**: one card inside a section.
 *
 * A file should use one or the other, not both. Several still import both;
 * that is the drift, not the two-scale system itself.
 */
export const DETAIL_SECTION_TITLE_CLASS = "text-lg font-semibold tracking-tight";
export const DETAIL_MODULE_SHELL_CLASS = "pharos-card-shell gap-0 overflow-hidden py-0";
export const DETAIL_MODULE_HEADER_CLASS =
  "flex flex-row flex-wrap items-center justify-between gap-3 border-b border-border/40 px-4 py-5 sm:px-5";
export const DETAIL_MODULE_TITLE_CLASS = "text-sm font-semibold tracking-normal text-muted-foreground";
export const DETAIL_MODULE_BODY_CLASS = "px-4 py-5 sm:px-5";

/** Shared scroll-margin for anchored detail-page sections; clears the mobile
 *  sticky summary bar on small viewports and only needs breathing room on lg+. */
export const SECTION_SCROLL_MT = "scroll-mt-[calc(10rem+var(--pharos-sticky-summary-h,0px))] lg:scroll-mt-6";

/** Top divider + padding that opens each key-info-card sub-section. */
export const SECTION_DIVIDER_CLASS = "border-t border-border/40 pt-3 sm:pt-4";
