"use client";

import { useContext } from "react";
import {
  QueryClientContext,
  useIsFetching,
  type QueryKey,
} from "@tanstack/react-query";
import {
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { Skeleton } from "@/components/ui/skeleton";
import { SortableTableHead } from "@/components/sortable-table-head";
import {
  TablePagination,
  type TablePaginationProps,
} from "@/components/table-pagination";
import { RefreshingBar } from "@/components/refreshing-bar";
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
  tableId?: string;
  testId?: string;
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
  /**
   * M1: query keys whose in-flight background refetch should surface a
   * `RefreshingBar` at the top of the shell. When the first load is still
   * pending (`isPending`), the skeleton owns the loading state and the bar
   * stays hidden; the bar only animates during the stale-while-revalidate
   * window. Omit to disable.
   */
  refreshingQueryKeys?: readonly QueryKey[];
  /** True while the table's first load is pending (skeleton state). */
  isPending?: boolean;
}

/**
 * Renders the SWR `RefreshingBar` driven by `useIsFetching` over the given
 * query keys. Split into its own component so the `useIsFetching` hook only
 * mounts when a QueryClient is in context — table unit tests that render the
 * shell without a provider simply skip the bar instead of throwing.
 */
function TableRefreshingBar({
  queryKeys,
  isPending,
  className,
}: {
  queryKeys: readonly QueryKey[];
  isPending: boolean;
  className?: string;
}) {
  const fetchingCount = useIsFetching({
    predicate: (query) =>
      queryKeys.some(
        (key) => JSON.stringify(query.queryKey) === JSON.stringify(key),
      ),
  });
  return <RefreshingBar active={!isPending && fetchingCount > 0} className={className} />;
}

/**
 * Provider-safe SWR bar for any power-user table. Reads the QueryClient from
 * context (returns null when absent, e.g. in unit tests) before mounting the
 * `useIsFetching` subscription. Exported so tables with bespoke shells
 * (e.g. the virtualized home table) can reuse the same guarded behavior.
 */
export function TableBackgroundRefreshingBar({
  queryKeys,
  isPending,
  className,
}: {
  queryKeys: readonly QueryKey[] | undefined;
  isPending: boolean;
  className?: string;
}) {
  const hasClient = useContext(QueryClientContext) != null;
  if (!hasClient || !queryKeys || queryKeys.length === 0) return null;
  return (
    <TableRefreshingBar
      queryKeys={queryKeys}
      isPending={isPending}
      className={className}
    />
  );
}

export function DataTableShell<K extends string>({
  tableId,
  testId,
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
  refreshingQueryKeys,
  isPending = false,
}: DataTableShellProps<K>) {
  return (
    <TableFrame
      tableId={tableId}
      testId={testId}
      className={containerClassName}
      tableClassName={tableClassName}
      viewportProps={{ mobileScrollHint }}
      density={density}
      striped={striped}
      topSlot={
        <>
          <TableBackgroundRefreshingBar queryKeys={refreshingQueryKeys} isPending={isPending} />
          {topSlot}
        </>
      }
      footerSlot={pagination ? <TablePagination {...pagination} /> : null}
    >
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
    </TableFrame>
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
  // M7 — soften the skeleton↔data swap with a 180ms fade-in. Table semantics
  // prevent a true absolute-positioned crossfade between row sets, but
  // animating the skeleton fade-in alone removes the perceptual pop without
  // touching consumer layout.
  return Array.from({ length: rowCount }, (_, rowIndex) => (
    <TableRow key={rowIndex} className="animate-fade-in">
      {columns.map((column, columnIndex) => (
        <TableCell key={column.id} className={column.className}>
          <Skeleton className={cn(columnIndex === 0 ? "h-6 w-24" : "ml-auto h-5 w-16")} />
        </TableCell>
      ))}
    </TableRow>
  ));
}
