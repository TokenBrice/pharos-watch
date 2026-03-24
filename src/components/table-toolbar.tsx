"use client";

import { Download, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { DensityToggle } from "./density-toggle";
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
}

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
}: TableToolbarProps) {
  return (
    <div className="pharos-table-toolbar">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="pharos-kicker">Table Controls</p>
          <p className="pharos-meta">Tune density, hide noise, and export the current lens without leaving the table.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {additionalActions}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground">
                <Settings2 className="h-3.5 w-3.5" />
                Table settings
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[22rem] max-w-[calc(100vw-2rem)] space-y-4 p-4">
              <div className="space-y-2">
                <p className="pharos-kicker">Density</p>
                <DensityToggle value={density} onChange={onDensityChange} />
              </div>
              <div className="space-y-2">
                <p className="pharos-kicker">Columns</p>
                <ColumnVisibilityDropdown
                  visibleColumns={visibleColumns}
                  setVisibleColumns={onVisibleColumnsChange}
                  resetColumns={onResetColumns}
                  defaultColumns={defaultColumns}
                />
              </div>
            </PopoverContent>
          </Popover>
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
        </div>
      </div>
    </div>
  );
}
