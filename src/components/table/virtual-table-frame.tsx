import * as React from "react";

import { TableElement } from "./table-element";
import { TableSurface, type TableSurfaceProps } from "./table-surface";
import { TableViewport, type TableViewportProps } from "./table-viewport";

export interface VirtualTableFrameProps
  extends Omit<TableSurfaceProps, "children"> {
  children: React.ReactNode;
  topSlot?: React.ReactNode;
  footerSlot?: React.ReactNode;
  tableClassName?: string;
  tableProps?: Omit<React.ComponentProps<"table">, "children" | "className">;
  viewportClassName?: string;
  viewportProps?: Omit<TableViewportProps, "children" | "className">;
  surfaceRef?: React.Ref<HTMLDivElement>;
  viewportRef?: React.Ref<HTMLDivElement>;
  mobileScrollHint?: TableViewportProps["mobileScrollHint"];
}

export function VirtualTableFrame({
  children,
  topSlot,
  footerSlot,
  tableClassName,
  tableProps,
  viewportClassName,
  viewportProps,
  surfaceRef,
  viewportRef,
  mobileScrollHint = "Swipe sideways for more columns",
  striped = "indexed",
  ...surfaceProps
}: VirtualTableFrameProps) {
  const {
    ref: viewportPropsRef,
    mobileScrollHint: viewportPropsMobileScrollHint = mobileScrollHint,
    scrollShadow = true,
    horizontal = true,
    vertical = true,
    overscrollX = true,
    compactBottomPadding = false,
    ...resolvedViewportProps
  } = viewportProps ?? {};

  return (
    <TableSurface {...surfaceProps} ref={surfaceRef} striped={striped}>
      {topSlot}
      <TableViewport
        {...resolvedViewportProps}
        ref={viewportRef ?? viewportPropsRef}
        className={viewportClassName}
        mobileScrollHint={viewportPropsMobileScrollHint}
        scrollShadow={scrollShadow}
        horizontal={horizontal}
        vertical={vertical}
        overscrollX={overscrollX}
        compactBottomPadding={compactBottomPadding}
      >
        <TableElement className={tableClassName} {...tableProps}>
          {children}
        </TableElement>
      </TableViewport>
      {footerSlot}
    </TableSurface>
  );
}
