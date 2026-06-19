export const DETAIL_SECTION_TITLE_CLASS = "text-lg font-semibold tracking-tight";

/** Shared scroll-margin for anchored detail-page sections; clears the mobile
 *  sticky summary bar on small viewports and only needs breathing room on lg+. */
export const SECTION_SCROLL_MT =
  "scroll-mt-[calc(10rem+var(--pharos-sticky-summary-h,0px))] lg:scroll-mt-6";

/** Top divider + padding that opens each key-info-card sub-section. */
export const SECTION_DIVIDER_CLASS = "border-t border-border/40 pt-3 sm:pt-4";
