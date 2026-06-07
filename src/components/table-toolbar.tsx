"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TableSettingsMenu, TableToolbarFrame } from "@/components/table";
import { ColumnVisibilityDropdown } from "./stablecoin-table-column-visibility";
import type { TableDensity } from "@/hooks/use-table-density";
import type { ColumnId } from "@/hooks/use-preferences";

interface TableToolbarProps {
  // Density
  density: TableDensity;
  onDensityChange: (density: TableDensity) => void;

  // Columns
  visibleColumns: ColumnId[];
  onVisibleColumnsChange: (value: ColumnId[] | ((prev: ColumnId[]) => ColumnId[])) => void;
  onResetColumns: () => void;
  defaultColumns: ColumnId[];

  // Export
  onExport: () => void;
  exportDisabled?: boolean;

  // Additional actions
  additionalActions?: React.ReactNode;

  // Copy overrides — callers can swap the eyebrow or hide the description
  eyebrow?: string;
  description?: string | null;
  // When `titleId` is provided, the eyebrow is promoted to a proper h2 title
  // (used by compact homepage views to anchor the table region without a separate band).
  titleId?: string;
  meta?: string;
}

const DEFAULT_TOOLBAR_DESCRIPTION =
  "Tune density, hide noise, and export the current lens without leaving the table.";

export function TableToolbar({
  density,
  onDensityChange,
  visibleColumns,
  onVisibleColumnsChange,
  onResetColumns,
  defaultColumns,
  onExport,
  exportDisabled,
  additionalActions,
  eyebrow = "Table Controls",
  description = DEFAULT_TOOLBAR_DESCRIPTION,
  titleId,
  meta,
}: TableToolbarProps) {
  return (
    <TableToolbarFrame
      eyebrow={eyebrow}
      description={description}
      titleId={titleId}
      meta={meta}
      actions={(
        <>
          {additionalActions}
          <TableSettingsMenu
            density={density}
            onDensityChange={onDensityChange}
            columnsSlot={(
              <ColumnVisibilityDropdown
                visibleColumns={visibleColumns}
                setVisibleColumns={onVisibleColumnsChange}
                resetColumns={onResetColumns}
                defaultColumns={defaultColumns}
              />
            )}
          />
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            onClick={onExport}
            disabled={exportDisabled}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export CSV
          </Button>
        </>
      )}
    />
  );
}
