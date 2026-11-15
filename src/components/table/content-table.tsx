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
  /**
   * `lean` renders bounded, server-only previews: shared cell geometry moves
   * from every cell to the table once, so a 20-row preview does not repeat
   * ~140 bytes of utilities on each of its cells in both the static HTML and
   * the RSC payload. Cells keep `data-slot`, `scope`, column classes and the
   * `px-3`/`py-2`/`h-10` hooks the density tokens override.
   */
  variant?: "default" | "lean";
}

const LEAN_TABLE_CLASS_NAME =
  "[&_td]:align-middle [&_th]:align-middle [&_th]:font-medium [&_th]:text-left [&_th[scope=row]]:text-foreground";
const LEAN_BODY_CLASS_NAME = "[&_tr]:border-b";

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
  variant = "default",
  tableClassName,
  ...frameProps
}: ContentTableProps) {
  // Run unconditionally: this is a static export, so SSG executes under
  // NODE_ENV=production. A dev-only guard would never fire during build,
  // letting a column/row mismatch ship as a silently broken table. The
  // O(columns×rows) check is negligible.
  assertContentTableRowsMatchColumns(columns, rows, rowHeaderColumnId);
  const lean = variant === "lean";
  const lastColumnIndex = columns.length - 1;

  return (
    <TableFrame
      chrome={chrome}
      density={density}
      viewportProps={{ mobileScrollHint: false, ...viewportProps }}
      {...frameProps}
      tableClassName={lean ? cn(LEAN_TABLE_CLASS_NAME, tableClassName) : tableClassName}
    >
      <TableHeader>
        <TableRow
          rowIntent="static"
          lean={lean}
          className={lean ? headerRowClassName : cn("text-left", headerRowClassName)}
        >
          {columns.map((column, index) => (
            <TableHead
              key={column.id}
              scope="col"
              lean={lean}
              className={cn(
                lean ? "h-10 whitespace-nowrap px-3 py-2 text-foreground" : "py-2 text-foreground",
                index < lastColumnIndex && "pr-4",
                column.headerClassName,
              )}
            >
              {column.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody className={lean ? LEAN_BODY_CLASS_NAME : undefined}>
        {rows.map((row) => (
          <TableRow key={row.id} rowIntent="static" lean={lean} className={row.className}>
            {columns.map((column, index) => {
              const isRowHeader =
                column.rowHeader || column.id === rowHeaderColumnId;
              const cellClassName = cn(
                lean ? "whitespace-nowrap px-3 py-2" : "py-2",
                index < lastColumnIndex && "pr-4",
                isRowHeader && !lean && "h-auto text-foreground",
                column.cellClassName,
                row.cellClassNames?.[column.id],
              );

              return isRowHeader ? (
                <TableHead
                  key={column.id}
                  scope="row"
                  lean={lean}
                  className={cellClassName}
                >
                  {row.cells[column.id]}
                </TableHead>
              ) : (
                <TableCell key={column.id} lean={lean} className={cellClassName}>
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
