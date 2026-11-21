import * as React from "react";

import { cn } from "@/lib/utils";

import type {
  TableChrome,
  TableDensity,
  TableIdentityProps,
  TableStickyMode,
  TableStriping,
} from "./types";

const CHROME_CLASS_NAMES: Record<TableChrome, string> = {
  default: "pharos-table-shell",
  embedded: "overflow-hidden rounded-lg border border-border/60 bg-card/30",
  content: "overflow-hidden rounded-xl border border-border/70 bg-card/20",
  bare: "",
};

const STICKY_MODE_CLASS_NAMES: Record<TableStickyMode, string> = {
  page: "overflow-clip [--table-header-top:var(--sticky-header-bottom,3.75rem)] [--table-header-bg:var(--card-bg)] [&_thead]:sticky [&_thead]:top-[var(--sticky-header-bottom,3.75rem)] [&_thead]:z-10 [&_thead]:bg-card [&_thead_tr]:border-b [&_thead_tr]:border-border [&_thead_tr]:bg-card",
  viewport: "[--table-header-top:0px] [--table-header-bg:var(--card-bg)] [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-card [&_thead_tr]:border-b [&_thead_tr]:border-border [&_thead_tr]:bg-card",
};

function getStripingClassName(striped: TableStriping | undefined) {
  if (striped === "indexed") return "pharos-table-striped-indexed";
  if (striped) return "pharos-table-striped";
  return undefined;
}

export interface TableSurfaceProps
  extends React.ComponentPropsWithRef<"div">,
    TableIdentityProps {
  density?: TableDensity;
  striped?: TableStriping;
  chrome?: TableChrome;
  stickyHeader?: boolean;
  stickyMode?: TableStickyMode;
}

export function TableSurface({
  className,
  children,
  density = "compact",
  striped = false,
  chrome = "default",
  stickyHeader = false,
  stickyMode,
  tableId,
  testId,
  ref,
  ...props
}: TableSurfaceProps) {
  const resolvedTestId = testId ?? (tableId ? `${tableId}-table` : undefined);
  const resolvedStickyMode: TableStickyMode | undefined = stickyHeader
    ? (stickyMode ?? "page")
    : undefined;

  return (
    <div
      {...props}
      ref={ref}
      data-table-id={tableId}
      data-testid={resolvedTestId}
      data-sticky-mode={resolvedStickyMode}
      className={cn(
        CHROME_CLASS_NAMES[chrome],
        `pharos-density-${density}`,
        getStripingClassName(striped),
        stickyHeader && "table-header-sticky",
        resolvedStickyMode && STICKY_MODE_CLASS_NAMES[resolvedStickyMode],
        className,
      )}
    >
      {children}
    </div>
  );
}
