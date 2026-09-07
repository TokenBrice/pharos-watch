import * as React from "react";

import { TableCaption, TableElement } from "./table-element";
import { resolveTableFrameProps } from "./table-label";
import { TableSurface, type TableSurfaceProps } from "./table-surface";
import { TableViewport, type TableViewportProps } from "./table-viewport";

export interface TableFrameProps
  extends Omit<TableSurfaceProps, "children" | "ref"> {
  children: React.ReactNode;
  caption?: React.ReactNode;
  captionClassName?: string;
  topSlot?: React.ReactNode;
  footerSlot?: React.ReactNode;
  tableClassName?: string;
  tableAriaLabel?: string;
  tableProps?: Omit<React.ComponentProps<"table">, "children" | "className">;
  viewportClassName?: string;
  viewportProps?: Omit<TableViewportProps, "children" | "className">;
  viewportDefaults?: "virtual";
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

export function TableFrame({
  children,
  caption,
  captionClassName,
  topSlot,
  footerSlot,
  tableClassName,
  tableAriaLabel,
  tableProps,
  viewportClassName,
  viewportProps,
  viewportDefaults,
  surfaceRef,
  viewportRef,
  mobileScrollHint,
  ref,
  striped,
  ...surfaceProps
}: TableFrameProps) {
  const {
    ref: viewportPropsRef,
    mobileScrollHint: viewportPropsMobileScrollHint = mobileScrollHint,
    vertical,
    compactBottomPadding,
    ...resolvedViewportProps
  } = viewportProps ?? {};
  const composedSurfaceRef = useComposedRef(ref, surfaceRef);
  const composedViewportRef = useComposedRef(viewportRef, viewportPropsRef);
  const tableChildren = (
    <>
      {caption != null ? (
        <TableCaption className={captionClassName}>{caption}</TableCaption>
      ) : null}
      {children}
    </>
  );
  const resolvedTableProps = resolveTableFrameProps(
    surfaceProps.tableId,
    tableAriaLabel ? { ...tableProps, "aria-label": tableAriaLabel } : tableProps,
    tableChildren,
  );
  const virtual = viewportDefaults === "virtual";

  return (
    <TableSurface
      {...surfaceProps}
      ref={composedSurfaceRef}
      striped={striped ?? (virtual ? "indexed" : undefined)}
    >
      {topSlot}
      <TableViewport
        {...resolvedViewportProps}
        ref={composedViewportRef}
        className={viewportClassName}
        mobileScrollHint={viewportPropsMobileScrollHint}
        vertical={vertical ?? (virtual ? true : undefined)}
        compactBottomPadding={compactBottomPadding ?? (virtual ? false : undefined)}
      >
        <TableElement className={tableClassName} {...resolvedTableProps}>
          {tableChildren}
        </TableElement>
      </TableViewport>
      {footerSlot}
    </TableSurface>
  );
}
