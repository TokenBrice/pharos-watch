"use client";

import { useContext, useMemo } from "react";
import {
  hashKey,
  QueryClientContext,
  useIsFetching,
  type QueryKey,
} from "@tanstack/react-query";
import {
  TableBody,
  TableCaption,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeletonRows,
} from "@/components/table";
import { SortableTableHead } from "@/components/sortable-table-head";
import {
  TablePagination,
  type TablePaginationProps,
} from "@/components/table-pagination";
import { RefreshingBar } from "@/components/refreshing-bar";
import { cn } from "@/lib/utils";
import type { TableDensity } from "@/hooks/use-table-density";

type DataTableFrameProps = React.ComponentProps<typeof TableFrame>;

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

export interface DataTableShellProps<K extends string> {
  tableId?: string;
  testId?: string;
  chrome?: DataTableFrameProps["chrome"];
  columns: readonly DataTableColumn<K>[];
  children: React.ReactNode;
  sort?: DataTableSortControls<K>;
  topSlot?: React.ReactNode;
  mobileScrollHint?: React.ReactNode | false;
  containerClassName?: string;
  viewportClassName?: DataTableFrameProps["viewportClassName"];
  viewportProps?: DataTableFrameProps["viewportProps"];
  tableClassName?: string;
  tableProps?: DataTableFrameProps["tableProps"];
  caption?: React.ReactNode;
  captionClassName?: string;
  headerClassName?: string;
  headerRowClassName?: string;
  stickyHeader?: DataTableFrameProps["stickyHeader"];
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
  const queryKeyHashes = useMemo(
    () => new Set(queryKeys.map((queryKey) => hashKey(queryKey))),
    [queryKeys],
  );
  const fetchingCount = useIsFetching({
    predicate: (query) => queryKeyHashes.has(query.queryHash),
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
  chrome,
  columns,
  children,
  sort,
  topSlot,
  mobileScrollHint,
  containerClassName,
  viewportClassName,
  viewportProps,
  tableClassName,
  tableProps,
  caption,
  captionClassName,
  headerClassName,
  headerRowClassName,
  stickyHeader,
  pagination,
  striped = false,
  density = "compact",
  refreshingQueryKeys,
  isPending = false,
}: DataTableShellProps<K>) {
  const resolvedViewportProps = {
    ...viewportProps,
    mobileScrollHint:
      viewportProps?.mobileScrollHint ??
      mobileScrollHint ??
      "Swipe sideways for more columns",
  };

  return (
    <TableFrame
      tableId={tableId}
      testId={testId}
      chrome={chrome}
      className={containerClassName}
      viewportClassName={viewportClassName}
      viewportProps={resolvedViewportProps}
      tableClassName={tableClassName}
      tableProps={tableProps}
      density={density}
      striped={striped}
      stickyHeader={stickyHeader}
      topSlot={
        <>
          <TableBackgroundRefreshingBar queryKeys={refreshingQueryKeys} isPending={isPending} />
          {topSlot}
        </>
      }
      footerSlot={pagination ? <TablePagination {...pagination} /> : null}
    >
      {caption ? <TableCaption className={captionClassName}>{caption}</TableCaption> : null}
      <TableHeader className={headerClassName === undefined ? "bg-muted" : headerClassName}>
        <TableRow rowIntent="static" className={headerRowClassName}>
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
    <TableRow rowIntent="static">
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
  return (
    <TableSkeletonRows
      rowCount={rowCount}
      columns={columns.map((column, columnIndex) => ({
        id: column.id,
        cellClassName: column.className,
        skeletonClassName: columnIndex === 0 ? "h-6 w-24" : "ml-auto h-5 w-16",
      }))}
    />
  );
}

export interface DataTableSkeletonShellProps<K extends string>
  extends Omit<DataTableShellProps<K>, "children"> {
  rowCount?: number;
}

export function DataTableSkeletonShell<K extends string>({
  columns,
  rowCount = 5,
  isPending = true,
  ...shellProps
}: DataTableSkeletonShellProps<K>) {
  return (
    <DataTableShell
      {...shellProps}
      columns={columns}
      isPending={isPending}
    >
      <DataTableLoadingRows columns={columns} rowCount={rowCount} />
    </DataTableShell>
  );
}
