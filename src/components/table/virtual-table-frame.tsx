import * as React from "react";

import { TableElement } from "./table-element";
import { hasTableCaptionChild, withFallbackTableAriaLabel } from "./table-label";
import { TableSurface, type TableSurfaceProps } from "./table-surface";
import { TableViewport, type TableViewportProps } from "./table-viewport";

export interface VirtualTableFrameProps
  extends Omit<TableSurfaceProps, "children" | "ref"> {
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
  ref?: React.Ref<HTMLDivElement>;
}

function assignRef<T>(ref: React.Ref<T> | undefined, node: T | null) {
  if (ref == null) return;
  if (typeof ref === "function") {
    ref(node);
  } else {
    ref.current = node;
  }
}

function useComposedRef<T>(firstRef: React.Ref<T> | undefined, secondRef: React.Ref<T> | undefined) {
  return React.useMemo(() => {
    if (firstRef == null && secondRef == null) return undefined;

    return (node: T | null) => {
      assignRef(firstRef, node);
      assignRef(secondRef, node);
    };
  }, [firstRef, secondRef]);
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
  ref,
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
  const composedSurfaceRef = useComposedRef(ref, surfaceRef);
  const composedViewportRef = useComposedRef(viewportRef, viewportPropsRef);
  const resolvedTablePropsWithLabel = withFallbackTableAriaLabel(surfaceProps.tableId, tableProps, {
    hasCaption: hasTableCaptionChild(children),
  });

  return (
    <TableSurface {...surfaceProps} ref={composedSurfaceRef} striped={striped}>
      {topSlot}
      <TableViewport
        {...resolvedViewportProps}
        ref={composedViewportRef}
        className={viewportClassName}
        mobileScrollHint={viewportPropsMobileScrollHint}
        scrollShadow={scrollShadow}
        horizontal={horizontal}
        vertical={vertical}
        overscrollX={overscrollX}
        compactBottomPadding={compactBottomPadding}
      >
        <TableElement className={tableClassName} {...resolvedTablePropsWithLabel}>
          {children}
        </TableElement>
      </TableViewport>
      {footerSlot}
    </TableSurface>
  );
}
