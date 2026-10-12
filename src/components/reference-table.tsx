"use client";

import { Fragment, useCallback, useRef } from "react";
import { TableBody, TableFrame, TableHeader } from "@/components/table";
import { TablePagination } from "@/components/table-pagination";
import { useReferenceTablePage } from "@/hooks/use-reference-table-page";
import { TABLE_PAGE_SIZE } from "@/lib/constants";
import { cn } from "@/lib/utils";

export interface ReferenceTableProps<T> {
  tableId: string;
  testId?: string;
  /** Rows after search/filter/sort; the table only pages them. */
  rows: readonly T[];
  getRowKey: (row: T) => string;
  /** Header row (`<TableRow>` of `<TableHead>`s), rendered in a sticky `<thead>`. */
  head: React.ReactNode;
  /** One `<TableRow>` per row. */
  renderRow: (row: T) => React.ReactNode;
  /**
   * Narrow-container card for one row. When set, cards replace the table
   * below a 64rem container (container query, no JS breakpoint).
   */
  renderCard?: (row: T) => React.ReactNode;
  /** Unfiltered row count, so a filtered count reads "N of M". */
  totalCount?: number;
  noun: string;
  pageSize?: number;
  /** URL param for the page; distinct tables on one route need distinct params. */
  pageParam?: string;
  /** Filter/search/sort signature; a change returns the table to page 1. */
  resetKey?: string;
  caption?: React.ReactNode;
  tableClassName?: string;
  tableProps?: React.ComponentProps<typeof TableFrame>["tableProps"];
  className?: string;
}

/**
 * Bounded reference list for unbounded catalogue pages (coverage, compliance):
 * URL-synced paging over pre-filtered rows, a sticky header, compact density,
 * an honest "a–b of N" count, and an optional container-query card layout.
 * Page 1 renders in static HTML, so the first page stays crawlable.
 */
export function ReferenceTable<T>({
  tableId,
  testId,
  rows,
  getRowKey,
  head,
  renderRow,
  renderCard,
  totalCount,
  noun,
  pageSize = TABLE_PAGE_SIZE,
  pageParam = "page",
  resetKey,
  caption,
  tableClassName,
  tableProps,
  className,
}: ReferenceTableProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { page, totalPages, pageStartIndex, rangeStart, rangeEnd, setPage } = useReferenceTablePage({
    totalRows: rows.length,
    pageSize,
    param: pageParam,
    resetKey,
  });
  const pageRows = rows.slice(pageStartIndex, pageStartIndex + pageSize);

  const goToPage = useCallback(
    (next: number) => {
      setPage(next);
      // Keep the reader at the top of the new page instead of mid-way down the old one.
      const top = rootRef.current?.getBoundingClientRect().top;
      if (top != null && top < 0) rootRef.current?.scrollIntoView({ block: "start" });
    },
    [setPage],
  );

  const isFiltered = totalCount != null && totalCount !== rows.length;
  const renderPagination = (bordered: boolean) => (
    <TablePagination
      bordered={bordered}
      page={page - 1}
      totalPages={totalPages}
      rangeStart={rangeStart}
      rangeEnd={rangeEnd}
      total={rows.length}
      noun={noun}
      onPrevious={() => goToPage(page - 1)}
      onNext={() => goToPage(page + 1)}
      showControls={totalPages > 1}
      supplementaryText={
        isFiltered || totalPages > 1 ? (
          <>
            {totalPages > 1 ? `Page ${page} of ${totalPages}` : null}
            {isFiltered && totalPages > 1 ? " · " : null}
            {isFiltered ? `filtered from ${totalCount.toLocaleString("en-US")}` : null}
          </>
        ) : null
      }
    />
  );

  return (
    <div ref={rootRef} className={cn("@container scroll-mt-[var(--table-header-top,0px)]", className)}>
      <TableFrame
        tableId={tableId}
        testId={testId}
        caption={caption}
        captionClassName="sr-only"
        chrome="bare"
        density="compact"
        stickyHeader
        className={cn(
          "pharos-table-shell overflow-clip",
          renderCard ? "hidden @5xl:block" : undefined,
        )}
        tableClassName={tableClassName}
        tableProps={tableProps}
        // No scroll container around the table: the sticky header pins to the page.
        viewportProps={{
          compactBottomPadding: false,
          horizontal: false,
          mobileScrollHint: false,
          overscrollX: false,
          scrollShadow: false,
        }}
        footerSlot={renderPagination(true)}
      >
        <TableHeader>{head}</TableHeader>
        <TableBody>
          {pageRows.map((row) => (
            <Fragment key={getRowKey(row)}>{renderRow(row)}</Fragment>
          ))}
        </TableBody>
      </TableFrame>
      {renderCard ? (
        <div className="@5xl:hidden">
          <ul className="space-y-3">
            {pageRows.map((row) => (
              <li key={getRowKey(row)} className="[contain-intrinsic-size:auto_240px] [content-visibility:auto]">
                {renderCard(row)}
              </li>
            ))}
          </ul>
          <div className="mt-3 rounded-xl border border-border/60">{renderPagination(false)}</div>
        </div>
      ) : null}
    </div>
  );
}
