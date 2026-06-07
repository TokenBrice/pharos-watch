import * as React from "react";

import { cn } from "@/lib/utils";

export interface TableViewportProps extends React.HTMLAttributes<HTMLDivElement> {
  mobileScrollHint?: React.ReactNode | false;
  scrollShadow?: boolean;
  horizontal?: boolean;
  vertical?: boolean;
  overscrollX?: boolean;
  compactBottomPadding?: boolean;
}

export function TableViewport({
  className,
  children,
  mobileScrollHint = "Swipe sideways for more columns",
  scrollShadow = true,
  horizontal = true,
  vertical = false,
  overscrollX = true,
  compactBottomPadding = true,
  ...props
}: TableViewportProps) {
  return (
    <>
      {mobileScrollHint ? (
        <div className="border-b border-border/50 px-4 py-2 text-[11px] font-medium text-muted-foreground sm:hidden">
          {mobileScrollHint}
        </div>
      ) : null}
      <div
        {...props}
        data-slot="table-viewport"
        className={cn(
          scrollShadow && "scroll-shadow",
          horizontal && "overflow-x-auto",
          vertical && "overflow-y-auto",
          overscrollX && "overscroll-x-contain",
          compactBottomPadding && "pb-3 sm:pb-0",
          className,
        )}
      >
        {children}
      </div>
    </>
  );
}
