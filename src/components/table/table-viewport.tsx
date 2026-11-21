import * as React from "react";

import { cn } from "@/lib/utils";

import type { TableStickyMode } from "./types";

export interface TableViewportProps extends React.ComponentPropsWithRef<"div"> {
  mobileScrollHint?: React.ReactNode | false;
  scrollShadow?: boolean;
  horizontal?: boolean;
  vertical?: boolean;
  overscrollX?: boolean;
  compactBottomPadding?: boolean;
  stickyMode?: TableStickyMode;
}

export function TableViewport({
  className,
  children,
  ref,
  mobileScrollHint = "Swipe sideways for more columns",
  scrollShadow = true,
  horizontal,
  vertical = false,
  overscrollX = true,
  compactBottomPadding = true,
  stickyMode,
  ...props
}: TableViewportProps) {
  const isPageSticky = !vertical && stickyMode === "page";
  const isViewportSticky = vertical || stickyMode === "viewport";
  const horizontalOverflowClass = isPageSticky
    ? horizontal === true
      ? "overflow-x-auto"
      : horizontal === false
        ? undefined
        : "overflow-x-auto lg:overflow-visible"
    : (horizontal ?? true)
      ? "overflow-x-auto"
      : undefined;
  const scrollShadowClass = !scrollShadow
    ? undefined
    : isPageSticky
      ? horizontal === true
        ? "scroll-shadow"
        : horizontal === false
          ? undefined
          : "scroll-shadow lg:bg-none"
      : "scroll-shadow";

  return (
    <>
      {mobileScrollHint ? (
        <div className="border-b border-border/50 px-4 py-2 text-2xs font-medium text-muted-foreground sm:hidden">
          {mobileScrollHint}
        </div>
      ) : null}
      <div
        {...props}
        ref={ref}
        data-slot="table-viewport"
        data-sticky-mode={stickyMode}
        className={cn(
          // Containing block for absolutely-positioned descendants (e.g.
          // `sr-only` header labels): without it they escape the scroller's
          // overflow clip at their static position and widen the document.
          "relative",
          scrollShadowClass,
          horizontalOverflowClass,
          // A vertically scrolling viewport is the sticky header's scroll
          // container, so the page-level `--table-header-top` offset (sized
          // for the site header) would float the thead mid-viewport.
          isViewportSticky && "overflow-y-auto [--table-header-top:0px]",
          overscrollX && horizontal !== false && "overscroll-x-contain",
          compactBottomPadding && "pb-3 sm:pb-0",
          className,
        )}
      >
        {children}
      </div>
    </>
  );
}
