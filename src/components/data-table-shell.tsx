"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { SortableTableHead } from "@/components/sortable-table-head";
import {
  TablePagination,
  type TablePaginationProps,
} from "@/components/table-pagination";
import { cn } from "@/lib/utils";
import type { TableDensity } from "@/hooks/use-table-density";

interface DataTableColumnBase {
  id: string;
  headerAdornment?: React.ReactNode;
  className?: string;
  title?: string;
}

type DataTableStaticColumn = DataTableColumnBase & {
  label: React.ReactNode;
  sortKey?: undefined;
  sortLabel?: undefined;
};

type DataTableSortableColumn<K extends string> = DataTableColumnBase & {
  label: string;
  sortKey: K;
  sortLabel?: string;
};

export type DataTableColumn<K extends string = string> = DataTableStaticColumn | DataTableSortableColumn<K>;

export interface DataTableSortControls<K extends string> {
  sortKey: K;
  sortDirection: "asc" | "desc";
  toggleSort: (key: K) => void;
  getAriaSortValue: (key: K) => "ascending" | "descending" | "none";
}

interface DataTableShellProps<K extends string> {
  columns: readonly DataTableColumn<K>[];
  children: React.ReactNode;
  sort?: DataTableSortControls<K>;
  topSlot?: React.ReactNode;
  mobileScrollHint?: React.ReactNode | false;
  containerClassName?: string;
  tableClassName?: string;
  headerClassName?: string;
  pagination?: TablePaginationProps;
  /** Enable striped rows for horizontal scanning */
  striped?: boolean;
  /** Density mode for row height */
  density?: TableDensity;
}

export function DataTableShell<K extends string>({
  columns,
  children,
  sort,
  topSlot,
  mobileScrollHint = "Swipe sideways for more columns",
  containerClassName,
  tableClassName,
  headerClassName,
  pagination,
  striped = false,
  density = "comfortable",
}: DataTableShellProps<K>) {
  return (
    <div className={cn(
      "pharos-table-shell",
      containerClassName
    )}>
      {topSlot}
      {mobileScrollHint ? (
        <div className="border-b border-border/50 px-4 py-2 text-[11px] font-medium text-muted-foreground sm:hidden">
          {mobileScrollHint}
        </div>
      ) : null}
      <div className="scroll-shadow overflow-x-auto overscroll-x-contain pb-3 sm:pb-0">
        <Table className={cn(tableClassName, striped && "pharos-table-striped", `pharos-density-${density}`)}>
          <TableHeader className={cn("bg-muted", headerClassName)}>
            <TableRow>
              {columns.map((column) =>
                column.sortKey && sort ? (
                  <SortableTableHead
                    key={column.id}
                    sortKey={column.sortKey}
                    currentSortKey={sort.sortKey}
                    sortDirection={sort.sortDirection}
                    label={column.sortLabel ?? (typeof column.label === "string" ? column.label : "")}
                    toggleSort={sort.toggleSort}
                    getAriaSortValue={sort.getAriaSortValue}
                    adornment={column.headerAdornment}
                    className={column.className}
                    title={column.title}
                  />
                ) : (
                  <TableHead
                    key={column.id}
                    className={column.className}
                    title={column.title}
                  >
                    {column.label}
                  </TableHead>
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>{children}</TableBody>
        </Table>
      </div>
      {pagination ? <TablePagination {...pagination} /> : null}
    </div>
  );
}

export function DataTableEmptyRow({
  colSpan,
  children,
  className,
}: {
  colSpan: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className={cn("py-12 text-center text-muted-foreground", className)}>
        {children}
      </TableCell>
    </TableRow>
  );
}

export function DataTableLoadingRows({
  columns,
  rowCount = 5,
}: {
  columns: readonly Pick<DataTableColumn, "id" | "className">[];
  rowCount?: number;
}) {
  return Array.from({ length: rowCount }, (_, rowIndex) => (
    <TableRow key={rowIndex}>
      {columns.map((column, columnIndex) => (
        <TableCell key={column.id} className={column.className}>
          <Skeleton className={cn(columnIndex === 0 ? "h-6 w-24" : "ml-auto h-5 w-16")} />
        </TableCell>
      ))}
    </TableRow>
  ));
}
