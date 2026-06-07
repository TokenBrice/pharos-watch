import * as React from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { TableCell, TableRow } from "./table-element";
import type { TableRowIntent } from "./types";

export interface TableSkeletonColumn {
  id: string;
  cellClassName?: string;
  skeletonClassName?: string;
}

export function TableSkeletonRows({
  columns,
  rowCount = 5,
  rowIntent = "static",
}: {
  columns: readonly TableSkeletonColumn[];
  rowCount?: number;
  rowIntent?: TableRowIntent;
}) {
  return Array.from({ length: rowCount }, (_, rowIndex) => (
    <TableRow key={rowIndex} rowIntent={rowIntent} className="animate-fade-in">
      {columns.map((column) => (
        <TableCell key={column.id} className={column.cellClassName}>
          <Skeleton className={cn("h-4 w-16", column.skeletonClassName)} />
        </TableCell>
      ))}
    </TableRow>
  ));
}
