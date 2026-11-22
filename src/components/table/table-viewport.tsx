"use client";

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
  const autoMeasureOverflow = isPageSticky && horizontal === undefined;
  const internalRef = React.useRef<HTMLDivElement | null>(null);
  const [measuredOverflow, setMeasuredOverflow] = React.useState<boolean | null>(null);

  const setViewportRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      internalRef.current = node;
      if (ref == null) return;
      if (typeof ref === "function") {
        ref(node);
      } else {
        ref.current = node;
      }
    },
    [ref],
  );

  React.useEffect(() => {
    if (!autoMeasureOverflow) return;
    const viewport = internalRef.current;
    if (!viewport) return;

    const measure = () => {
      if (viewport.clientWidth <= 0) return;
      const table = viewport.querySelector("table");
      if (!table) return;
      const nextOverflows = table.scrollWidth > viewport.clientWidth + 1;
      setMeasuredOverflow((current) => (current === nextOverflows ? current : nextOverflows));
    };

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(viewport);
      const table = viewport.querySelector("table");
      if (table) observer.observe(table);
      return () => observer.disconnect();
    }

    const rafId = window.requestAnimationFrame(measure);
    return () => window.cancelAnimationFrame(rafId);
  }, [autoMeasureOverflow]);

  const activeOverflow = autoMeasureOverflow ? measuredOverflow : null;

  const horizontalOverflowClass = isPageSticky
    ? horizontal === true
      ? "overflow-x-auto"
      : horizontal === false
        ? undefined
        : activeOverflow === true
          ? "overflow-x-auto"
          : activeOverflow === false
            ? "overflow-visible"
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
          : activeOverflow === true
            ? "scroll-shadow"
            : activeOverflow === false
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
        ref={setViewportRef}
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
