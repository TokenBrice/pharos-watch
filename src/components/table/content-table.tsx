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
  rowHeader?: boolean;
}

export interface ContentTableRow {
  id: string;
  cells: Record<string, React.ReactNode>;
  cellClassNames?: Record<string, string>;
  className?: string;
}

export interface ContentTableCellKeyIssue {
  rowId: string;
  missingCellKeys: string[];
  extraCellKeys: string[];
}

export interface ContentTableProps
  extends Omit<TableFrameProps, "children"> {
  columns: readonly ContentTableColumn[];
  rows: readonly ContentTableRow[];
  headerRowClassName?: string;
  rowHeaderColumnId?: string;
}

function getContentTableCellKeyIssues(
  columns: readonly ContentTableColumn[],
  rows: readonly ContentTableRow[],
): ContentTableCellKeyIssue[] {
  const columnIds = columns.map((column) => column.id);
  const columnIdSet = new Set(columnIds);

  return rows.flatMap((row) => {
    const cellKeys = Object.keys(row.cells);
    const missingCellKeys = columnIds.filter(
      (columnId) => !(columnId in row.cells),
    );
    const extraCellKeys = cellKeys.filter(
      (cellKey) => !columnIdSet.has(cellKey),
    );

    if (missingCellKeys.length === 0 && extraCellKeys.length === 0) {
      return [];
    }

    return [{ rowId: row.id, missingCellKeys, extraCellKeys }];
  });
}

export function assertContentTableRowsMatchColumns(
  columns: readonly ContentTableColumn[],
  rows: readonly ContentTableRow[],
  rowHeaderColumnId?: string,
) {
  if (
    rowHeaderColumnId
    && !columns.some((column) => column.id === rowHeaderColumnId)
  ) {
    throw new Error(
      `ContentTable rowHeaderColumnId must match a declared column. Unknown rowHeaderColumnId: ${rowHeaderColumnId}.`,
    );
  }

  const issues = getContentTableCellKeyIssues(columns, rows);

  if (issues.length === 0) return;

  const details = issues
    .map((issue) => {
      const parts = [
        issue.missingCellKeys.length
          ? `missing cells: ${issue.missingCellKeys.join(", ")}`
          : null,
        issue.extraCellKeys.length
          ? `extra cells: ${issue.extraCellKeys.join(", ")}`
          : null,
      ].filter(Boolean);

      return `${issue.rowId} (${parts.join("; ")})`;
    })
    .join("; ");

  throw new Error(
    `ContentTable row cells must match declared columns. Invalid rows: ${details}.`,
  );
}

export function ContentTable({
  columns,
  rows,
  headerRowClassName,
  rowHeaderColumnId,
  viewportProps,
  chrome = "content",
  density = "compact",
  ...frameProps
}: ContentTableProps) {
  // Run unconditionally: this is a static export, so SSG executes under
  // NODE_ENV=production. A dev-only guard would never fire during build,
  // letting a column/row mismatch ship as a silently broken table. The
  // O(columns×rows) check is negligible.
  assertContentTableRowsMatchColumns(columns, rows, rowHeaderColumnId);

  return (
    <TableFrame
      chrome={chrome}
      density={density}
      viewportProps={{ mobileScrollHint: false, ...viewportProps }}
      {...frameProps}
    >
      <TableHeader>
        <TableRow
          rowIntent="static"
          className={cn("text-left", headerRowClassName)}
        >
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
          <TableRow key={row.id} rowIntent="static" className={row.className}>
            {columns.map((column, index) => {
              const isRowHeader =
                column.rowHeader || column.id === rowHeaderColumnId;
              const cellClassName = cn(
                "py-2",
                index < columns.length - 1 && "pr-4",
                isRowHeader && "h-auto text-foreground",
                column.cellClassName,
                row.cellClassNames?.[column.id],
              );

              return isRowHeader ? (
                <TableHead
                  key={column.id}
                  scope="row"
                  className={cellClassName}
                >
                  {row.cells[column.id]}
                </TableHead>
              ) : (
                <TableCell key={column.id} className={cellClassName}>
                  {row.cells[column.id]}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  );
}
