import * as React from "react";

import { TableCaption } from "./table-element";
import { TableFrame, type TableFrameProps } from "./table-frame";

export interface MatrixTableProps
  extends Omit<TableFrameProps, "children" | "tableProps"> {
  children: React.ReactNode;
  caption?: React.ReactNode;
  captionClassName?: string;
  tableAriaLabel?: string;
}

export function MatrixTable({
  children,
  caption,
  captionClassName,
  tableAriaLabel,
  ...frameProps
}: MatrixTableProps) {
  return (
    <TableFrame
      {...frameProps}
      tableProps={tableAriaLabel ? { "aria-label": tableAriaLabel } : undefined}
    >
      {caption != null ? (
        <TableCaption className={captionClassName}>{caption}</TableCaption>
      ) : null}
      {children}
    </TableFrame>
  );
}
