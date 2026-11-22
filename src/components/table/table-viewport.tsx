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

  // CSS Overflow L3 §3.2: whenever `overflow-x: auto` is active on this div,
  // `overflow-y` computes to `auto` and this viewport becomes the sticky
  // containing block for `<thead>`. Leaving a page-header `--table-header-top`
  // (56–59px) active would offset `<thead>` down into Row 1 with an empty gap
  // above it. Reset `--table-header-top` to 0px whenever horizontal scrolling
  // is active, and restore the page offset once the table fits horizontally.
  const scrollXState: "true" | "responsive" | undefined = isPageSticky
    ? horizontal === true || activeOverflow === true
      ? "true"
      : horizontal === false || activeOverflow === false
        ? undefined
        : "responsive"
    : undefined;

  const horizontalOverflowClass = isPageSticky
    ? scrollXState === "true"
      ? "overflow-x-auto"
      : scrollXState === "responsive"
        ? "overflow-x-auto lg:overflow-visible"
        : horizontal === false
          ? undefined
          : "overflow-visible"
    : (horizontal ?? true)
      ? "overflow-x-auto"
      : undefined;
  const scrollShadowClass = !scrollShadow
    ? undefined
    : isPageSticky
      ? scrollXState === "true"
        ? "scroll-shadow"
        : scrollXState === "responsive"
          ? "scroll-shadow lg:bg-none"
          : undefined
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
        data-scroll-x={scrollXState}
        className={cn(
          // Containing block for absolutely-positioned descendants (e.g.
          // `sr-only` header labels): without it they escape the scroller's
          // overflow clip at their static position and widen the document.
          "relative",
          scrollShadowClass,
          horizontalOverflowClass,
          // A vertically or horizontally scrolling viewport is the sticky
          // header's scroll container, so the page-level `--table-header-top`
          // offset (sized for the site header) would float the thead over row 1.
          isViewportSticky && "overflow-y-auto [--table-header-top:0px]",
          scrollXState === "true" && "[--table-header-top:0px]",
          scrollXState === "responsive" && "[--table-header-top:0px] lg:[--table-header-top:var(--sticky-header-bottom,3.75rem)]",
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
