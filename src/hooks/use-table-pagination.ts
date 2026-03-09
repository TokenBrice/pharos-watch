"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

export interface UseTablePaginationOptions {
  pageSize: number;
  resetPageOnTotalChange?: boolean;
}

interface UseTablePaginationReturn<T> {
  effectivePage: number;
  totalPages: number;
  paginatedRows: T[];
  pageStartIndex: number;
  rangeStart: number;
  rangeEnd: number;
  totalRows: number;
  onPreviousPage: () => void;
  onNextPage: () => void;
}

export interface TablePaginationState {
  page: number;
  totalRowsSnapshot: number;
}

export interface DerivedPagination {
  basePage: number;
  effectivePage: number;
  totalPages: number;
  pageStartIndex: number;
}

export function reconcilePaginationStateOnTotalChange(
  previous: TablePaginationState,
  totalRows: number,
  resetPageOnTotalChange: boolean
): TablePaginationState {
  if (!resetPageOnTotalChange || previous.totalRowsSnapshot === totalRows) {
    return previous;
  }
  return {
    page: 0,
    totalRowsSnapshot: totalRows,
  };
}

export function derivePagination(
  pageState: TablePaginationState,
  totalRows: number,
  pageSize: number,
  resetPageOnTotalChange: boolean
): DerivedPagination {
  const basePage =
    resetPageOnTotalChange && pageState.totalRowsSnapshot !== totalRows ? 0 : pageState.page;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const effectivePage = basePage >= totalPages ? 0 : basePage;
  return {
    basePage,
    effectivePage,
    totalPages,
    pageStartIndex: effectivePage * pageSize,
  };
}

export function useTablePagination<T>(
  rows: readonly T[],
  options: UseTablePaginationOptions
): UseTablePaginationReturn<T> {
  const { pageSize, resetPageOnTotalChange = false } = options;
  const [pageState, setPageState] = useState<TablePaginationState>(() => ({
    page: 0,
    totalRowsSnapshot: rows.length,
  }));

  const totalRows = rows.length;
  const { effectivePage, totalPages, pageStartIndex } = derivePagination(
    pageState,
    totalRows,
    pageSize,
    resetPageOnTotalChange
  );

  useEffect(() => {
    // Persist the reset so a filtered table stays on page 1 even if the row
    // count later grows back to the previous size.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPageState((previous) =>
      reconcilePaginationStateOnTotalChange(previous, totalRows, resetPageOnTotalChange)
    );
  }, [resetPageOnTotalChange, totalRows]);

  const paginatedRows = useMemo(
    () => rows.slice(pageStartIndex, pageStartIndex + pageSize),
    [rows, pageStartIndex, pageSize]
  );

  const rangeStart = totalRows === 0 ? 0 : pageStartIndex + 1;
  const rangeEnd = Math.min(pageStartIndex + pageSize, totalRows);

  const onPreviousPage = useCallback(() => {
    setPageState({
      page: Math.max(0, effectivePage - 1),
      totalRowsSnapshot: totalRows,
    });
  }, [effectivePage, totalRows]);

  const onNextPage = useCallback(() => {
    setPageState({
      page: Math.min(totalPages - 1, effectivePage + 1),
      totalRowsSnapshot: totalRows,
    });
  }, [effectivePage, totalPages, totalRows]);

  return {
    effectivePage,
    totalPages,
    paginatedRows,
    pageStartIndex,
    rangeStart,
    rangeEnd,
    totalRows,
    onPreviousPage,
    onNextPage,
  };
}
