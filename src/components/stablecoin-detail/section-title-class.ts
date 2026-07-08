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
