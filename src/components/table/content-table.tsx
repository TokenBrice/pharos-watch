import * as React from "react";

import { cn } from "@/lib/utils";

import {
  TableBody,
  TableCaption,
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

export interface ContentTableFrameProps extends TableFrameProps {
  caption?: React.ReactNode;
  captionClassName?: string;
  tableAriaLabel?: string;
}

export interface ContentTableProps
  extends Omit<ContentTableFrameProps, "children"> {
  columns: readonly ContentTableColumn[];
  rows: readonly ContentTableRow[];
  headerRowClassName?: string;
  rowHeaderColumnId?: string;
}

export function getContentTableCellKeyIssues(
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
) {
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

export function ContentTableFrame({
  children,
  caption,
  captionClassName,
  tableAriaLabel,
  viewportProps,
  tableProps,
  chrome = "content",
  density = "compact",
  ...frameProps
}: ContentTableFrameProps) {
  return (
    <TableFrame
      chrome={chrome}
      density={density}
      viewportProps={{ mobileScrollHint: false, ...viewportProps }}
      tableProps={
        tableAriaLabel
          ? { ...tableProps, "aria-label": tableAriaLabel }
          : tableProps
      }
      {...frameProps}
    >
      {caption != null ? (
        <TableCaption className={captionClassName}>{caption}</TableCaption>
      ) : null}
      {children}
    </TableFrame>
  );
}

export function ContentTable({
  columns,
  rows,
  headerRowClassName,
  rowHeaderColumnId,
  ...frameProps
}: ContentTableProps) {
  if (process.env.NODE_ENV !== "production") {
    assertContentTableRowsMatchColumns(columns, rows);
  }

  return (
    <ContentTableFrame {...frameProps}>
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
    </ContentTableFrame>
  );
}
