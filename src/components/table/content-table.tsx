import * as React from "react";

import { cn } from "@/lib/utils";

import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table-element";
import { TableFrame, type TableFrameProps } from "./table-frame";

export interface ContentTableColumn {
  id: string;
  header: React.ReactNode;
  headerClassName?: string;
  cellClassName?: string;
}

export interface ContentTableRow {
  id: string;
  cells: Record<string, React.ReactNode>;
  cellClassNames?: Record<string, string>;
  className?: string;
}

export interface ContentTableProps extends Omit<TableFrameProps, "children"> {
  columns: readonly ContentTableColumn[];
  rows: readonly ContentTableRow[];
  headerRowClassName?: string;
}

export function ContentTable({
  columns,
  rows,
  headerRowClassName,
  viewportProps,
  ...frameProps
}: ContentTableProps) {
  return (
    <TableFrame
      chrome="content"
      density="compact"
      viewportProps={{ mobileScrollHint: false, ...viewportProps }}
      {...frameProps}
    >
      <TableHeader>
        <TableRow className={cn("text-left", headerRowClassName)}>
          {columns.map((column, index) => (
            <TableHead
              key={column.id}
              scope="col"
              className={cn(
                "py-2 text-foreground",
                index < columns.length - 1 && "pr-4",
                column.headerClassName,
              )}
            >
              {column.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id} className={row.className}>
            {columns.map((column, index) => (
              <TableCell
                key={column.id}
                className={cn(
                  "py-2",
                  index < columns.length - 1 && "pr-4",
                  column.cellClassName,
                  row.cellClassNames?.[column.id],
                )}
              >
                {row.cells[column.id]}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  );
}
