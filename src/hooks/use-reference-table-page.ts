"use client";

import { useCallback, useEffect, useRef } from "react";
import { useUrlFilters } from "@/hooks/use-url-filters";

export interface ReferenceTablePageWindow {
  /** 1-based page actually shown (an out-of-range URL page clamps without rewriting the URL). */
  page: number;
  totalPages: number;
  pageStartIndex: number;
  /** 1-based inclusive range; 0/0 when there are no rows. */
  rangeStart: number;
  rangeEnd: number;
}

export function parseReferenceTablePage(raw: string | null): number {
  if (!raw || !/^\d+$/.test(raw)) return 1;
  const page = Number.parseInt(raw, 10);
  return page >= 1 ? page : 1;
}

export function deriveReferenceTablePage(
  requestedPage: number,
  totalRows: number,
  pageSize: number,
): ReferenceTablePageWindow {
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const pageStartIndex = (page - 1) * pageSize;
  return {
    page,
    totalPages,
    pageStartIndex,
    rangeStart: totalRows === 0 ? 0 : pageStartIndex + 1,
    rangeEnd: Math.min(pageStartIndex + pageSize, totalRows),
  };
}

/**
 * URL-synced page for bounded reference tables (`?page=N`, 1-based, omitted on
 * page 1). Static HTML and the first hydration render always show page 1, so
 * the first page stays in the exported markup. When `resetKey` (the table's
 * filter/search/sort signature) changes after the URL is ready, the page
 * returns to 1 so a narrowed result never opens on an empty page.
 */
export function useReferenceTablePage({
  totalRows,
  pageSize,
  param = "page",
  resetKey = "",
}: {
  totalRows: number;
  pageSize: number;
  param?: string;
  resetKey?: string;
}) {
  const { searchParams, isReady, replaceParams } = useUrlFilters();
  const pageWindow = deriveReferenceTablePage(parseReferenceTablePage(searchParams.get(param)), totalRows, pageSize);

  const setPage = useCallback(
    (next: number) => {
      replaceParams((params) => {
        if (next <= 1) params.delete(param);
        else params.set(param, String(next));
      });
    },
    [param, replaceParams],
  );

  const previousResetKey = useRef<string | null>(null);
  useEffect(() => {
    if (!isReady) return;
    if (previousResetKey.current !== null && previousResetKey.current !== resetKey) setPage(1);
    previousResetKey.current = resetKey;
  }, [isReady, resetKey, setPage]);

  return { ...pageWindow, setPage };
}
