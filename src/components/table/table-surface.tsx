import * as React from "react";

import { cn } from "@/lib/utils";

import type { TableChrome, TableDensity, TableIdentityProps, TableStriping } from "./types";

const CHROME_CLASS_NAMES: Record<TableChrome, string> = {
  default: "pharos-table-shell",
  embedded: "overflow-hidden rounded-lg border border-border/60 bg-card/30",
  content: "overflow-hidden rounded-xl border border-border/70 bg-card/20",
  bare: "",
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
}

export function TableSurface({
  className,
  children,
  density = "compact",
  striped = false,
  chrome = "default",
  stickyHeader = false,
  tableId,
  testId,
  ref,
  ...props
}: TableSurfaceProps) {
  const resolvedTestId = testId ?? (tableId ? `${tableId}-table` : undefined);

  return (
    <div
      {...props}
      ref={ref}
      data-table-id={tableId}
      data-testid={resolvedTestId}
      className={cn(
        CHROME_CLASS_NAMES[chrome],
        `pharos-density-${density}`,
        getStripingClassName(striped),
        stickyHeader && "table-header-sticky",
        className,
      )}
    >
      {children}
    </div>
  );
}
