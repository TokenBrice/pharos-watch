import type { ReactNode } from "react";
import { DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { DISCLOSURE_SUMMARY_RESET_CLASS, DisclosureChevron } from "@/components/disclosure-panel";
import { cn } from "@/lib/utils";
import { LazyDetails } from "./lazy-details";

interface PrioritySplitTableProps<T> {
  primaryRows: readonly T[];
  secondaryRows: readonly T[];
  columns: readonly DataTableColumn[];
  idPrefix: string;
  primaryAriaLabel: string;
  secondaryAriaLabel: string;
  secondaryNoun: string;
  renderRow: (row: T) => ReactNode;
  primaryEmpty?: ReactNode;
  primaryTableId?: string;
  secondaryTableId?: string;
  headerClassName?: string;
  headerRowClassName?: string;
}

export function PrioritySplitTable<T>({
  primaryRows,
  secondaryRows,
  columns,
  idPrefix,
  primaryAriaLabel,
  secondaryAriaLabel,
  secondaryNoun,
  renderRow,
  primaryEmpty,
  primaryTableId,
  secondaryTableId,
  headerClassName = "",
  headerRowClassName,
}: PrioritySplitTableProps<T>) {
  const renderTable = (tableId: string, ariaLabel: string, rows: readonly T[], containerClassName?: string) => (
    <DataTableShell
      tableId={tableId}
      columns={columns}
      chrome="content"
      density="compact"
      containerClassName={containerClassName}
      tableProps={{ "aria-label": ariaLabel }}
      headerClassName={headerClassName}
      headerRowClassName={headerRowClassName}
    >
      {rows.map(renderRow)}
    </DataTableShell>
  );

  return (
    <>
      {primaryRows.length > 0
        ? renderTable(primaryTableId ?? `${idPrefix}-primary`, primaryAriaLabel, primaryRows)
        : (primaryEmpty ?? null)}
      {secondaryRows.length > 0 ? (
        <LazyDetails
          className={cn("group/disclosure", primaryRows.length > 0 && "mt-4")}
          summary={
            <summary
              className={cn(
                DISCLOSURE_SUMMARY_RESET_CLASS,
                "flex min-h-11 items-center justify-between gap-2 rounded-md px-1 text-sm text-muted-foreground transition-colors hover:text-foreground",
              )}
            >
              <span>
                {secondaryRows.length} healthy {secondaryNoun}
                {secondaryRows.length === 1 ? "" : "s"}
              </span>
              <DisclosureChevron />
            </summary>
          }
        >
          {renderTable(secondaryTableId ?? `${idPrefix}-secondary`, secondaryAriaLabel, secondaryRows, "mt-2")}
        </LazyDetails>
      ) : null}
    </>
  );
}
