"use client";

import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  containerClassName,
  tableClassName,
  headerClassName,
  pagination,
  striped = false,
  density = "comfortable",
}: DataTableShellProps<K>) {
  return (
    <div className={cn(
      "pharos-table-shell overflow-x-auto scroll-shadow",
      containerClassName
    )}>
      {topSlot}
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
      {pagination ? <TablePagination {...pagination} /> : null}
    </div>
  );
}
