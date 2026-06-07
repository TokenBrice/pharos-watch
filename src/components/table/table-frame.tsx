import * as React from "react";

import { TableElement } from "./table-element";
import { TableSurface, type TableSurfaceProps } from "./table-surface";
import { TableViewport, type TableViewportProps } from "./table-viewport";

export interface TableFrameProps
  extends Omit<TableSurfaceProps, "children"> {
  children: React.ReactNode;
  topSlot?: React.ReactNode;
  footerSlot?: React.ReactNode;
  tableClassName?: string;
  tableProps?: Omit<React.ComponentProps<"table">, "children" | "className">;
  viewportClassName?: string;
  viewportProps?: Omit<TableViewportProps, "children" | "className">;
}

export function TableFrame({
  children,
  topSlot,
  footerSlot,
  tableClassName,
  tableProps,
  viewportClassName,
  viewportProps,
  ...surfaceProps
}: TableFrameProps) {
  return (
    <TableSurface {...surfaceProps}>
      {topSlot}
      <TableViewport className={viewportClassName} {...viewportProps}>
        <TableElement className={tableClassName} {...tableProps}>
          {children}
        </TableElement>
      </TableViewport>
      {footerSlot}
    </TableSurface>
  );
}
