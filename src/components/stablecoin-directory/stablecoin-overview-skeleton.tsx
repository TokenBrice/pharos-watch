import type { ReactNode } from "react";

import {
  TableBody,
  TableCaption,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeletonRows,
  type TableSkeletonColumn,
} from "@/components/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { TableDensity } from "@/hooks/use-table-density";
import { cn } from "@/lib/utils";

const DEFAULT_OVERVIEW_SKELETON_ROWS = 20;

const DEFAULT_OVERVIEW_SKELETON_COLUMNS: readonly TableSkeletonColumn[] = [
  { id: "rank", cellClassName: "w-10 text-right", skeletonClassName: "ml-auto h-4 w-5" },
  { id: "name", skeletonClassName: "h-4 w-36" },
  { id: "price", cellClassName: "text-right", skeletonClassName: "ml-auto h-4 w-14" },
  { id: "peg", cellClassName: "hidden text-right sm:table-cell", skeletonClassName: "ml-auto h-4 w-12" },
  { id: "mcap", cellClassName: "text-right", skeletonClassName: "ml-auto h-4 w-16" },
  { id: "change24h", cellClassName: "hidden text-right md:table-cell", skeletonClassName: "ml-auto h-4 w-12" },
  { id: "change7d", cellClassName: "hidden text-right lg:table-cell", skeletonClassName: "ml-auto h-4 w-12" },
  { id: "grade", cellClassName: "hidden text-center md:table-cell", skeletonClassName: "mx-auto h-4 w-7" },
];

const DEFAULT_OVERVIEW_SKELETON_HEADERS: readonly { id: string; label: string; className?: string }[] = [
  { id: "rank", label: "#", className: "w-10 text-right" },
  { id: "name", label: "Name" },
  { id: "price", label: "Price", className: "text-right" },
  { id: "peg", label: "Peg", className: "hidden text-right sm:table-cell" },
  { id: "mcap", label: "MC", className: "text-right" },
  { id: "change24h", label: "24h", className: "hidden text-right md:table-cell" },
  { id: "change7d", label: "7d", className: "hidden text-right lg:table-cell" },
  { id: "grade", label: "Grade", className: "hidden text-center md:table-cell" },
];

export interface StablecoinOverviewSkeletonProps {
  /** Render the matching search/controls toolbar placeholder above the table shell. */
  showToolbar?: boolean;
  /** Number of placeholder rows (defaults to the 20-row Overview page size). */
  rowCount?: number;
  /** Custom skeleton column definitions (defaults to the canonical Overview columns). */
  columns?: readonly TableSkeletonColumn[];
  /** Optional custom `<thead>` element (e.g. live `StablecoinTableHeader`). */
  header?: ReactNode;
  /** Stable table id on the shell (defaults to `"stablecoin-overview-loading"`). */
  tableId?: string;
  /** Table row density (defaults to `"compact"`). */
  density?: TableDensity;
  /** Optional minimum table width in px when matching live column widths. */
  tableMinWidthPx?: number;
  className?: string;
}

/**
 * Single unified loading skeleton for the Homepage Stablecoin Overview table.
 * Server-safe so SSR placeholders, `next/dynamic` fallbacks, and in-table
 * `isLoading` states render identical geometry without 3-stage layout shift.
 */
export function StablecoinOverviewSkeleton({
  showToolbar = true,
  rowCount = DEFAULT_OVERVIEW_SKELETON_ROWS,
  columns = DEFAULT_OVERVIEW_SKELETON_COLUMNS,
  header,
  tableId = "stablecoin-overview-loading",
  density = "compact",
  tableMinWidthPx,
  className,
}: StablecoinOverviewSkeletonProps) {
  return (
    <div className={cn("space-y-3", className)} data-testid="stablecoin-overview-skeleton">
      {showToolbar ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Skeleton className="h-11 w-full max-w-[220px] rounded-md sm:h-8" />
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="h-11 w-24 rounded-lg sm:h-8 sm:w-16" />
            <Skeleton className="h-11 w-24 rounded-md sm:h-8" />
            <Skeleton className="h-11 w-24 rounded-md sm:h-8" />
          </div>
        </div>
      ) : null}
      <TableFrame
        tableId={tableId}
        chrome="default"
        density={density}
        striped="indexed"
        stickyHeader
        stickyMode="page"
        mobileScrollHint={false}
        viewportProps={{
          horizontal: false,
          scrollShadow: false,
          overscrollX: false,
          compactBottomPadding: false,
        }}
        tableClassName="w-full table-fixed"
        tableProps={tableMinWidthPx ? { style: { minWidth: tableMinWidthPx } } : undefined}
        footerSlot={
          <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <Skeleton className="h-4 w-48" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-20 rounded-md" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-8 w-16 rounded-md" />
            </div>
          </div>
        }
      >
        <TableCaption className="sr-only">Stablecoin data table loading</TableCaption>
        {header ?? (
          <TableHeader className="bg-card">
            <TableRow rowIntent="static">
              {DEFAULT_OVERVIEW_SKELETON_HEADERS.map((col) => (
                <TableHead key={col.id} scope="col" className={col.className}>
                  {col.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
        )}
        <TableBody>
          <TableSkeletonRows columns={columns} rowCount={rowCount} />
        </TableBody>
      </TableFrame>
    </div>
  );
}
